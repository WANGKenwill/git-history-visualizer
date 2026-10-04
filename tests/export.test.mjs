import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createExportPage, exportVideo } from '../scripts/export-video.mjs';

const empty = { version: 2, project: { name: '离线测试', branch: 'main' }, duration: 0.2, commits: [], groups: [], authors: [], settings: { timeZone: 'Asia/Shanghai', maxAuthors: 16 }, totalChurn: 0 };

test('binary export frames preserve exact Canvas pixels and await the encoder sink', async () => {
  let received, written = false;
  const session = await createExportPage(empty, { onFrame: async pixels => {
    received = pixels;
    await new Promise(done => setTimeout(done, 10));
    written = true;
  } });
  try {
    const result = await session.page.evaluate(async () => {
      window.renderFrame(window.exportManifest, 0);
      const pixels = document.querySelector('#scene').getContext('2d').getImageData(0, 0, 1920, 1080).data;
      const digest = await crypto.subtle.digest('SHA-256', pixels);
      const response = await fetch('/frame', { method: 'POST', body: new Blob([pixels.buffer]) });
      return { ok: response.ok, hash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
    });
    assert.equal(result.ok, true);
    assert.equal(written, true);
    assert.equal(received.length, 1920 * 1080 * 4);
    assert.equal(createHash('sha256').update(received).digest('hex'), result.hash);
    const invalid = await session.page.evaluate(async () => (await fetch('/frame', { method: 'POST', body: new Blob(['truncated']) })).status);
    assert.equal(invalid, 400);
  } finally { await session.close(); }
});

test('soundtrack exports loop short audio and trim long audio without changing frames or totals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soundtrack-export-'));
  try {
    const manifest = { ...empty, duration: 2, totalChurn: 3,
      authors: [{ id: 'a', name: 'Author', churn: 3, retainedLines: 1 }],
      commits: [{ sha: 'a', authorId: 'a', authoredAt: '2026-01-01T00:00:00Z', at: 0, churn: 3, additions: 2, deletions: 1, retainedLines: 1 }],
      retention: { version: 2, totalLines: 1, mappedLines: 1, unmappedLines: 0 } };
    for (const duration of [0.5, 3]) {
      const audioPath = join(dir, `${duration}.wav`), output = join(dir, `${duration}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`, audioPath]);
      assert.deepEqual(await exportVideo({ manifest, output, audioPath }), { frames: 60, finalChurn: 3, finalRetainedLines: 1 });
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
      const video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio');
      assert.equal(video.codec_name, 'h264'); assert.equal(Number(video.nb_frames), 60);
      assert.equal(audio.codec_name, 'aac'); assert(Math.abs(Number(audio.duration) - 2) < 1 / 30);
      assert(Math.abs(Number(probe.format.duration) - 2) < 1 / 30);
      execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
      const tail = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.7', '-i', output, '-map', '0:a:0', '-t', '0.2', '-ac', '1', '-f', 'f32le', 'pipe:1']);
      let energy = 0;
      for (let i = 0; i + 4 <= tail.length; i += 4) energy += tail.readFloatLE(i) ** 2;
      assert(tail.length > 0 && Math.sqrt(energy / (tail.length / 4)) > 0.01, 'audio remains audible beyond the first loop');
    }
    const broken = join(dir, 'bad.wav'); writeFileSync(broken, 'invalid audio');
    const output = join(dir, 'bad.mp4');
    await assert.rejects(exportVideo({ manifest, output, audioPath: broken }), /导出失败/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export page matches interactive Canvas pixels and blocks external requests', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url)));
  const assets = new Map([
    ['/studio.html', ['text/html', readFileSync(new URL('../studio.html', import.meta.url))]],
    ['/src/i18n.js', ['text/javascript', readFileSync(new URL('../src/i18n.js', import.meta.url))]],
    ['/src/studio.js', ['text/javascript', readFileSync(new URL('../src/studio.js', import.meta.url))]],
    ['/src/visualizer.js', ['text/javascript', readFileSync(new URL('../src/visualizer.js', import.meta.url))]],
    ['/src/motion.js', ['text/javascript', readFileSync(new URL('../src/motion.js', import.meta.url))]],
    ['/src/accounts.js', ['text/javascript', readFileSync(new URL('../src/accounts.js', import.meta.url))]],
    ['/src/timeline.js', ['text/javascript', readFileSync(new URL('../src/timeline.js', import.meta.url))]],
    ['/data/manifest.js', ['text/javascript', `window.__GIT_MANIFEST__ = ${JSON.stringify(manifest)};`]],
  ]);
  let forbiddenRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/offline-test') forbiddenRequests++;
    const asset = assets.get(request.url); response.writeHead(asset ? 200 : 404, { 'content-type': asset?.[0] || 'text/plain' }); response.end(asset?.[1]);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let session, previewContext;
  try {
    session = await createExportPage(manifest);
    previewContext = await session.page.context().browser().newContext({locale:"zh-CN"});
    const preview = await previewContext.newPage();
    await preview.goto(`http://127.0.0.1:${server.address().port}/studio.html`);
    await preview.waitForFunction(() => document.querySelector('#summary strong')?.textContent !== '');
    const pixelHash = async (page, selector) => page.evaluate(async selector => {
      const canvas = document.querySelector(selector);
      const pixels = canvas.getContext('2d').getImageData(0, 0, 1920, 1080).data;
      const digest = await crypto.subtle.digest('SHA-256', pixels);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }, selector);
    for (const locale of ['zh-CN', 'en']) {
      await preview.locator('#language').selectOption(locale);
      await session.page.evaluate(locale => { window.exportManifest = { ...window.exportManifest, settings: { ...window.exportManifest.settings, locale } }; }, locale);
      for (const time of [0, manifest.duration / 2, manifest.duration]) {
        await session.page.evaluate(time => window.renderFrame(window.exportManifest, time), time);
        await preview.locator('#scrub').evaluate((el, time) => { el.value = time; el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
        assert.equal(await pixelHash(session.page, '#scene'), await pixelHash(preview, '#preview'), `${locale} at ${time}`);
      }
    }
    const reached = await session.page.evaluate(async () => { try { await fetch('https://example.com/offline-test'); return true; } catch { return false; } });
    assert.equal(reached, false);
    const otherOrigin = `http://127.0.0.1:${server.address().port}/offline-test`;
    assert.equal(await session.page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, otherOrigin), false);
    assert.equal(forbiddenRequests, 0, 'CSP must block requests before they reach another server');
    await assert.rejects(session.assertLocal, /外网.*阻止/);
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


test('Chinese and English MP4 snapshots decode with identical final contribution and retention totals',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bilingual-export-'));
  try {
    for (const locale of ['zh-CN','en']) {
      const manifest={...empty,duration:2,settings:{...empty.settings,locale},totalChurn:3,
        authors:[{id:'a',name:'Original author',churn:3,retainedLines:1}],
        commits:[{sha:'a',authorId:'a',authoredAt:'2026-01-01T00:00:00Z',at:0,churn:3,additions:2,deletions:1,retainedLines:1}],
        retention:{version:2,totalLines:1,mappedLines:1,unmappedLines:0}};
      const output=join(dir,`${locale}.mp4`);
      assert.deepEqual(await exportVideo({manifest,output}),{frames:60,finalChurn:3,finalRetainedLines:1});
      const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output]));
      assert.equal(Number(probe.format.duration),2);assert.equal(Number(probe.streams[0].nb_frames),60);
      execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-'],{stdio:'pipe'});
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
