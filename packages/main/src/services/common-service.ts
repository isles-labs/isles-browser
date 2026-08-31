import {app, BrowserWindow, ipcMain, dialog, shell} from 'electron';
import {createLogger} from '../../../shared/utils/logger';
import {CONFIG_FILE_PATH, LOGS_PATH, SERVICE_LOGGER_LABEL} from '../constants';
import {extname, join} from 'path';
import {copyFileSync, writeFileSync, readFileSync, readdir, existsSync, mkdirSync, statSync, openSync, readSync, closeSync} from 'fs';
import type {SettingOptions} from '../../../shared/types/common';
import {getSettings} from '../utils/get-settings';
import {getOrigin, getToken} from '../server';
import axios from 'axios';
import {writeFile} from 'fs/promises';


const logger = createLogger(SERVICE_LOGGER_LABEL);
const MAX_LOG_LINES = 2000;
const MAX_LOG_FILE_BYTES = 256 * 1024;
const MAX_DATA_URL_FILE_BYTES = 5 * 1024 * 1024;
const DATA_URL_MIME_BY_EXTENSION: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const getLogLevel = (line: string) => {
  const match = line.match(/-\s*(info|warn|error):/);
  return match?.[1] || 'info';
};

const readLogTail = (filePath: string) => {
  const fileSize = statSync(filePath).size;
  const bytesToRead = Math.min(fileSize, MAX_LOG_FILE_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, bytesToRead, Math.max(0, fileSize - bytesToRead));
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
};

export const initCommonService = () => {
  ipcMain.handle('common-download', async (_, filePath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    const defaultPath = join(app.getPath('downloads'), 'template.xlsx');

    const {filePath: savePath} = await dialog.showSaveDialog(win, {
      title: 'Save Template',
      defaultPath: defaultPath,
      buttonLabel: 'Save',
    });

    if (savePath) {
      copyFileSync(join(__dirname, '../..', filePath), savePath);

      // 打开文件管理器并选择该文件
      shell.showItemInFolder(savePath);

      return savePath;
    } else {
      return null;
    }
  });

  // 添加 IPC 处理程序
  ipcMain.handle('common-save-dialog', async (_, options) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return {canceled: true};
    return dialog.showSaveDialog(win, options);
  });

  ipcMain.handle('common-save-file', async (_, {filePath, buffer}) => {
    await writeFile(filePath, buffer);
  });

  ipcMain.handle('common-read-file-data-url', async (_, filePath: string) => {
    if (!filePath) return '';
    const fileStat = statSync(filePath);
    if (fileStat.size > MAX_DATA_URL_FILE_BYTES) {
      throw new Error('File is too large');
    }

    const extension = extname(filePath).toLowerCase();
    const mime = DATA_URL_MIME_BY_EXTENSION[extension] || 'application/octet-stream';
    const buffer = readFileSync(filePath);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  });

  ipcMain.handle('common-fetch-settings', async () => {
    const settings = getSettings();

    return settings;
  });

  ipcMain.handle(
    'common-fetch-logs',
    async (_, module: 'Main' | 'Windows' | 'Proxy' | 'Services' | 'Api' = 'Main') => {
      // if (import.meta.env.DEV) {
      //   return [];
      // }
      const logDir = join(LOGS_PATH, module);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, {recursive: true});
      }
      // read directory and get all folders
      const logFiles = await new Promise<string[]>((resolve, reject) => {
        readdir(logDir, (err, files) => {
          if (err) {
            reject(err);
          } else {
            resolve(files);
          }
        });
      });
      // Only return the newest log tail so large files do not freeze the renderer.
      return logFiles.slice(-5).map(file => {
        const logFile = join(logDir, file);
        const lines = readLogTail(logFile)
          .split('\n')
          .filter(Boolean)
          .slice(-MAX_LOG_LINES);
        return {
          name: file,
          content: lines.map(line => ({
            message: line,
            level: getLogLevel(line),
          })),
        };
      });
    },
  );

  ipcMain.handle('common-save-settings', async (_, values: SettingOptions) => {
    if (values.localChromePath === '/Applications/Google Chrome.app') {
      values.localChromePath = values.localChromePath + '/Contents/MacOS/Google Chrome';
    }
    const configFilePath = CONFIG_FILE_PATH;

    try {
      writeFileSync(configFilePath, JSON.stringify(values), 'utf8');
    } catch (error) {
      logger.error('Error writing to the settings file:', error);
    }

    return {};
  });

  ipcMain.handle(
    'common-choose-path',
    async (_, type: 'openFile' | 'openDirectory' = 'openDirectory') => {
      // const win = BrowserWindow.getAllWindows()[0];

      const path = await dialog.showOpenDialog({properties: [type]});

      return path.filePaths[0];
    },
  );

  ipcMain.handle('common-api', async () => {
    const apiUrl = getOrigin();
    const res = await axios.get(`${apiUrl}/status`, {headers: {Authorization: `Bearer ${getToken()}`}});
    return {
      url: apiUrl,
      token: getToken(),
      ...(res?.data || {}),
    };
  });
};
