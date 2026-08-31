import {createLogger} from '../../../shared/utils/logger';
import {getWindowManager} from '../humanize/window-addon';
import {isWindowIconBadgeEnabled} from './window-identity-label';

const logger = createLogger('window-identity-icon');

const toAppUserModelToken = (name?: string) => {
  const normalized = (name || 'unnamed').replace(/\s+/g, '-').trim() || 'unnamed';
  return Array.from(normalized)
    .map(character => (/[a-zA-Z0-9.-]/.test(character) ? character : character.codePointAt(0)?.toString(16)))
    .join('')
    .slice(0, 80);
};

export const applyWindowIdentityIcon = async (args: {pid?: number; iconPath: string; name?: string}) => {
  if (process.platform !== 'win32' || !isWindowIconBadgeEnabled() || !args.pid || !args.iconPath) {
    return false;
  }

  const windowManager = getWindowManager();
  if (!windowManager?.setWindowIdentityIcon) {
    logger.warn('Window identity icon is unavailable because the native addon is not loaded');
    return false;
  }

  const appUserModelId = `com.yunsen-power.profile.${toAppUserModelToken(args.name)}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const iconApplied = windowManager.setWindowIdentityIcon(args.pid, args.iconPath, appUserModelId);
      // The Windows taskbar label comes from the native top-level window
      // title, not from the icon or AppUserModelID. Keep the profile name
      // visible even when Chromium has not propagated the page title yet.
      const titleApplied = typeof windowManager.setWindowIdentityTitle === 'function'
        ? windowManager.setWindowIdentityTitle(args.pid, `[${args.name || '未命名'}]`)
        : false;
      if (iconApplied || titleApplied) {
        logger.info('Applied window identity icon', {pid: args.pid, appUserModelId, attempt: attempt + 1});
        return true;
      }
    } catch (error) {
      logger.warn('Failed to apply window identity icon', {
        pid: args.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  logger.warn('Timed out waiting for the Chromium top-level window', {pid: args.pid});
  return false;
};

export {isWindowIconBadgeEnabled};
