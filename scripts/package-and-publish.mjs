import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import process from 'node:process';

const args = new Map(
  process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=', 2);
    return [key, value ?? 'true'];
  }),
);

const platform = args.get('platform') || 'win';
const dryRun = args.get('dry-run') === 'true';
const buildTime = args.get('build-time') || String(Date.now());
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const targets = {
  win: {
    builderArgs: ['--win', 'nsis', '--x64'],
    env: {ELECTRON_PLATFORM: 'win32', ELECTRON_ARCH: 'x64'},
  },
  'mac-x64': {
    builderArgs: ['--mac', 'dmg', '--x64'],
    env: {ELECTRON_PLATFORM: 'darwin', ELECTRON_ARCH: 'x64'},
  },
  'mac-arm64': {
    builderArgs: ['--mac', 'dmg', '--arm64'],
    env: {ELECTRON_PLATFORM: 'darwin', ELECTRON_ARCH: 'arm64'},
  },
};

if (!targets[platform]) {
  fail(`不支持的平台 ${platform}。可选值：win、mac-x64、mac-arm64。`);
}

const token = resolveGitHubToken();
const target = targets[platform];
const env = {
  ...process.env,
  ...target.env,
  BUILD_TIME: buildTime,
  // Local publishing should be visible to users immediately. CI keeps its draft default.
  RELEASE_TYPE: 'release',
  ...(token ? {GH_TOKEN: token} : {}),
};


console.log(`准备发布 ISLES Browser v${packageJson.version} (${platform})`);
run('npm', ['run', 'build'], env);
run(
  'npx',
  [
    'electron-builder',
    ...target.builderArgs,
    '--config',
    '.electron-builder.config.js',
    '--publish',
    dryRun ? 'never' : 'always',
  ],
  env,
);
console.log(
  dryRun
    ? '构建完成，未上传 GitHub。'
    : `发布完成：https://github.com/0131LWG/cloak-power-browser/releases/tag/v${packageJson.version}`,
);

function resolveGitHubToken() {
  const configured = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (configured) return configured;
  const result = spawnSync('gh', ['auth', 'token'], {encoding: 'utf8'});
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  if (!dryRun) {
    fail('未找到 GitHub 登录凭据。请先执行 `gh auth login`，或设置环境变量 GH_TOKEN。');
  }
  return undefined;
}

function run(command, commandArgs, commandEnv) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: commandEnv,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail(`命令执行失败：${command} ${commandArgs.join(' ')}`);
}

function fail(message) {
  console.error(`发布失败：${message}`);
  process.exit(1);
}
