/**
 * TODO: Rewrite this config to ESM
 * But currently electron-builder doesn't support ESM configs
 * @see https://github.com/develar/read-config-file/issues/10
 */
// const { notarize } = require('@electron/notarize');

require('dotenv').config();

/**
 * @type {() => import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
function getBuildTime() {
  return process.env.BUILD_TIME || new Date().getTime();
}

console.log('ELECTRON_PLATFORM', process.env.ELECTRON_PLATFORM);
console.log('ELECTRON_ARCH', process.env.ELECTRON_ARCH);

module.exports = async function () {
  const {getVersion} = await import('./version/getVersion.mjs');
  const config = {
    productName: 'ISLES Power',
    appId: 'com.isles-power.app',
    directories: {
      output: 'dist',
      buildResources: 'buildResources',
    },
    nodeGypRebuild: false, // Disable node-gyp rebuild, use prebuilt binaries
    npmRebuild: false, // Disable @electron/rebuild to skip iohook compilation
    files: [
      'packages/**/dist/**',
      'packages/**/assets/**',
      'migrations',
      'package.json',
      'node_modules/sqlite3/lib/binding/**/*.node',
      'node_modules/@tkomde/iohook/**/*',
      'node_modules/iconv-corefoundation/lib/*.node',
      'buildResources/**/*',
    ],
    extraResources: [
      {
        from: 'migrations',
        to: 'app/migrations',
      },
      {
        from: 'assets',
        to: 'app/assets',
      },
      {
        from: 'buildResources',
        to: 'buildResources',
        filter: ['*.ico', '*.png', '*.icns'],
      },
    ].filter(Boolean),
    extraMetadata: {
      version: getVersion(),
      main: './packages/main/dist/index.cjs',
    },
    asar: true,
    asarUnpack: ['**/*.{node,dll,so}', 'node_modules/@tkomde/iohook/builds/**/*'],

    // Windows 配置
    win: {
      icon: 'buildResources/icon.ico',
      target: [
        {
          target: 'nsis',
          arch: ['x64'],
        },
      ],
      artifactName: '${productName}-${version}-${arch}-${os}-' + getBuildTime() + '.${ext}',
    },
    nsis: {
      oneClick: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'ISLES Power',
      installerIcon: 'buildResources/icon.ico',
      uninstallerIcon: 'buildResources/icon.ico',
      installerHeaderIcon: 'buildResources/icon.ico',
      menuCategory: true,
      artifactName: '${productName}-${version}-${arch}-${os}-' + getBuildTime() + '.${ext}',
    },

    // macOS 配置
    mac: {
      timestamp: false,
      icon: 'buildResources/icon.icns',
      notarize: false,
      identity: process.env.APPLE_IDENTITY,
      target: [
        {
          target: 'dmg',
          arch: [process.env.ELECTRON_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64')],
        },
        ...(process.env.ENABLE_MAC_AUTO_UPDATE_BUILD === '1'
          ? [
              // The ZIP is required by electron-updater. Enable it only after
              // the release pipeline provides architecture-safe update feeds.
              {
                target: 'zip',
                arch: [process.env.ELECTRON_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64')],
              },
            ]
          : []),
      ],
      category: 'public.app-category.developer-tools',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'buildResources/entitlements.mac.plist',
      entitlementsInherit: 'buildResources/entitlements.mac.plist',
      type: 'distribution',
      strictVerify: false,
      artifactName: '${productName}-${version}-${arch}-${os}' + getBuildTime() + '.${ext}',
      signIgnore: [],
    },
    dmg: {
      sign: false,
      format: 'ULFO',
    },
    // 自编译不需要签名也行
    // mac: {
    //   identity: null,
    //   target: ['dmg', 'zip'],
    //   category: 'public.app-category.developer-tools',
    //   icon: 'buildResources/icon.icns',
    //   hardenedRuntime: true,
    //   gatekeeperAssess: false,
    //   entitlements: 'buildResources/entitlements.mac.plist',
    //   entitlementsInherit: 'buildResources/entitlements.mac.plist'
    // },
    // dmg: {
    //   sign: false
    // },
    // afterSign: async context => {
    //   const { electronPlatformName, appOutDir } = context;
    //   if (electronPlatformName === 'darwin') {
    //     const appName = context.packager.appInfo.productFilename;

    //     return await notarize({
    //       tool: 'notarytool',
    //       identity: process.env.APPLE_IDENTITY,
    //       teamId: process.env.APPLE_TEAM_ID,
    //       appBundleId: 'com.chrome-power.app',
    //       appPath: `${appOutDir}/${appName}.app`,
    //       appleId: process.env.APPLE_ID,
    //       appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    //     });
    //   }
    // },

    // 添加 GitHub 发布配置
    publish: {
      provider: 'github',
      private: false,
      // CI leaves releases as drafts until all platform jobs finish. The local
      // release script sets RELEASE_TYPE=release for one-machine publishing.
      releaseType: process.env.RELEASE_TYPE || 'draft',
    },

    // 在打包后复制 window-addon.node 到最终目录
    afterPack: async context => {
      const fs = require('fs');
      const path = require('path');
      const {electronPlatformName, arch, appOutDir} = context;

      // electron-builder 的 arch 是数字枚举，需要转换为字符串
      const archMap = {0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal'};
      const archString = archMap[arch] || String(arch);

      console.log(`Copying window-addon for ${electronPlatformName}-${archString}...`);

      const sourceCandidates = [
        path.join(
          __dirname,
          `packages/main/src/native-addon/build/Release/${electronPlatformName}-${archString}/window-addon.node`,
        ),
        path.join(__dirname, 'packages/main/src/native-addon/build/Release/window-addon.node'),
      ];
      const sourcePath = sourceCandidates.find(candidate => fs.existsSync(candidate));

      // Mac 应用有 .app 包结构，需要特殊处理路径
      let targetDir;
      if (electronPlatformName === 'darwin') {
        const appName = context.packager.appInfo.productFilename;
        targetDir = path.join(
          appOutDir,
          `${appName}.app/Contents/Resources/app.asar.unpacked/node_modules/window-addon`,
        );
      } else {
        targetDir = path.join(appOutDir, 'resources/app.asar.unpacked/node_modules/window-addon');
      }
      const targetPath = path.join(targetDir, 'window-addon.node');

      try {
        // 检查源文件是否存在
        if (!sourcePath) {
          console.error(`Source file not found. Tried: ${sourceCandidates.join(', ')}`);
          console.error('Please run npm run build:native-addon first');
          throw new Error('window-addon.node not found');
        }

        // 创建目标目录
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, {recursive: true});
          console.log(`Created directory: ${targetDir}`);
        }

        // 复制文件
        fs.copyFileSync(sourcePath, targetPath);
        console.log(`Successfully copied window-addon.node to ${targetPath}`);
      } catch (error) {
        console.error('Failed to copy window-addon:', error);
        throw error;
      }

      if (process.env.MAC_LOCAL_ONLY === '1' && electronPlatformName === 'darwin') {
        const {execFileSync} = require('child_process');
        const appPath = path.join(appOutDir, `${context.packager.appInfo.productFilename}.app`);

        // Electron's prebuilt helpers carry linker signatures. Re-sign the complete
        // local bundle so macOS does not treat those stale signatures as corrupted.
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
          stdio: 'inherit',
        });
        execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
          stdio: 'inherit',
        });
      }
    },
  };

  // 根据平台添加特定配置
  // if (process.platform === 'darwin') {
  //   // 只在 CI 环境中启用签名
  //   if (process.env.CI) {
  //     console.log('Signing for macOS in CI');
  //     config.mac = {
  //       icon: 'buildResources/icon.icns',
  //       identity: process.env.APPLE_IDENTITY,
  //       target: [
  //         {
  //           target: 'dmg',
  //           arch: ['x64', 'arm64'],
  //         },
  //       ],
  //       category: 'public.app-category.developer-tools',
  //       hardenedRuntime: true,
  //       gatekeeperAssess: true,
  //       entitlements: 'buildResources/entitlements.mac.plist',
  //       entitlementsInherit: 'buildResources/entitlements.mac.plist',
  //       signIgnore: [
  //         'node_modules/sqlite3/lib/binding/napi-v6-darwin-unknown-arm64/node_sqlite3.node',
  //         'node_modules/sqlite3/lib/binding/napi-v6-darwin-unknown-x64/node_sqlite3.node',
  //         'app.asar.unpacked/node_modules/window-addon/window-addon-x64.node',
  //         'app.asar.unpacked/node_modules/window-addon/window-addon-arm64.node',
  //       ],
  //       artifactName: '${productName}-${version}-${arch}-${os}-' + getBuildTime() + '.${ext}',
  //       compression: 'store',
  //       darkModeSupport: true,
  //     };
  //   }

  //   config.dmg = {
  //     sign: false,
  //     writeUpdateInfo: false,
  //     format: 'ULFO',
  //   };
  // }

  return config;
};
