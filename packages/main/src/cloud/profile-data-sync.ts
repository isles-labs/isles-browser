import {createHash, randomUUID} from 'crypto';
import axios from 'axios';
import {existsSync} from 'fs';
import {cp, mkdir, readdir, readFile, rm, stat, writeFile} from 'fs/promises';
import {join, relative, resolve, sep} from 'path';
import type {DB, SafeAny} from '../../../shared/types/db';
import {createLogger} from '../../../shared/utils/logger';
import {SERVICE_LOGGER_LABEL} from '../constants';
import {getSettings} from '../utils/get-settings';
import {withBrowserCdp} from './browser-cdp';
import {cloudApiClient} from './client';
import {getProfileSyncState, updateProfileSyncState} from './profile-sync-state';
import {
  acquireProfileLock,
  getHeldProfileLock,
  reacquireProfileLock,
  releaseProfileLock,
} from './profile-lock-service';
import {db} from '../db';
import {shouldPreserveOfflineProfileDraft, shouldRestoreCachedProfile} from './sync-safety';
import {
  collectChromiumHistory,
  restoreChromiumHistory,
  restorePendingChromiumHistory,
  type CloudHistoryVisit,
} from './profile-history';
import {getProfileScopeDirectory, shouldCopyLegacyProfileData} from './profile-scope';

export {getProfileScopeDirectory} from './profile-scope';

const logger = createLogger(SERVICE_LOGGER_LABEL);
const COOKIE_SYNC_INTERVAL_MS = 15000;
const MAX_PROFILE_FILE_BYTES = 20 * 1024 * 1024;
const BOOKMARKS_CLOUD_PATH = 'Default/Bookmarks';
const PREFERENCES_CLOUD_PATH = 'Default/Preferences';

type ProfileDataPayload = {
  success?: boolean;
  status?: 'accepted' | 'conflict';
  reason?: string;
  conflicts?: SafeAny[];
  revision?: number;
  files?: Record<string, string>;
  cookies?: SafeAny[];
  bookmarks?: SafeAny;
  preferences?: SafeAny;
};

type V2ProfileData = {
  files: Record<string, string>;
  bookmarks?: SafeAny;
  preferences?: SafeAny;
};

const cookieSyncTimers = new Map<number, NodeJS.Timeout>();
const latestCookieSnapshots = new Map<number, SafeAny[]>();
const cookieSyncInFlight = new Set<number>();
let retryingClosedProfileDrafts = false;

const isCloudNetworkFailure = (error: unknown) =>
  axios.isAxiosError(error) && shouldPreserveOfflineProfileDraft(error.response?.status);

const snapshotRoots = ['Local State', join('Default', 'Bookmarks'), join('Default', 'Preferences')];

const ignoredPathParts = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'ShaderCache',
  'GrShaderCache',
  'Crashpad',
  'Safe Browsing',
]);

const ignoredFileNames = new Set([
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'DevToolsActivePort',
  'Cookies',
  'Cookies-journal',
  'Network Persistent State',
]);

const getProfileEngineDirectory = (_windowData: DB.Window) => getSettings().useLocalChrome ? 'chrome' : 'chromium';

const getLegacyProfileDataDir = (windowData: DB.Window) =>
  join(
    getSettings().profileCachePath,
    getProfileEngineDirectory(windowData),
    windowData.profile_id || String(windowData.id),
  );

export const getProfileDataDir = (windowData: DB.Window) => {
  const settings = getSettings();
  const profileDirName = getProfileEngineDirectory(windowData);

  const scopeDirectory = getProfileScopeDirectory(windowData);
  return join(
    settings.profileCachePath,
    scopeDirectory,
    profileDirName,
    windowData.profile_id || String(windowData.id),
  );
};

/**
 * Keep existing local installations usable after introducing scoped Profile
 * roots. Cloud workspaces intentionally skip this fallback because an
 * unscoped directory cannot be attributed safely to the selected workspace.
 * The legacy directory is never removed, so rollback remains recoverable.
 */
