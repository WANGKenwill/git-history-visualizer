import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { serverFixture } from './helpers/server.mjs';

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert(Date.now() < deadline, 'expected server log was not received');
    await nextTurn();
  }
}

test('browser icon and DevTools probes do not produce access denied stack traces', async t => {
  const f = await serverFixture(t);
  for (const method of ['GET', 'HEAD']) {
    for (const [path, status] of [['/favicon.ico', 204], ['/.well-known/appspecific/com.chrome.devtools.json', 404]]) {
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${f.origin}${path}`, { method });
        assert.equal(response.status, status, `${method} ${path}`);
        assert.equal(await response.text(), '');
      }
    }
  }
  const denied = await fetch(`${f.origin}/package.json`);
  assert.equal(denied.status, 403);
  await waitFor(() => f.stderr.includes('/package.json'));
  assert.equal(f.stderr.trim(), '[http] GET /package.json 403 error.forbidden');
});

test('expected static errors log method, pathname and status without stack traces or query secrets', async t => {
  const f = await serverFixture(t), app = join(f.dir, 'app');
  mkdirSync(join(app, '.git')); writeFileSync(join(app, '.git/config'), 'private');
  symlinkSync(join(app, '.git/config'), join(app, 'exports/linked.mp4'));
  for (const path of ['/.git/config', '/scripts/server.mjs', '/exports/linked.mp4']) {
    const response = await fetch(`${f.origin}${path}?token=must-not-be-logged`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errorCode, 'error.forbidden');
  }
  assert.equal((await fetch(`${f.origin}/exports/missing.mp4`)).status, 404);
  const response = await fetch(`${f.origin}/src/studio.js`, { method: 'POST' });
  assert.equal(response.status, 405);
  await waitFor(() => f.stderr.includes('POST /src/studio.js'));
  const lines = f.stderr.trim().split('\n');
  assert.equal(lines.length, 5);
  assert(lines.every(line => /^\[http\] (GET|POST) \/\S+ (403|404|405) error\.(forbidden|notFound|method)$/.test(line)));
  assert(!f.stderr.includes('must-not-be-logged'));
  assert(!f.stderr.includes('AppError:'));
  assert(!f.stderr.includes('at Server.'));
  assert.equal((await fetch(f.origin)).status, 200);
  assert.equal((await fetch(`${f.origin}/src/studio.js`)).status, 200);
});

test('unhandled request errors still retain diagnostic stack traces', async t => {
  const f = await serverFixture(t);
  const response = await fetch(`${f.origin}/%zz`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, 'error.unknown');
  await waitFor(() => f.stderr.includes('URIError:'));
  assert(f.stderr.includes('at decodeURIComponent'));
});
