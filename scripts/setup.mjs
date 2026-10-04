import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
const available = (command, args) => {
  try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { return false; }
};

try {
  if (args.some(arg => arg !== '--start' && arg !== '--no-open')) throw new Error('用法：npm run setup -- [--start] [--no-open]');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请先安装 Node.js 22 或以上版本，推荐 Node.js 24');
  if (!available('git', ['--version'])) throw new Error('缺少 Git，请先安装并加入 PATH');
  const hasFfmpeg = available('ffmpeg', ['-version']) && available('ffprobe', ['-version']);
  if (!hasFfmpeg && !(process.platform === 'darwin' && available('brew', ['--version']))) {
    throw new Error('缺少 FFmpeg/ffprobe，请通过系统包管理器安装并加入 PATH 后重试；macOS 可运行 brew install ffmpeg');
  }
  console.log('准备 npm 依赖…');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('请通过 npm run setup 执行依赖准备');
  run(process.execPath, [npmCli, 'ci']);
  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) {
    console.log('准备本地 Chromium…');
    run(process.execPath, [join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium']);
  }
  if (!hasFfmpeg) {
    console.log('通过 Homebrew 准备 FFmpeg…');
    run('brew', ['install', 'ffmpeg']);
  }
  if (!available('ffmpeg', ['-version']) || !available('ffprobe', ['-version'])) throw new Error('FFmpeg/ffprobe 安装后仍不可用，请检查 PATH');
  console.log('依赖准备完成，可以运行 npm run studio。');
  if (args.includes('--start')) run(process.execPath, [join(root, 'scripts/server.mjs'), ...(args.includes('--no-open') ? ['--no-open'] : [])]);
} catch (error) {
  console.error(`依赖准备失败：${error.message}`);
  process.exitCode = 1;
}