export const ensureScopedProfileDataDir = async (windowData: DB.Window) => {
  const target = getProfileDataDir(windowData);
  const legacy = getLegacyProfileDataDir(windowData);
  // A legacy unscoped directory cannot be attributed safely to a cloud
  // workspace. Cloud mode must restore only the selected workspace snapshot;
  // copying the legacy directory here would silently migrate local state.
  if (!shouldCopyLegacyProfileData(windowData)) return target;
  if (target === legacy || existsSync(target) || !existsSync(legacy)) return target;
  await mkdir(resolve(target, '..'), {recursive: true});
  try {
    await cp(legacy, target, {recursive: true, errorOnExist: true});
    logger.info('Copied legacy Profile into its isolated scope', {
      windowId: windowData.id,
      scope: getProfileScopeDirectory(windowData),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  }
  return target;
};

export const downloadCloudProfileData = async (
  windowData: DB.Window,
  profileDir = getProfileDataDir(windowData),
  {forceRestore = false}: {forceRestore?: boolean} = {},
) => {
  if (!windowData.cloud_id || !(await cloudApiClient.isEnabled())) {
    return undefined;
  }

  const config = await cloudApiClient.getConfig();
  const result = await cloudApiClient.request<ProfileDataPayload>(
    'get',
    `/profiles/${windowData.cloud_id}/data`,
  );
  if (!result?.success) {
    return undefined;
  }

  const state = await getProfileSyncState(windowData.id!);
  const remoteRevision = String(result.revision || 0);
  const localRevision = String(state?.cloud_revision || 0);
  if ((state?.profile_dirty || state?.offline_dirty) && !forceRestore) {
    await updateProfileSyncState(windowData.id!, {
      cloud_id: windowData.cloud_id,
      conflict_status: 'remote_profile_changed_while_local_dirty',
      last_error:
        'Remote profile was validated but not restored because local changes are pending.',
    });
    return result;
  }

  if (
    forceRestore ||
    shouldRestoreCachedProfile({
      cacheExists: hasUsableCachedProfile(profileDir),
      localDirty: Boolean(state?.profile_dirty || state?.offline_dirty),
      localRevision,
      remoteRevision,
    })
  ) {
    await restoreProfileFiles(profileDir, result.files || {});
    await restoreProfileSemanticData(profileDir, result);
    await removeFilesMissingFromSnapshot(profileDir, result.files || {}, result);
  }
  if (config.protocolVersion === 2 && config.workspaceId) {
    await pullCloudProfileHistory(
      windowData,
      profileDir,
      config.workspaceId,
      state?.history_cursor,
    );
  }
  const downloadedBytes =
    encodedFilesByteLength(result.files || {}) + semanticProfileByteLength(result);
  await updateProfileSyncState(windowData.id!, {
    cloud_id: windowData.cloud_id,
    cloud_revision: remoteRevision,
    downloaded_bytes: downloadedBytes,
    last_file_count: profileFileCount(result),
    last_cookie_count: result.cookies?.length || 0,
    last_error: null,
    last_synced_at: dbTimestamp(),
  });
  logger.info('Cloud profile data downloaded', {
    localWindowId: windowData.id,
    cloudId: windowData.cloud_id,
    fileCount: Object.keys(result.files || {}).length,
    cookieCount: result.cookies?.length || 0,
    revision: result.revision,
  });

  return result;
};

export const uploadCloudProfileData = async (
  windowData: DB.Window,
  profileDir = getProfileDataDir(windowData),
) => {
  if (!windowData.cloud_id || !(await cloudApiClient.isEnabled()) || !existsSync(profileDir)) {
    return;
  }

  const config = await cloudApiClient.getConfig();
  const state = await getProfileSyncState(windowData.id!);
  const rawFiles = await collectProfileFiles(profileDir);
  const profileData =
    config.protocolVersion === 2 && config.workspaceId
      ? buildV2ProfileData(rawFiles)
      : {files: rawFiles};
  const cookies =
    latestCookieSnapshots.get(windowData.id!) ||
    readPendingCookieSnapshot(state?.pending_cookie_snapshot) ||
    [];
  const manifestHash = stableHash(profileData);
  const lock = getHeldProfileLock(windowData.id!);
  if (!lock?.lockId) {
    await updateProfileSyncState(windowData.id!, {
      conflict_status: 'profile_lock_required',
      last_error: 'Profile upload skipped because this device does not hold the cloud lock.',
    });
    return {skipped: true, reason: 'profile_lock_required'};
  }
  const profileLock = {lockId: lock.lockId, fencingToken: lock.fencingToken};
  if (state?.local_manifest_hash === manifestHash && !state.profile_dirty && !state.offline_dirty) {
    if (config.protocolVersion === 2 && config.workspaceId) {
      await uploadAndPullCloudHistory(
        windowData,
        profileDir,
        config.workspaceId,
        profileLock,
        state,
      );
    }
    return {skipped: true, reason: 'profile_unchanged'};
  }
  let response: ProfileDataPayload;
  let canonicalProfileData = profileData;
  let canonicalCookies = cookies;
  try {
    const mutationId =
      state?.pending_mutation_id && (state.pending_mutation_scope || 'profile') === 'profile'
        ? state.pending_mutation_id
        : randomUUID();
    if (config.protocolVersion === 2 && config.workspaceId) {
      await updateProfileSyncState(windowData.id!, {
        pending_mutation_id: mutationId,
        pending_mutation_scope: 'profile',
      });
      const fileManifest = await uploadProfileBlobs(
        config.workspaceId,
        windowData.cloud_id,
        profileData.files,
      );
      response =
        (await cloudApiClient.request<ProfileDataPayload>(
          'post',
          `/teams/${encodeURIComponent(config.workspaceId)}/profiles/${windowData.cloud_id}/reconcile`,
          {
            mutation_id: mutationId,
            base_revision: Number(state?.cloud_revision || 0),
            file_manifest: fileManifest,
            cookies,
            bookmarks: profileData.bookmarks,
            preferences: profileData.preferences,
            lock_id: profileLock.lockId,
            fencing_token: profileLock.fencingToken,
            metadata: {
              profile_id: windowData.profile_id,
              browser_engine: windowData.browser_engine,
            },
          },
        )) || {};
      if (response.status === 'conflict') {
        await updateProfileSyncState(windowData.id!, {
          conflict_status: response.reason || 'profile_merge_conflict',
          profile_dirty: true,
          last_error: `Profile merge conflict: ${response.conflicts?.length || 0} item(s) require resolution.`,
        });
        return {success: false, conflict: true, reason: response.reason};
      }
    } else {
      response =
        (await cloudApiClient.request<ProfileDataPayload>(
          'post',
          `/profiles/${windowData.cloud_id}/data`,
          {
            profile_id: windowData.profile_id,
            browser_engine: windowData.browser_engine,
            files: profileData.files,
            cookies,
            lock_id: profileLock.lockId,
            fencing_token: profileLock.fencingToken,
            expected_revision: Number(state?.cloud_revision || 0),
          },
        )) || {};
    }
  } catch (error) {
    const status = (error as {response?: {status?: number}})?.response?.status;
    if (isCloudNetworkFailure(error)) {
      await updateProfileSyncState(windowData.id!, {
        cloud_id: windowData.cloud_id,
        profile_dirty: true,
        offline_dirty: true,
        conflict_status: 'pending_network_reconcile',
        last_error: (error as Error).message,
      });
    } else if (status === 409) {
      await updateProfileSyncState(windowData.id!, {
        conflict_status: 'profile_revision_conflict',
        profile_dirty: true,
        last_error: 'Remote profile revision changed. Local changes were preserved for review.',
      });
    }
    throw error;
  }

  // A V2 reconcile can merge this device's draft with a newer remote file or
  // cookie. This runs after the browser process has closed, so applying the
  // canonical result is safe and prevents a stale local file from being sent
  // back as a new change on the next close.
  if (config.protocolVersion === 2 && config.workspaceId) {
    try {
      const canonical = await downloadCloudProfileData(windowData, profileDir, {
        forceRestore: true,
      });
      if (!canonical?.success) throw new Error('Canonical profile refresh was not accepted');
      canonicalProfileData = buildV2ProfileData(await collectProfileFiles(profileDir));
      canonicalCookies = canonical.cookies || [];
      latestCookieSnapshots.set(windowData.id!, canonicalCookies);
      await uploadAndPullCloudHistory(
        windowData,
        profileDir,
        config.workspaceId,
        profileLock,
        state,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateProfileSyncState(
        windowData.id!,
        isCloudNetworkFailure(error)
          ? {
              cloud_id: windowData.cloud_id,
              profile_dirty: true,
              offline_dirty: true,
              conflict_status: 'pending_network_reconcile',
              last_error: message,
            }
          : {
              cloud_id: windowData.cloud_id,
              profile_dirty: true,
              conflict_status: 'profile_canonical_refresh_required',
              last_error: `Profile reconcile succeeded but canonical refresh failed: ${message}`,
            },
      );
      return {success: false, refreshRequired: true};
    }
  }

  const canonicalManifestHash = stableHash(canonicalProfileData);
  await updateProfileSyncState(windowData.id!, {
    cloud_id: windowData.cloud_id,
    cloud_revision: response.revision ? String(response.revision) : state?.cloud_revision,
    local_manifest_hash: canonicalManifestHash,
    profile_dirty: false,
    offline_dirty: false,
    conflict_status: null,
    pending_mutation_id: null,
    pending_mutation_scope: null,
    pending_cookie_snapshot: null,
    uploaded_bytes:
      encodedFilesByteLength(canonicalProfileData.files) +
      semanticProfileByteLength(canonicalProfileData),
    last_file_count: profileFileCount(canonicalProfileData),
    last_cookie_count: canonicalCookies.length,
    last_error: null,
    last_synced_at: dbTimestamp(),
  });

  logger.info('Cloud profile data uploaded', {
    localWindowId: windowData.id,
    cloudId: windowData.cloud_id,
    fileCount: profileFileCount(profileData),
    cookieCount: cookies.length,
  });
};

export const startCloudCookieSync = (windowData: DB.Window, port: number) => {
  stopCloudCookieSync(windowData.id!);

  const captureAndUpload = async () => {
    if (cookieSyncInFlight.has(windowData.id!)) return;
    cookieSyncInFlight.add(windowData.id!);
    try {
      const cookies = await exportCookiesFromBrowser(port);
      latestCookieSnapshots.set(windowData.id!, cookies);
      const cookieHash = stableHash(cookies);
      const state = await getProfileSyncState(windowData.id!);
      if (state?.cookie_hash === cookieHash) return;
      if (windowData.cloud_id && (await cloudApiClient.isEnabled())) {
        await updateProfileSyncState(windowData.id!, {
          pending_cookie_snapshot: JSON.stringify(cookies),
        });
        const lock = getHeldProfileLock(windowData.id!);
        const state = await getProfileSyncState(windowData.id!);
        if (!lock?.lockId) {
          await updateProfileSyncState(windowData.id!, {
            conflict_status: 'profile_lock_required',
            last_error: 'Cookie upload skipped because this device does not hold the cloud lock.',
          });
          return;
        }
        const config = await cloudApiClient.getConfig();
        // Cookie changes are reconciled independently. A legacy/profile mutation
        // must not be reused here: the server correctly idempotently returns its
        // previous conflict, which would otherwise keep this timer stuck forever.
        const mutationId =
          state?.pending_mutation_id && state.pending_mutation_scope === 'cookies'
            ? state.pending_mutation_id
            : randomUUID();
        if (config.protocolVersion === 2 && config.workspaceId) {
          await updateProfileSyncState(windowData.id!, {
            pending_mutation_id: mutationId,
            pending_mutation_scope: 'cookies',
          });
        }
        const response =
          config.protocolVersion === 2 && config.workspaceId
            ? await cloudApiClient.request<ProfileDataPayload>(
                'post',
                `/teams/${encodeURIComponent(config.workspaceId)}/profiles/${windowData.cloud_id}/reconcile`,
                {
                  mutation_id: mutationId,
                  base_revision: Number(state?.cloud_revision || 0),
                  content_scope: 'cookies',
                  cookies,
                  lock_id: lock.lockId,
                  fencing_token: lock.fencingToken,
                },
              )
            : await cloudApiClient.request<ProfileDataPayload>(
                'post',
                `/profiles/${windowData.cloud_id}/data`,
                {
                  profile_id: windowData.profile_id,
                  cookies,
                  lock_id: lock.lockId,
                  fencing_token: lock.fencingToken,
                  expected_revision: Number(state?.cloud_revision || 0),
                },
              );
        if (response?.status === 'conflict') {
          await updateProfileSyncState(windowData.id!, {
            conflict_status: response.reason || 'profile_merge_conflict',
            profile_dirty: true,
            last_error: `Profile merge conflict: ${response.conflicts?.length || 0} item(s) require resolution.`,
          });
          return;
        }
        let syncedCookies = cookies;
        let syncedRevision = response?.revision;
        if (config.protocolVersion === 2 && config.workspaceId) {
          // Do not restore Profile files while Chromium is running. Cookie APIs
          // are safe at runtime, and applying only keys that did not change
          // during this request avoids overwriting a just-created local draft.
          const canonical = await cloudApiClient.request<ProfileDataPayload>(
            'get',
            `/teams/${encodeURIComponent(config.workspaceId)}/profiles/${windowData.cloud_id}/cookies`,
          );
          if (!canonical?.success) throw new Error('Canonical cookie refresh was not accepted');
          const currentCookies = await exportCookiesFromBrowser(port);
          const submittedByKey = new Map(
            cookies.map(cookie => [cookieIdentity(cookie), stableHash(cookie)]),
          );
          const currentByKey = new Map(
            currentCookies.map(cookie => [cookieIdentity(cookie), stableHash(cookie)]),
          );
          const importableCookies = (canonical.cookies || []).filter(
            cookie =>
              currentByKey.get(cookieIdentity(cookie)) ===
              submittedByKey.get(cookieIdentity(cookie)),
          );
          await importCloudCookies(port, importableCookies);
          syncedCookies = await exportCookiesFromBrowser(port);
          latestCookieSnapshots.set(windowData.id!, syncedCookies);
          syncedRevision = canonical.revision || syncedRevision;
        }
        await updateProfileSyncState(windowData.id!, {
          cloud_id: windowData.cloud_id,
          cookie_hash: stableHash(syncedCookies),
          cloud_revision: syncedRevision ? String(syncedRevision) : state?.cloud_revision,
          pending_mutation_id: null,
          pending_mutation_scope: null,
          pending_cookie_snapshot: null,
          last_cookie_count: syncedCookies.length,
          uploaded_bytes: Buffer.byteLength(JSON.stringify(syncedCookies)),
          last_error: null,
          last_synced_at: dbTimestamp(),
        });
      }
    } catch (error) {
      const response = (error as {response?: {status?: number; data?: {reason?: string}}})
        ?.response;
      const status = response?.status;
      const lockRecoveryRequired =
        status === 409 &&
        ['profile_lock_required', 'profile_lock_lost'].includes(
          String(response?.data?.reason || ''),
        );
      if (lockRecoveryRequired) {
        const recoveredLock = await reacquireProfileLock(windowData);
        if (recoveredLock.success) {
          await updateProfileSyncState(windowData.id!, {
            cloud_id: windowData.cloud_id,
            conflict_status: 'pending_network_reconcile',
            last_error:
              'Cloud connection restored. Profile lock was renewed and the pending Cookie sync is retrying.',
          });
          setTimeout(() => {
            void captureAndUpload();
          }, 0);
          return;
        }
      }
      await updateProfileSyncState(
        windowData.id!,
        isCloudNetworkFailure(error)
          ? {
              cloud_id: windowData.cloud_id,
              profile_dirty: true,
              offline_dirty: true,
              conflict_status: 'pending_network_reconcile',
              last_error: (error as Error).message,
            }
          : {
              conflict_status: status === 409 ? 'profile_revision_conflict' : undefined,
              profile_dirty: status === 409 ? true : undefined,
              last_error: (error as Error).message,
            },
      );
      logger.warn('Cloud cookie sync failed', {
        localWindowId: windowData.id,
        cloudId: windowData.cloud_id,
        message: (error as Error).message,
      });
    } finally {
      cookieSyncInFlight.delete(windowData.id!);
    }
  };

  captureAndUpload();
  cookieSyncTimers.set(windowData.id!, setInterval(captureAndUpload, COOKIE_SYNC_INTERVAL_MS));
};

export const stopCloudCookieSync = (localWindowId: number) => {
  const timer = cookieSyncTimers.get(localWindowId);
  if (timer) {
    clearInterval(timer);
    cookieSyncTimers.delete(localWindowId);
  }
};

export const captureCloudCookiesOnce = async (windowData: DB.Window, port?: number | null) => {
  if (!port) return;
  try {
    const cookies = await exportCookiesFromBrowser(port);
    latestCookieSnapshots.set(windowData.id!, cookies);
    await updateProfileSyncState(windowData.id!, {
      pending_cookie_snapshot: JSON.stringify(cookies),
    });
  } catch (error) {
    logger.warn('Cloud cookie capture failed', {
      localWindowId: windowData.id,
      cloudId: windowData.cloud_id,
      message: (error as Error).message,
    });
  }
};

// A closed Profile has no CDP connection, but its last captured Cookie jar and
// local Profile files are durable. Retry those drafts after normal metadata
// sync confirms the cloud is reachable; never touch a running window.
export const retryClosedCloudProfileDrafts = async () => {
  if (retryingClosedProfileDrafts) return;
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || config.protocolVersion !== 2 || !config.workspaceId) return;

  retryingClosedProfileDrafts = true;
  try {
    const windows = await db<DB.Window>('window as window')
      .join('profile_sync_state as profile', 'profile.window_id', 'window.id')
      .where('window.workspace_id', config.workspaceId)
      .where('window.status', 1)
      .where(builder =>
        builder.where('profile.profile_dirty', 1).orWhere('profile.offline_dirty', 1),
      )
      .whereNull('window.sync_deleted_at')
      .select('window.*')
      .orderBy('profile.updated_at', 'asc')
      .limit(10);

    for (const windowData of windows) {
      const lock = await acquireProfileLock(windowData);
      if (!lock.success) continue;
      try {
        await uploadCloudProfileData(windowData);
      } catch (error) {
        logger.warn('Closed profile draft retry failed', {
          localWindowId: windowData.id,
          cloudId: windowData.cloud_id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await releaseProfileLock(windowData.id!);
      }
    }
  } finally {
    retryingClosedProfileDrafts = false;
  }
};

export const resolveCloudProfileConflict = async (
  windowId: number,
  resolution: 'keep_cloud' | 'keep_local',
) => {
  if (!['keep_cloud', 'keep_local'].includes(resolution)) {
    return {success: false, message: 'Unknown Profile conflict resolution'};
  }
  const config = await cloudApiClient.getConfig();
  if (!config.enabled || config.protocolVersion !== 2 || !config.workspaceId) {
    return {success: false, message: 'Cloud Sync V2 is not enabled'};
  }
  const windowData = await db<DB.Window>('window')
    .where({id: windowId, workspace_id: config.workspaceId})
    .whereNull('sync_deleted_at')
    .first();
  if (!windowData?.cloud_id)
    return {success: false, message: 'Profile window was not found in this workspace'};
  if (Number(windowData.status) > 1) {
    return {
      success: false,
      message: 'Close this Profile window before resolving its cloud conflict',
    };
  }

  if (resolution === 'keep_cloud') {
    try {
      const backupPath = await backupLocalProfileBeforeCloudReplace(windowData);
      const canonical = await downloadCloudProfileData(windowData, getProfileDataDir(windowData), {
        forceRestore: true,
      });
      if (!canonical?.success)
        return {success: false, message: 'Cloud Profile data could not be restored'};
      await updateProfileSyncState(windowId, {
        cloud_id: windowData.cloud_id,
        profile_dirty: false,
        offline_dirty: false,
        conflict_status: null,
        pending_mutation_id: null,
        pending_mutation_scope: null,
        pending_cookie_snapshot: null,
        last_error: null,
      });
      return {success: true, resolution, backupPath};
    } catch (error) {
      return {success: false, message: error instanceof Error ? error.message : String(error)};
    }
  }

  const lock = await acquireProfileLock(windowData);
  if (!lock.success)
    return {success: false, message: lock.message || 'Could not acquire the current Profile lock'};
  try {
    const canonical = await cloudApiClient.request<ProfileDataPayload>(
      'get',
      `/profiles/${windowData.cloud_id}/data`,
    );
    if (!canonical?.success)
      return {success: false, message: 'Cloud Profile revision could not be loaded'};
    // A new mutation at the current revision is the explicit user choice to
    // replace the canonical Profile with the locally preserved draft.
    await updateProfileSyncState(windowId, {
      cloud_id: windowData.cloud_id,
      cloud_revision: String(canonical.revision || 0),
      profile_dirty: true,
      offline_dirty: false,
      conflict_status: 'profile_conflict_replaying',
      pending_mutation_id: null,
      pending_mutation_scope: null,
      last_error: null,
    });
    const result = await uploadCloudProfileData(windowData);
    if (result?.conflict || result?.refreshRequired || result?.skipped) {
      return {
        success: false,
        message: result.reason || 'Local Profile could not replace the current cloud version',
      };
    }
    return {success: true, resolution};
  } catch (error) {
    return {success: false, message: error instanceof Error ? error.message : String(error)};
  } finally {
    await releaseProfileLock(windowId);
  }
};

const backupLocalProfileBeforeCloudReplace = async (windowData: DB.Window) => {
  const profileDir = getProfileDataDir(windowData);
  if (!existsSync(profileDir)) return undefined;
  const backupRoot = join(getSettings().profileCachePath, 'profile-conflict-backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const profileKey = windowData.profile_id || String(windowData.id);
  const backupPath = join(backupRoot, `${stamp}-${profileKey}`);
  await mkdir(backupRoot, {recursive: true});
  await cp(profileDir, backupPath, {recursive: true, errorOnExist: true});
  return backupPath;
};

export const importCloudCookies = async (port: number, cookies?: SafeAny[]) => {
  if (!cookies?.length) return;

  const normalized = cookies.map(normalizeCookieForImport).filter(Boolean);
  if (!normalized.length) return;

  await withBrowserCdp(port, async client => {
    await client.send('Storage.setCookies', {cookies: normalized});
  });
  logger.info('Cloud cookies imported', {port, cookieCount: normalized.length});
};

// Storage.getCookies/setCookies are browser-scoped: they are answered by the root
// CDP session and never attach to a page target. Anything that attaches to a tab
// (puppeteer's browser.pages(), Network.getAllCookies via a page session) enables
// the Runtime domain on it, which anti-bot scripts detect. See browser-cdp.ts.
const exportCookiesFromBrowser = async (port: number) =>
  withBrowserCdp(port, async client => {
    const result = await client.send<{cookies?: SafeAny[]}>('Storage.getCookies');
    return (result.cookies || []) as SafeAny[];
  });

const normalizeCookieForImport = (cookie: SafeAny) => {
  if (!cookie?.name || typeof cookie.value !== 'string') {
    return undefined;
  }

  const normalized: SafeAny = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
  };

  if (typeof cookie.expires === 'number' && cookie.expires > 0) {
    normalized.expires = cookie.expires;
  }
  if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
    normalized.sameSite = cookie.sameSite;
  }
  if (cookie.priority) {
    normalized.priority = cookie.priority;
  }
  if (cookie.sourceScheme) {
    normalized.sourceScheme = cookie.sourceScheme;
  }

  return normalized;
};

const collectProfileFiles = async (profileDir: string) => {
  const files: Record<string, string> = {};

  for (const root of snapshotRoots) {
    const absolutePath = join(profileDir, root);
    if (!existsSync(absolutePath)) continue;
    await collectPath(profileDir, absolutePath, files);
  }

  return files;
};

const parseEncodedJson = (encoded?: string) => {
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as SafeAny;
  } catch {
    return undefined;
  }
};

const buildV2ProfileData = (rawFiles: Record<string, string>): V2ProfileData => {
  const files = {...rawFiles};
  const bookmarks = parseEncodedJson(files[BOOKMARKS_CLOUD_PATH]);
  const preferences = parseEncodedJson(files[PREFERENCES_CLOUD_PATH]);
  delete files[BOOKMARKS_CLOUD_PATH];
  delete files[PREFERENCES_CLOUD_PATH];
  // This file changes for session bookkeeping on every browser run. Sending it
  // as an opaque blob turns unrelated Bookmark/Preference edits into conflicts.
  delete files['Local State'];
  return {
    files,
    ...(bookmarks === undefined ? {} : {bookmarks}),
    ...(preferences === undefined ? {} : {preferences}),
  };
};

const semanticProfileByteLength = (
  profile: Pick<ProfileDataPayload, 'bookmarks' | 'preferences'>,
) =>
  Buffer.byteLength(
    JSON.stringify({bookmarks: profile.bookmarks, preferences: profile.preferences}),
  );

const profileFileCount = (
  profile: Pick<ProfileDataPayload, 'files' | 'bookmarks' | 'preferences'>,
) =>
  Object.keys(profile.files || {}).length +
  Number(profile.bookmarks !== undefined) +
  Number(profile.preferences !== undefined);

const stableHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const cookieIdentity = (cookie: SafeAny) =>
  `${cookie?.domain || ''}\u0000${cookie?.path || '/'}\u0000${cookie?.name || ''}`;

const readPendingCookieSnapshot = (serialized?: string | null): SafeAny[] | undefined => {
  if (!serialized) return undefined;
  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const encodedFilesByteLength = (files: Record<string, string>) =>
  Object.values(files).reduce((total, value) => total + Buffer.byteLength(value, 'base64'), 0);

const uploadProfileBlobs = async (
  workspaceId: string,
  cloudId: string,
  files: Record<string, string>,
) => {
  const manifest = Object.fromEntries(
    Object.entries(files).map(([relativePath, encoded]) => {
      const bytes = Buffer.from(encoded, 'base64');
      return [
        relativePath,
        {sha256: createHash('sha256').update(bytes).digest('hex'), byte_size: bytes.length},
      ];
    }),
  );
  const response = await cloudApiClient.request<{
    success?: boolean;
    chunk_bytes?: number;
    missing?: string[];
  }>('post', `/teams/${encodeURIComponent(workspaceId)}/profiles/${cloudId}/blob-manifest`, {
    manifest,
  });
  if (!response?.success) throw new Error('Profile blob manifest was not accepted');
  const missing = new Set(response.missing || []);
  const chunkBytes = Math.min(
    4 * 1024 * 1024,
    Math.max(1, Number(response.chunk_bytes || 4 * 1024 * 1024)),
  );
  for (const encoded of Object.values(files)) {
    const bytes = Buffer.from(encoded, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!missing.has(sha256)) continue;
    for (let offset = 0; offset < Math.max(bytes.length, 1); offset += chunkBytes) {
      const result = await cloudApiClient.uploadBinary(
        `/teams/${encodeURIComponent(workspaceId)}/profiles/${cloudId}/blobs/${sha256}`,
        bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes)),
        {'X-Blob-Size': String(bytes.length), 'X-Upload-Offset': String(offset)},
      );
      if (!result?.success) throw new Error('Profile blob chunk was not accepted');
    }
  }
  return manifest;
};

type ProfileHistoryPage = {
  success?: boolean;
  visits?: CloudHistoryVisit[];
  next_cursor?: number;
  has_more?: boolean;
};

const pullCloudProfileHistory = async (
  windowData: DB.Window,
  profileDir: string,
  workspaceId: string,
  initialCursor?: string | null,
) => {
  if (!windowData.cloud_id) return;
  let cursor = Number(initialCursor || 0);
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
    const page = await cloudApiClient.request<ProfileHistoryPage>(
      'get',
      `/teams/${encodeURIComponent(workspaceId)}/profiles/${windowData.cloud_id}/history?after_cursor=${encodeURIComponent(String(cursor))}&limit=500`,
    );
    if (!page?.success) return;
    const visits = page.visits || [];
    if (visits.length) await restoreChromiumHistory(profileDir, visits);
    const nextCursor = Number(page.next_cursor || cursor);
    if (nextCursor > cursor) {
      cursor = nextCursor;
      await updateProfileSyncState(windowData.id!, {history_cursor: String(cursor)});
    }
    if (!page.has_more || !visits.length) return;
  }
  throw new Error('Cloud history pull reached its pagination safety limit');
};

