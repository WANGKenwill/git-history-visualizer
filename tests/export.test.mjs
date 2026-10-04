import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createExportPage, exportVideo } from '../scripts/export-video.mjs';

const empty = { version: 2, project: { name: '离线测试', branch: 'main' }, duration: 0.2, commits: [], groups: [], authors: [], settings: { timeZone: 'Asia/Shanghai', maxAuthors: 16 }, totalChurn: 0 };

test('export page matches interactive Canvas pixels and blocks external requests', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
  const assets = new Map([
    ['/studio.html', ['text/html', readFileSync(new URL('../studio.html', import.meta.url))]],
    ['/src/studio.js', ['text/javascript', readFileSync(new URL('../src/studio.js', import.meta.url))]],
    ['/src/visualizer.js', ['text/javascript', readFileSync(new URL('../src/visualizer.js', import.meta.url))]],
    ['/src/motion.js', ['text/javascript', readFileSync(new URL('../src/motion.js', import.meta.url))]],
    ['/src/accounts.js', ['text/javascript', readFileSync(new URL('../src/accounts.js', import.meta.url))]],
    ['/data/manifest.js', ['text/javascript', `window.__GIT_MANIFEST__ = ${JSON.stringify(manifest)};`]],
  ]);
  const server = createServer((request, response) => {
    const asset = assets.get(request.url); response.writeHead(asset ? 200 : 404, { 'content-type': asset?.[0] || 'text/plain' }); response.end(asset?.[1]);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let session, previewContext;
  try {
    session = await createExportPage(manifest);
    previewContext = await session.page.context().browser().newContext();
    const preview = await previewContext.newPage();
    await preview.goto(`http://127.0.0.1:${server.address().port}/studio.html`);
    await preview.waitForFunction(() => document.querySelector('#summary strong')?.textContent !== '');
    const pixelHash = async (page, selector) => page.evaluate(async selector => {
      const canvas = document.querySelector(selector);
      const pixels = canvas.getContext('2d').getImageData(0, 0, 1920, 1080).data;
      const digest = await crypto.subtle.digest('SHA-256', pixels);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }, selector);
    for (const time of [0, manifest.duration / 2, manifest.duration]) {
      await session.page.evaluate(time => window.renderFrame(window.exportManifest, time), time);
      await preview.locator('#scrub').evaluate((el, time) => { el.value = time; el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
      assert.equal(await pixelHash(session.page, '#scene'), await pixelHash(preview, '#preview'));
    }
    const reached = await session.page.evaluate(async () => { try { await fetch('https://example.com/offline-test'); return true; } catch { return false; } });
    assert.equal(reached, false);
    assert.throws(session.assertLocal, /外网.*阻止/);
  } finally { await previewContext?.close(); await session?.close(); await new Promise(done => server.close(done)); }
});

test('local MP4 has correct frames and missing/broken encoders leave no partial file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-export-'));
  try {
    const output = join(dir, 'sample.mp4');
    const result = await exportVideo({ manifest: empty, output });
    assert.deepEqual(result, { frames: 6, finalChurn: 0 });
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
    assert.equal(probe.streams[0].width, 1920); assert.equal(probe.streams[0].height, 1080);
    assert.equal(probe.streams[0].codec_name, 'h264'); assert.equal(probe.streams[0].r_frame_rate, '30/1');
    assert.equal(Number(probe.format.duration), 0.2);
    execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-'], { stdio: 'pipe' });
    const missing = join(dir, 'missing.mp4');
    await assert.rejects(exportVideo({ manifest: empty, output: missing, ffmpegPath: join(dir, 'absent') }), /缺少.*FFmpeg/);
    assert.equal(existsSync(missing), false);
    const encoder = join(dir, 'bad-ffmpeg');
    writeFileSync(encoder, '#!/bin/sh\nif [ "$1" = "-version" ]; then exit 0; fi\nfor arg do target="$arg"; done\nprintf broken > "$target"\nprintf "test encoding failure" >&2\nexit 1\n', { mode: 0o755 });
    const broken = join(dir, 'broken.mp4');
    await assert.rejects(exportVideo({ manifest: empty, output: broken, ffmpegPath: encoder }), /导出失败/);
    assert.equal(existsSync(broken), false);
    const child = execFileSync(process.execPath, ['--input-type=module', '-e', `import { createExportPage } from ${JSON.stringify(new URL('../scripts/export-video.mjs', import.meta.url).href)}; try { await createExportPage({}); process.exitCode = 1; } catch(e) { if (!e.message.includes('缺少本地 Chromium')) throw e; console.log(e.message); }`], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, 'no-browser') }, encoding: 'utf8' });
    assert.match(child, /不会自动下载/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MP4 validates final retained totals and removes incomplete output on mismatch',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-export-'));
  try {
    const manifest={...empty,retention:{version:2,mappedLines:0,totalLines:0,unmappedLines:0}};
    const output=join(dir,'valid.mp4');
    assert.deepEqual(await exportVideo({manifest,output}),{frames:6,finalChurn:0,finalRetainedLines:0});
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-of','json',output]));
    assert.equal(Number(probe.format.duration),0.2);
    execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-'],{stdio:'pipe'});
    const broken=join(dir,'mismatch.mp4');
    await assert.rejects(exportVideo({manifest:{...manifest,retention:{...manifest.retention,mappedLines:1}},output:broken}),/最终存留量.*不一致/);
    assert.equal(existsSync(broken),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
