import {app} from 'electron';
import path from 'path';
import type {SafeAny} from '../../../shared/types/db';
import {createLogger} from '../../../shared/utils/logger';

const logger = createLogger('humanize-window-addon');

let windowManager: SafeAny | null = null;

export const getWindowManager = () => {
  if (windowManager) {
    return windowManager;
  }

  try {
    const addonPath = !app.isPackaged
      ? path.join(__dirname, '../src/native-addon/build/Release/', 'window-addon.node')
      : path.join(
          process.resourcesPath,
          'app.asar.unpacked/node_modules/window-addon/',
          'window-addon.node',
        );
    const addon = require(addonPath);
    windowManager = new addon.WindowManager();
    return windowManager;
  } catch (error) {
    logger.error('Failed to load native window addon for humanize:', error);
    return null;
  }
};