const uploadAndPullCloudHistory = async (
  windowData: DB.Window,
  profileDir: string,
  workspaceId: string,
  lock: {lockId: string; fencingToken?: number},
  state?: Awaited<ReturnType<typeof getProfileSyncState>>,
) => {
  if (!windowData.cloud_id) return;
  await restorePendingChromiumHistory(profileDir);
  const history = await collectChromiumHistory(profileDir, state?.history_uploaded_visit_time);
  for (let offset = 0; offset < history.visits.length; offset += 500) {
    const response = await cloudApiClient.request<{success?: boolean}>(
      'post',
      `/teams/${encodeURIComponent(workspaceId)}/profiles/${windowData.cloud_id}/history`,
      {
        visits: history.visits.slice(offset, offset + 500),
        lock_id: lock.lockId,
        fencing_token: lock.fencingToken,
      },
    );
    if (!response?.success) throw new Error('Cloud history upload was not accepted');
  }
  if (history.maxVisitTime && history.maxVisitTime !== state?.history_uploaded_visit_time) {
    await updateProfileSyncState(windowData.id!, {
      history_uploaded_visit_time: history.maxVisitTime,
    });
  }
  const currentState = await getProfileSyncState(windowData.id!);
  await pullCloudProfileHistory(windowData, profileDir, workspaceId, currentState?.history_cursor);
};

