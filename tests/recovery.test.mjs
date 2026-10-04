import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serverFixture } from './helpers/server.mjs';

async function waitForTask(f, check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await (await fetch(`${f.origin}/api/export/status`)).json();
    if (check(result.task)) return result.task;
    await delay(50);
  }
  assert.fail('export did not reach the expected state');
}

test('disconnected audio export continues, protects audio and persists verified output', { timeout: 30000 }, async t => {
  const f = await serverFixture(t), manifest = await f.analyze({ source: f.repo });
  manifest.duration = 3; manifest.commits[0].at = 0;
  const wav = join(f.dir, 'sound.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', wav]);
  const bytes = readFileSync(wav);
  const audio = await (await fetch(`${f.origin}/api/audio`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes })).json();
  assert.equal((await (await fetch(`${f.origin}/api/audio/${audio.id}`)).json()).duration, 0.5);
  for (const [range, start, end] of [['bytes=0-99', 0, 99], ['bytes=100-', 100, bytes.length - 1], ['bytes=-100', bytes.length - 100, bytes.length - 1]]) {
    const response = await fetch(`${f.origin}/api/audio/${audio.id}/file`, { headers: { range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  assert.equal((await fetch(`${f.origin}/api/audio/${audio.id}/file`, { headers: { range: 'bytes=999999-' } })).status, 416);
  assert.equal((await fetch(`${f.origin}/api/audio/${audio.id}/file`, { method: 'HEAD' })).headers.get('content-length'), String(bytes.length));
  assert.equal((await fetch(`${f.origin}/api/audio/missing/file`)).status, 404);
  const controller = new AbortController();
  const response = await fetch(`${f.origin}/api/export`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ manifest, audioId: audio.id }) });
  const first = await response.body.getReader().read();
  const start = JSON.parse(Buffer.from(first.value).toString().trim());
  assert.equal(start.type, 'start'); assert(start.taskId);
  assert.equal((await fetch(`${f.origin}/api/audio/${audio.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await fetch(`${f.origin}/api/export`, { method: 'POST', body: '{}' })).status, 409);
  controller.abort();
  const done = await waitForTask(f, task => task?.stage === 'complete' || task?.stage === 'failed');
  assert.equal(done.stage, 'complete', JSON.stringify(done)); assert.equal(done.id, start.taskId);
  assert.equal(done.frame, 90); assert.equal(done.finalChurn, manifest.totalChurn);
  assert.equal(done.finalRetainedLines, manifest.retention.mappedLines);
  const output = join(f.dir, 'app', done.file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
  assert.equal(Number(probe.format.duration), 3); assert.equal(probe.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
  execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'app/.cache/current/export.json'))).stage, 'complete');
  await f.restart();
  assert.equal((await waitForTask(f, task => task?.stage === 'complete')).file, done.file);
  assert.equal((await fetch(`${f.origin}/api/audio/${audio.id}`)).status, 404);
  rmSync(output);
  const missing = await waitForTask(f, task => task?.stage === 'failed');
  assert.equal(missing.errorCode, 'error.exportFileMissing'); assert.equal(missing.file, undefined);
  await f.restart();
  assert.equal((await waitForTask(f, task => task?.stage === 'failed')).errorCode, 'error.exportFileMissing');
});

test('server restart marks unfinished saved tasks interrupted', async t => {
  const f = await serverFixture(t);
  writeFileSync(join(f.dir, 'app/.cache/current/export.json'), JSON.stringify({ id: 'unfinished', stage: 'rendering', frame: 3, total: 90 }));
  await f.restart();
  const task = await waitForTask(f, task => task?.stage === 'interrupted');
  assert.equal(task.id, 'unfinished'); assert.equal(task.errorCode, 'exportInterrupted');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'app/.cache/current/export.json'))).stage, 'interrupted');
});
