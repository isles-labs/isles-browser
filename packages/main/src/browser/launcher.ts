import {join} from 'path';
import type {DB} from '../../../shared/types/db';
import type {SettingOptions} from '../../../shared/types/common';

export interface BrowserLaunchOptions {
  chromePort: number;
  finalProxy?: string;
  headless?: boolean;
  profileId: string;
  profileRoot: string;
  startUrl?: string;
  extensions?: string[];
  windowData: DB.Window;
}

export const getBrowserPath = (settings: SettingOptions) =>
  process.env.CHROMIUM_PATH || settings.localChromePath || settings.chromiumBinPath;

export const buildBrowserLaunchArgs = (settings: SettingOptions, options: BrowserLaunchOptions) => {
  const executablePath = getBrowserPath(settings);
  const userDataDir = join(options.profileRoot, 'browser', options.profileId);
  const args = [
    '--force-color-profile=srgb',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--metrics-recording-only',
    `--remote-debugging-port=${options.chromePort}`,
    `--user-data-dir=${userDataDir}`,
    ...(process.platform === 'darwin' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
  ];
  if (options.finalProxy) args.push(`--proxy-server=${options.finalProxy}`);
  if (options.windowData.ua) args.push(`--user-agent=${options.windowData.ua}`);
  if (options.extensions?.length) {
    const extensionArg = options.extensions.join(',');
    args.push(`--disable-extensions-except=${extensionArg}`, `--load-extension=${extensionArg}`);
  }
  if (options.headless) {
    args.push('--headless=new');
    if (process.platform !== 'darwin') args.push('--disable-gpu');
  } else {
    args.push('--new-window');
    if (options.startUrl) args.push(options.startUrl);
  }
  return {executablePath, userDataDir, args};
};