const hasUsableCachedProfile = (profileDir: string) =>
  existsSync(join(profileDir, 'Local State')) ||
  existsSync(join(profileDir, 'Default', 'Preferences'));

// SQLite accepts an ISO timestamp through knex, while keeping this module
// independent from a particular SQL dialect's now() expression.
const dbTimestamp = () => new Date().toISOString();

const collectPath = async (
  profileDir: string,
  absolutePath: string,
  files: Record<string, string>,
) => {
  const pathStat = await stat(absolutePath);
  const relativePath = normalizeRelativePath(relative(profileDir, absolutePath));
  if (!relativePath || shouldIgnoreRelativePath(relativePath)) return;

  if (pathStat.isDirectory()) {
    const entries = await readdir(absolutePath);
    for (const entry of entries) {
      await collectPath(profileDir, join(absolutePath, entry), files);
    }
    return;
  }

  if (!pathStat.isFile() || pathStat.size > MAX_PROFILE_FILE_BYTES) {
    return;
  }

  const buffer = await readFile(absolutePath);
  files[relativePath] = buffer.toString('base64');
};

const restoreProfileFiles = async (profileDir: string, files: Record<string, string>) => {
  await mkdir(profileDir, {recursive: true});

  for (const [relativePath, content] of Object.entries(files)) {
    const safeRelativePath = normalizeRelativePath(relativePath);
    if (!safeRelativePath || shouldIgnoreRelativePath(safeRelativePath)) continue;

    const targetPath = resolve(profileDir, safeRelativePath);
    if (!isPathInside(profileDir, targetPath)) continue;

    await mkdir(join(targetPath, '..'), {recursive: true});
    await writeFile(targetPath, Buffer.from(content, 'base64'));
  }
};

