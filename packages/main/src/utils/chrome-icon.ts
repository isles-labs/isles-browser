import {existsSync} from 'fs';
import {mkdir, readFile, rm, writeFile} from 'fs/promises';
import {join} from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import pngToIco from 'png-to-ico';
import {app} from 'electron';
import sharp from 'sharp';
import {createLogger} from '../../../shared/utils/logger';
import {MAIN_LOGGER_LABEL} from '../constants';
import {
  escapeWindowIdentityXml,
  getWindowIdentityBadgeText,
  isWindowIconBadgeEnabled,
} from './window-identity-label';

const logger = createLogger(MAIN_LOGGER_LABEL);
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const execFileAsync = promisify(execFile);

const getSourceIconPath = () => {
  const root = app.isPackaged ? process.resourcesPath : process.cwd();
  const candidates = [
    join(root, 'buildResources', 'icon.png'),
    join(root, 'app', 'buildResources', 'icon.png'),
    join(root, 'assets', 'icon.png'),
  ];
  return candidates.find(existsSync) || '';
};

const createBadgeSvg = (size: number, text: string) => {
  const characters = Array.from(text).slice(-4);
  while (characters.length < 4) characters.push(' ');
  const fontSize = Math.max(5, Math.floor(size * 0.39));
  const xPositions = [size * 0.29, size * 0.71];
  const yPositions = [size * 0.43, size * 0.83];
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${Math.max(1, size * 0.08)}" fill="#f28c28" />
      <text font-family="Microsoft YaHei UI, Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle">
        <tspan x="${xPositions[0]}" y="${yPositions[0]}">${escapeWindowIdentityXml(characters[0])}</tspan>
        <tspan x="${xPositions[1]}" y="${yPositions[0]}">${escapeWindowIdentityXml(characters[1])}</tspan>
        <tspan x="${xPositions[0]}" y="${yPositions[1]}">${escapeWindowIdentityXml(characters[2])}</tspan>
        <tspan x="${xPositions[1]}" y="${yPositions[1]}">${escapeWindowIdentityXml(characters[3])}</tspan>
      </text>
    </svg>
  `);
};

const createBadgedPng = async (_sourceIcon: Buffer, size: number, badgeText: string) =>
  sharp(createBadgeSvg(size, badgeText)).png().toBuffer();

/**
 * Generates a per-profile Windows icon used by the native window identity
 * bridge. macOS deliberately does not generate this icon because Dock icons
 * belong to the application, not an individual Chromium window.
 */
export async function generateChromeIcon(profileDir: string, windowName?: string): Promise<string> {
  if (process.platform !== 'win32' || !isWindowIconBadgeEnabled()) {
    return '';
  }

  const sourceIconPath = getSourceIconPath();
  if (!sourceIconPath) {
    logger.warn('Window identity icon source image was not found');
    return '';
  }

  const targetDir = join(profileDir, 'Default');
  const icoPath = join(targetDir, 'window-identity.ico');
  const badgeText = getWindowIdentityBadgeText(windowName);

  try {
    await mkdir(targetDir, {recursive: true});
    const sourceIcon = await readFile(sourceIconPath);
    const pngBuffers = await Promise.all(
      ICON_SIZES.map(size =>
        createBadgedPng(sourceIcon, size, badgeText),
      ),
    );
    await writeFile(icoPath, await pngToIco(pngBuffers));
    logger.info('Generated window identity icon', {icoPath, badgeText});
    return icoPath;
  } catch (error) {
    logger.warn('Failed to generate window identity icon', {
      error: error instanceof Error ? error.message : String(error),
      profileDir,
    });
    return '';
  }
}

/** Creates an .icns asset for a profile-specific macOS Chromium.app clone. */
export async function generateMacProfileAppIcon(resourcesDir: string, windowName?: string): Promise<string> {
  if (process.platform !== 'darwin') {
    return '';
  }

  const sourceIconPath = getSourceIconPath();
  if (!sourceIconPath) {
    logger.warn('macOS profile app icon source image was not found');
    return '';
  }

  const badgeText = getWindowIdentityBadgeText(windowName);
  const iconsetDir = join(resourcesDir, '.window-identity.iconset');
  const iconPath = join(resourcesDir, 'window-identity.icns');
  const iconsetSizes: Array<[string, number]> = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  try {
    await mkdir(resourcesDir, {recursive: true});
    await rm(iconsetDir, {recursive: true, force: true});
    await mkdir(iconsetDir, {recursive: true});
    const sourceIcon = await readFile(sourceIconPath);
    await Promise.all(
      iconsetSizes.map(async ([fileName, size]) =>
        writeFile(join(iconsetDir, fileName), await createBadgedPng(sourceIcon, size, badgeText)),
      ),
    );
    await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', iconPath]);
    await rm(iconsetDir, {recursive: true, force: true});
    logger.info('Generated macOS profile app icon', {iconPath, badgeText});
    return iconPath;
  } catch (error) {
    await rm(iconsetDir, {recursive: true, force: true});
    logger.warn('Failed to generate macOS profile app icon', {
      error: error instanceof Error ? error.message : String(error),
      resourcesDir,
    });
    return '';
  }
}
