import { AppError } from '../src/i18n.js';
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const FPS = 30;

export async function createExportPage(manifest, { onFrame } = {}) {
  if (!existsSync(chromium.executablePath())) {
    throw new AppError('error.chromiumMissing');
  }
  const assets = new Map([
    ['/index.html', ['text/html; charset=utf-8', readFileSync(resolve(root, 'index.html'))]],
    ...readdirSync(resolve(root, 'src')).filter(name => name.endsWith('.js')).map(name =>
      [`/src/${name}`, ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'src', name))]]),
  ]);
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/frame' && onFrame) {
      const pixels = Buffer.allocUnsafe(1920 * 1080 * 4);
      let size = 0;
      try {
        for await (const chunk of request) {
          if (size + chunk.length > pixels.length) throw new Error('Invalid frame size');
          chunk.copy(pixels, size); size += chunk.length;
        }
        if (size !== pixels.length) throw new Error('Invalid frame size');
      } catch { response.writeHead(400); response.end(); return; }
      try { await onFrame(pixels); response.writeHead(200); }
      catch { response.writeHead(500); }
      response.end(); return;
    }
    const asset = assets.get(request.url);
    response.writeHead(asset ? 200 : 404, { 'content-type': asset?.[0] || 'text/plain', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" });
    response.end(asset?.[1] || 'Not found');
  });
  let browser;
  const close = async () => {
    try { await browser?.close(); }
    finally { if (server.listening) await new Promise(done => server.close(done)); }
  };
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    // Native CSP blocks external resources without intercepting/copying frame uploads.
    await context.addInitScript(() => {
      window.__exportBlockedOrigins = [];
      document.addEventListener('securitypolicyviolation', event => {
        if (/^https?:/.test(event.blockedURI)) window.__exportBlockedOrigins.push(event.blockedURI);
      });
    });
    const page = await context.newPage();
    const assertLocal = async () => {
      const blocked = await page.evaluate(() => window.__exportBlockedOrigins);
      if (blocked.length) throw new AppError('error.exportNetwork', { origin: new URL(blocked[0]).origin });
    };
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(() => typeof window.renderFrame === 'function');
    await page.evaluate(data => { window.exportManifest = data; }, manifest);
    await assertLocal();
    return { page, origin, assertLocal, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function exportVideo({ manifest, output, audioPath, ffmpegPath = 'ffmpeg', onProgress = () => {} }) {
  // Snapshot before the first await: concurrent analysis cannot change this export.
  manifest = structuredClone(manifest);
  if (!(manifest.duration > 0 && Number.isFinite(manifest.duration))) throw new AppError('error.invalidDuration');
  if (existsSync(output)) throw new AppError('error.outputExists');
  try { execFileSync(ffmpegPath, ['-version'], { stdio: 'ignore', timeout: 5000 }); }
  catch { throw new AppError('error.ffmpegMissing'); }
  mkdirSync(dirname(output), { recursive: true });
  let session, encoder, encoderDone;
  let stderr = '', pipeError;
  try {
    const frames = Math.max(1, Math.round(manifest.duration * FPS));
    let completed = 0;
    session = await createExportPage(manifest, { onFrame: async pixels => {
      if (pipeError || encoder.exitCode !== null) throw new AppError('error.encoding');
      if (!encoder.stdin.write(pixels)) await once(encoder.stdin, 'drain');
      onProgress(++completed, frames);
    } });
    const audioArgs = audioPath ? ['-protocol_whitelist', 'file,pipe', '-stream_loop', '-1', '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-t', String(frames / FPS)] : ['-an'];
    encoder = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '1920x1080', '-framerate', String(FPS), '-i', 'pipe:0', ...audioArgs, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { stdio: ['pipe', 'ignore', 'pipe'] });
    encoderDone = new Promise(done => { encoder.once('error', error => done({ error })); encoder.once('close', code => done({ code })); });
    encoder.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    encoder.stdin.on('error', error => { pipeError = error; });
    const rendered = await session.page.evaluate(async ({ frames, fps, duration }) => {
      let state;
      for (let frame = 0; frame < frames; frame++) {
        const time = frame === frames - 1 ? duration : frame / fps;
        state = window.renderFrame(window.exportManifest, time);
        const pixels = document.querySelector('#scene').getContext('2d').getImageData(0, 0, 1920, 1080).data;
        // Blob avoids copying the binary request body through Playwright's protocol.
        const response = await fetch('/frame', { method: 'POST', body: new Blob([pixels.buffer]) });
        if (!response.ok) return { written: false };
      }
      return { written: true, ...state };
    }, { frames, fps: FPS, duration: manifest.duration });
    await session.assertLocal();
    if (!rendered.written || pipeError || encoder.exitCode !== null) throw new Error(stderr || 'FFmpeg 提前退出', { cause: new AppError('error.encoding') });
    const { churn: finalChurn, retainedLines: finalRetainedLines } = rendered;
    encoder.stdin.end();
    const result = await encoderDone;
    if (result.error || result.code !== 0) throw new Error(stderr || result.error?.message || 'FFmpeg 编码失败', { cause: new AppError('error.encoding') });
    if (finalChurn !== manifest.totalChurn) throw new AppError('error.finalChurn');
    if([1,2].includes(manifest.retention?.version) && finalRetainedLines!==manifest.retention.mappedLines)throw new AppError('error.finalRetention');
    await session.assertLocal();
    return { frames, finalChurn, ...([1,2].includes(manifest.retention?.version) ? {finalRetainedLines} : {}) };
  } catch (error) {
    if (encoder && encoder.exitCode === null) encoder.kill('SIGKILL');
    if (encoderDone) await encoderDone;
    rmSync(output, { force: true });
    const wrapped = new Error(`导出失败：${error.message}`, { cause: error });
    wrapped.code = error.code || error.cause?.code; wrapped.params = error.params || error.cause?.params;
    throw wrapped;
  } finally { await session?.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input = existsSync('.cache/current/manifest.json') ? '.cache/current/manifest.json' : 'data/manifest.json', output = `exports/git-history-${Date.now()}.mp4`] = process.argv.slice(2);
  try {
    const result = await exportVideo({ manifest: JSON.parse(readFileSync(input, 'utf8')), output: resolve(output), onProgress: (frame, total) => { if (frame % FPS === 0 || frame === total) process.stdout.write(`\r导出 ${frame}/${total} 帧`); } });
    console.log(`\n已生成 ${output}，最终改动量 ${result.finalChurn}${result.finalRetainedLines===undefined ? "" : `，最终存留量 ${result.finalRetainedLines}`}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