const restoreProfileSemanticData = async (profileDir: string, profile: ProfileDataPayload) => {
  const entries: Array<[string, SafeAny]> = [
    [BOOKMARKS_CLOUD_PATH, profile.bookmarks],
    [PREFERENCES_CLOUD_PATH, profile.preferences],
  ];
  for (const [relativePath, value] of entries) {
    if (value === undefined) continue;
    const targetPath = resolve(profileDir, relativePath);
    if (!isPathInside(profileDir, targetPath)) continue;
    await mkdir(join(targetPath, '..'), {recursive: true});
    await writeFile(targetPath, JSON.stringify(value), 'utf8');
  }
};

const removeFilesMissingFromSnapshot = async (
  profileDir: string,
  files: Record<string, string>,
  profile?: ProfileDataPayload,
) => {
  const expected = new Set(
    Object.keys(files)
      .map(normalizeRelativePath)
      .filter(relativePath => relativePath && !shouldIgnoreRelativePath(relativePath)),
  );
  if (profile?.bookmarks !== undefined) expected.add(BOOKMARKS_CLOUD_PATH);
  if (profile?.preferences !== undefined) expected.add(PREFERENCES_CLOUD_PATH);
  for (const root of snapshotRoots) {
    if (root === 'Local State') continue;
    const absolutePath = join(profileDir, root);
    if (!existsSync(absolutePath)) continue;
    await removeMissingSnapshotPath(profileDir, absolutePath, expected);
  }
};

