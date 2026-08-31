import {execFile} from 'child_process';
import {createHash} from 'crypto';
import {existsSync} from 'fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'fs/promises';
import {basename, dirname, join, resolve} from 'path';
import {promisify} from 'util';
import {createLogger} from '../../../shared/utils/logger';
import {generateMacProfileAppIcon} from './chrome-icon';
import {normalizeWindowIdentityName} from './window-identity-label';

const logger = createLogger('mac-profile-app');
const execFileAsync = promisify(execFile);

type MacProfileAppOptions = {
  executablePath: string;
  profileRoot: string;
  profileId: string;
  windowName?: string;
};

const findAppBundle = (executablePath: string) => {
  const resolvedPath = resolve(executablePath);
  let current = dirname(resolvedPath);
  while (current !== dirname(current)) {
    if (current.endsWith('.app') && existsSync(join(current, 'Contents', 'Info.plist'))) {
      return current;
    }
    current = dirname(current);
  }
  return undefined;
};

const createProfileToken = (profileId: string) => createHash('sha256').update(profileId).digest('hex').slice(0, 20);

const createBundleId = (profileId: string) => `com.yunsen-power.browser.${createProfileToken(profileId)}`;

const copyAppBundle = async (sourceApp: string, destinationApp: string) => {
  await mkdir(dirname(destinationApp), {recursive: true});
  try {
    await execFileAsync('/bin/cp', ['-cR', sourceApp, destinationApp]);
  } catch {
    await execFileAsync('/bin/cp', ['-R', sourceApp, destinationApp]);
  }
};

const readSourceRevision = async (sourceApp: string, executablePath: string) => {
  const infoPath = join(sourceApp, 'Contents', 'Info.plist');
  const [infoContents, executableStat] = await Promise.all([readFile(infoPath), stat(executablePath)]);
  return createHash('sha256')
    .update(resolve(sourceApp))
    .update(infoContents)
    .update(String(executableStat.size))
    .update(String(executableStat.mtimeMs))
    .digest('hex');
};

type ProfileAppMetadata = {
  sourceRevision?: string;
  windowName?: string;
};

const writeProfileAppMetadata = (appPath: string, metadata: ProfileAppMetadata) =>
  writeFile(
    join(appPath, 'Contents', 'Resources', '.cloak-profile-app.json'),
    JSON.stringify(metadata),
    'utf8',
  );

const readProfileAppMetadata = async (appPath: string): Promise<ProfileAppMetadata | undefined> => {
  try {
    return JSON.parse(
      await readFile(join(appPath, 'Contents', 'Resources', '.cloak-profile-app.json'), 'utf8'),
    ) as ProfileAppMetadata;
  } catch {
    return undefined;
  }
};

const updateAppMetadata = async (appPath: string, name: string, profileId: string) => {
  const infoPath = join(appPath, 'Contents', 'Info.plist');
  const resourcesDir = join(appPath, 'Contents', 'Resources');
  const iconPath = await generateMacProfileAppIcon(resourcesDir, name);
  if (!iconPath) {
    throw new Error('Failed to generate profile app icon');
  }

  await execFileAsync('/usr/bin/plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    createBundleId(profileId),
    infoPath,
  ]);
  await execFileAsync('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', name, infoPath]);
  await execFileAsync('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', name, infoPath]);
  await execFileAsync('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', 'window-identity.icns', infoPath]);
  await execFileAsync('/usr/bin/plutil', ['-replace', 'LSHasLocalizedDisplayName', '-bool', 'false', infoPath]);
  try {
    await execFileAsync('/usr/bin/plutil', ['-remove', 'CFBundleIconName', infoPath]);
  } catch {
    // Older Chromium bundles do not always include this key.
  }
};

const signAndRegisterApp = async (appPath: string) => {
  await execFileAsync('/usr/bin/xattr', ['-cr', appPath]);
  await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  const lsRegister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  await execFileAsync(lsRegister, ['-f', appPath]);
};

const replaceAppAtomically = async (stagedApp: string, destinationApp: string) => {
  const backupApp = `${destinationApp}.previous`;
  await rm(backupApp, {recursive: true, force: true});
  if (existsSync(destinationApp)) {
    await rename(destinationApp, backupApp);
  }
  try {
    await rename(stagedApp, destinationApp);
    await rm(backupApp, {recursive: true, force: true});
  } catch (error) {
    if (existsSync(backupApp) && !existsSync(destinationApp)) {
      await rename(backupApp, destinationApp);
    }
    throw error;
  }
};

/**
 * Makes macOS treat each browser profile as an independent application, which
 * gives it a separate Dock and Cmd+Tab icon without touching Chromium source.
 */
export async function prepareMacProfileApp(options: MacProfileAppOptions): Promise<string> {
  if (process.platform !== 'darwin') {
    return options.executablePath;
  }

  const sourceApp = findAppBundle(options.executablePath);
  if (!sourceApp) {
    logger.warn('Browser executable is not inside a macOS app bundle; skipping profile app clone', {
      executablePath: options.executablePath,
    });
    return options.executablePath;
  }

  const profileId = options.profileId || createHash('sha256').update(options.executablePath).digest('hex').slice(0, 20);
  const destinationApp = join(options.profileRoot, 'mac-profile-apps', `${createProfileToken(profileId)}.app`);
  const sourceRevision = await readSourceRevision(sourceApp, options.executablePath);
  const name = normalizeWindowIdentityName(options.windowName);

  try {
    const existingMetadata = await readProfileAppMetadata(destinationApp);
    const sourceChanged = existingMetadata?.sourceRevision !== sourceRevision;
    const nameChanged = existingMetadata?.windowName !== name;

    if (sourceChanged || nameChanged) {
      const stagedApp = `${destinationApp}.staging-${process.pid}-${Date.now()}`;
      await rm(stagedApp, {recursive: true, force: true});
      try {
        await copyAppBundle(sourceChanged ? sourceApp : destinationApp, stagedApp);
        await updateAppMetadata(stagedApp, name, profileId);
        await signAndRegisterApp(stagedApp);
        await writeProfileAppMetadata(stagedApp, {sourceRevision, windowName: name});
        await replaceAppAtomically(stagedApp, destinationApp);
      } finally {
        await rm(stagedApp, {recursive: true, force: true});
      }
    }
    const executablePath = join(destinationApp, 'Contents', 'MacOS', basename(options.executablePath));
    if (!existsSync(executablePath)) {
      throw new Error(`Profile app executable was not found: ${executablePath}`);
    }
    logger.info('Prepared macOS profile app', {profileId, name, destinationApp});
    return executablePath;
  } catch (error) {
    logger.warn('Failed to prepare macOS profile app; using the shared browser app', {
      profileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return options.executablePath;
  }
}
