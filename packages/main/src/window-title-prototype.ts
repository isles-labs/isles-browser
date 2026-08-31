import {mkdir, writeFile} from 'fs/promises';
import {join} from 'path';
import type {DB} from '../../shared/types/db';

const EXTENSION_VERSION = '1.0.0';

/**
 * Temporary, app-managed extension used to validate window labels before a
 * Chromium title-bar patch is compiled. It is enabled by default for the
 * prototype and can be disabled with CLOAK_WINDOW_TITLE_PROTOTYPE=0.
 */
export const isWindowTitlePrototypeEnabled = () => process.env.CLOAK_WINDOW_TITLE_PROTOTYPE !== '0';

const normalizeLabel = (windowData: DB.Window) => {
  const name = (windowData.name || '未命名').replace(/\s+/g, ' ').trim() || '未命名';
  return Array.from(name).slice(0, 24).join('');
};

export const ensureWindowTitlePrototypeExtension = async (
  profileRoot: string,
  windowData: DB.Window,
) => {
  const extensionRoot = join(profileRoot, 'internal-extensions', 'window-title-prototype', String(windowData.id ?? 'unknown'));
  await mkdir(extensionRoot, {recursive: true});

  const label = normalizeLabel(windowData);
  await writeFile(
    join(extensionRoot, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Cloak Window Title Prototype',
        version: EXTENSION_VERSION,
        description: 'Temporary profile window label prototype.',
        content_scripts: [
          {
            matches: ['http://*/*', 'https://*/*', 'file:///*'],
            js: ['title.js'],
            run_at: 'document_start',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const prefix = `[${label}]`;
  await writeFile(
    join(extensionRoot, 'title.js'),
    `(() => {
  const prefix = ${JSON.stringify(prefix)};
  const apply = () => {
    const current = document.title || '';
    if (!current.startsWith(prefix)) document.title = current ? prefix + ' ' + current : prefix;
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
})();\n`,
    'utf8',
  );

  return extensionRoot;
};