const removeMissingSnapshotPath = async (
  profileDir: string,
  absolutePath: string,
  expected: Set<string>,
): Promise<void> => {
  const pathStat = await stat(absolutePath);
  if (pathStat.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      await removeMissingSnapshotPath(profileDir, join(absolutePath, entry), expected);
    }
    return;
  }
  const relativePath = normalizeRelativePath(relative(profileDir, absolutePath));
  if (relativePath && !shouldIgnoreRelativePath(relativePath) && !expected.has(relativePath)) {
    await rm(absolutePath, {force: true});
  }
};

// Cloud manifests use POSIX separators on every platform. Local filesystem APIs
// accept these paths on Windows as well, while using platform separators here
// would split a single Profile file into different cross-device keys.
const normalizeRelativePath = (pathValue: string) =>
  pathValue
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');

const shouldIgnoreRelativePath = (relativePath: string) => {
  const parts = relativePath.split(/[\\/]+/);
  return (
    parts.some(part => ignoredPathParts.has(part)) || ignoredFileNames.has(parts[parts.length - 1])
  );
};

const isPathInside = (root: string, target: string) => {
  const relativePath = relative(resolve(root), resolve(target));
  return Boolean(relativePath) && !relativePath.startsWith('..') && !relativePath.startsWith(sep);
};
