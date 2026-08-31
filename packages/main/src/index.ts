import {BrowserWindow, app, globalShortcut} from 'electron';
import './security-restrictions';
import {restoreOrCreateWindow} from '/@/mainWindow';
import {platform} from 'node:process';
import {db, initializeDatabase} from './db';
import {initServices} from './services';
import {createLogger} from '../../shared/utils/logger';
import {MAIN_LOGGER_LABEL} from './constants';
import {checkForAppUpdatesAfterLaunch, initUpdateService} from './update-service';
import './server/index';

const logger = createLogger(MAIN_LOGGER_LABEL);

/**
 * Prevent electron from running multiple instances.
 */
const allowMultiInstance =
  process.env.ALLOW_MULTI_INSTANCE === '1' || process.env.CLOUD_SYNC_MULTI_INSTANCE_TEST === '1';
const isSingleInstance = allowMultiInstance ? true : app.requestSingleInstanceLock();
if (!isSingleInstance) {
  app.quit();
  process.exit(0);
}
if (!allowMultiInstance) {
  app.on('second-instance', restoreOrCreateWindow);
}

/**
 * Shout down background process if all windows was closed
 */
app.on('window-all-closed', () => {
  if (platform !== 'darwin') {
    app.quit();
  }
});

/**
 * @see https://www.electronjs.org/docs/latest/api/app#event-activate-macos Event: 'activate'.
 */
app.on('activate', restoreOrCreateWindow);

/**
 * Create the application window when the background process is ready.
 */
app
  .whenReady()
  .then(async () => {
    // Register global shortcuts
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win) {
        win.webContents.toggleDevTools();
      }
    });

    // Register sync control shortcuts (not supported on macOS)
    if (platform !== 'darwin') {
      globalShortcut.register('CommandOrControl+Alt+S', () => {
        logger.info('Global shortcut: Start sync (Ctrl+Alt+S)');
        const allWindows = BrowserWindow.getAllWindows();
        allWindows.forEach(win => {
          win.webContents.send('sync-shortcut-start');
        });
      });

      globalShortcut.register('CommandOrControl+Alt+D', () => {
        logger.info('Global shortcut: Stop sync (Ctrl+Alt+D)');
        const allWindows = BrowserWindow.getAllWindows();
        allWindows.forEach(win => {
          win.webContents.send('sync-shortcut-stop');
        });
      });
    }

    try {
      await initializeDatabase();
    } catch (error) {
      const errorString =
        error instanceof Error ? `${error.message}\n${error.stack || ''}` : JSON.stringify(error);
      logger.error(`Failed initialize database: ${errorString}`);
    }
    await initServices();
    initUpdateService();
    await restoreOrCreateWindow();
    checkForAppUpdatesAfterLaunch();
    // if (!import.meta.env.DEV) {
    //   const {result, error, exist} = await extractChromeBin();
    //   if (result) {
    //     if (!exist) {
    //       logger.info('Extracted Chrome-bin.zip');
    //     }
    //   } else {
    //     logger.error('Failed extract Chrome-bin.zip, try to manually extract it', error);
    //   }
    // }
  })
  .catch(e => logger.error('Failed create window:', e));

/**
 * Install Vue.js or any other extension in development mode only.
 * Note: You must install `electron-devtools-installer` manually
 */
// REACT_DEVELOPER_TOOLS doesn't work
// if (import.meta.env.DEV) {
//   app
//     .whenReady()
//     .then(() => import('electron-devtools-installer'))
//     .then(module => {
//       const {default: installExtension, REACT_DEVELOPER_TOOLS} =
//         // @ts-expect-error Hotfix for https://github.com/cawa-93/vite-electron-builder/issues/915
//         typeof module.default === 'function' ? module : (module.default as typeof module);

//       return installExtension(REACT_DEVELOPER_TOOLS, {
//         loadExtensionOptions: {
//           allowFileAccess: true,
//         },
//       });
//     })
//     .catch(e => console.error('Failed install extension:', e));
// }

app.on('will-quit', () => {
  // Unregister all global shortcuts
  globalShortcut.unregisterAll();
});

app.on('before-quit', async () => {
  await db.destroy();
});

process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', reason => {
  logger.error('Unhandled rejection:', reason);
});
