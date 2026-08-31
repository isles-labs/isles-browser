import {cp, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {DB} from '../../../shared/types/db';

const SENSITIVE_KEY =
  /(?:secret|token|password|mnemonic|private[_-]?key|credential|cookie|seed|extension|history)/i;
const BOOKMARKS = join('Default', 'Bookmarks');
const PREFERENCES = join('Default', 'Preferences');

export type PortableProfile = {
  profile_cloud_id: string;
  revision: number;
  payload: {bookmarks?: Record<string, unknown>; preferences?: Record<string, unknown>};
  metadata: {local_window_id: number; name?: string; profile_id?: string};
};

export type PortableProfiles = {version: 1; profiles: PortableProfile[]};

type ProfileWindow = Pick<DB.Window, 'id' | 'cloud_id' | 'profile_id' | 'name' | 'status'>;

function assertNoSensitiveFields(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertNoSensitiveFields);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`本地 Profile 迁移数据包含敏感字段: ${key}`);
    assertNoSensitiveFields(child);
  }
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`本地 Profile ${field} 必须是 JSON 对象`);
  return stripSensitiveFields(value) as Record<string, unknown>;
}

function stripSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, child]) => [key, stripSensitiveFields(child)]),
  );
}

function profileCloudId(window: ProfileWindow) {
  const id = String(window.cloud_id || window.profile_id || window.id || '').trim();
  if (!id) throw new Error('本地 Profile 缺少稳定标识');
  return window.cloud_id || `local-profile-${id}`;
}

/**
 * Narrow migration serializer. It never enumerates a profile directory and
 * therefore cannot accidentally include Local State, cookies, extensions,
 * history, caches, or arbitrary Chromium files. Device-private keys nested in
 * Chromium Preferences are removed rather than making safe preferences unusable.
 */
export async function buildPortableProfiles({
  windows,
  profileDir,
  exists = existsSync,
  readJson = async (filePath: string) => JSON.parse(await readFile(filePath, 'utf8')) as unknown,
}: {
  windows: ProfileWindow[];
  profileDir: (window: ProfileWindow) => string;
  exists?: (filePath: string) => boolean;
  readJson?: (filePath: string) => Promise<unknown>;
}): Promise<PortableProfiles> {
  const profiles: PortableProfile[] = [];
  const ids = new Set<string>();
  for (const window of windows) {
    if (!window.id || Number(window.status || 0) > 1) continue;
    const cloudId = profileCloudId(window);
    if (ids.has(cloudId)) throw new Error('本地 Profile 迁移标识重复');
    ids.add(cloudId);
    const root = profileDir(window);
    const payload: PortableProfile['payload'] = {};
    const bookmarks = join(root, BOOKMARKS);
    const preferences = join(root, PREFERENCES);
    if (exists(bookmarks)) payload.bookmarks = asObject(await readJson(bookmarks), 'Bookmarks');
    if (exists(preferences))
      payload.preferences = asObject(await readJson(preferences), 'Preferences');
    if (!Object.keys(payload).length) continue;
    profiles.push({
      profile_cloud_id: cloudId,
      revision: 1,
      payload,
      metadata: {
        local_window_id: window.id,
        ...(window.name ? {name: window.name} : {}),
        ...(window.profile_id ? {profile_id: window.profile_id} : {}),
      },
    });
  }
  return {version: 1, profiles};
}

export function serializePortableProfiles(input: PortableProfiles) {
  return Buffer.from(JSON.stringify(input), 'utf8');
}

/** Restores only the two portable semantic files and leaves every other local Profile file untouched. */
export async function restorePortableProfile({
  profileDir,
  payload,
  backupRoot,
  now = new Date(),
}: {
  profileDir: string;
  payload: PortableProfile['payload'];
  backupRoot: string;
  now?: Date;
}) {
  assertNoSensitiveFields(payload);
  const entries: Array<[string, Record<string, unknown> | undefined]> = [
    [BOOKMARKS, payload.bookmarks],
    [PREFERENCES, payload.preferences],
  ];
  const existing = entries.filter(([relativePath]) => existsSync(join(profileDir, relativePath)));
  const existingPaths = existing.map(([relativePath]) => relativePath);
  const writtenPaths = entries
    .filter(([, value]) => value !== undefined)
    .map(([relativePath]) => relativePath);
  const backupPath = existing.length
    ? join(backupRoot, `${now.toISOString().replace(/[:.]/g, '-')}-profile-semantic`)
    : undefined;
  if (backupPath) {
    await mkdir(backupPath, {recursive: true});
    for (const [relativePath] of existing) {
      const source = join(profileDir, relativePath);
      const target = join(backupPath, relativePath);
      await mkdir(dirname(target), {recursive: true});
      await cp(source, target, {force: false, errorOnExist: true});
    }
  }
  try {
    for (const [relativePath, value] of entries) {
      if (value === undefined) continue;
      const target = join(profileDir, relativePath);
      await mkdir(dirname(target), {recursive: true});
      const temporary = `${target}.migration.tmp`;
      await writeFile(temporary, JSON.stringify(value), 'utf8');
      await rename(temporary, target);
    }
  } catch (error) {
    await restorePortableProfileBackup({profileDir, backupPath, existingPaths, writtenPaths}).catch(
      () => undefined,
    );
    throw error;
  }
  return {backupPath, existingPaths, writtenPaths};
}

/** Reverts only files that a failed semantic migration wrote or replaced. */
export async function restorePortableProfileBackup({
  profileDir,
  backupPath,
  existingPaths,
  writtenPaths,
}: {
  profileDir: string;
  backupPath?: string;
  existingPaths: string[];
  writtenPaths: string[];
}) {
  const original = new Set(existingPaths);
  for (const relativePath of writtenPaths) {
    const target = join(profileDir, relativePath);
    if (!original.has(relativePath)) {
      await rm(target, {force: true});
      continue;
    }
    if (!backupPath) throw new Error('Profile 迁移备份不存在');
    const source = join(backupPath, relativePath);
    await mkdir(dirname(target), {recursive: true});
    await cp(source, target, {force: true});
  }
}
