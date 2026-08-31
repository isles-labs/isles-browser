import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron/package.json');
const {electronToChromium} = require('electron-to-chromium');

const electronMajor = Number(electron.version.split('.')[0]);
const nodeByElectronMajor = new Map([
  // Electron 31 ships Node 20. Update this map with each Electron major upgrade.
  [31, '20'],
]);
const node = nodeByElectronMajor.get(electronMajor);
const chromiumVersion = electronToChromium(electron.version);
const chrome = chromiumVersion?.split('.')[0];

if (!node || !chrome) {
  throw new Error(
    `Cannot determine Vite targets for Electron ${electron.version}. Update scripts/write-ci-electron-vendors-cache.mjs.`,
  );
}

writeFileSync('.electron-vendors.cache.json', JSON.stringify({chrome, node}));
console.log(`Wrote Electron ${electron.version} vendor targets: Chrome ${chrome}, Node ${node}`);
