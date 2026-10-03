import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { serverFixture } from './helpers/server.mjs';

function fakeOpen(t, exit=0) {
  const bin=mkdtempSync(join(tmpdir(),'history-open-'));
  t.after(()=>rmSync(bin,{recursive:true,force:true}));
  const log=join(bin,'opened.txt');
  writeFileSync(join(bin,'open'),`#!/bin/sh\nprintf '%s' "$1" > "$OPEN_LOG"\nexit ${exit}\n`,{mode:0o755});
  return {log,env:{PATH:`${bin}:${process.env.PATH}`,OPEN_LOG:log}};
}

async function waitFor(predicate) {
  const deadline=Date.now()+3000;
  while(!predicate()){assert(Date.now()<deadline,'等待启动结果超时');await setTimeout(10);}
}

test('macOS startup opens the HTTP address using the configured port',{skip:process.platform!=='darwin',timeout:10000},async(t)=>{
  const opener=fakeOpen(t),f=await serverFixture(t,opener.env,[]);
  await waitFor(()=>existsSync(opener.log));
  assert.equal(readFileSync(opener.log,'utf8'),`${f.origin}/`);
  assert.equal((await fetch(f.origin)).status,200);
});

test('failed browser opening reports the address and keeps the server available',{skip:process.platform!=='darwin',timeout:10000},async(t)=>{
  const opener=fakeOpen(t,1),f=await serverFixture(t,opener.env,[]);
  await waitFor(()=>f.stderr.includes('无法自动打开浏览器'));
  assert(f.stderr.includes(`${f.origin}/`));assert.equal((await fetch(f.origin)).status,200);
});

test('--no-open suppresses browser launching',{timeout:10000},async(t)=>{
  const opener=fakeOpen(t),f=await serverFixture(t,opener.env);
  assert.equal((await fetch(f.origin)).status,200);
  await setTimeout(150);assert.equal(existsSync(opener.log),false);
});

test('a failed server startup never opens a browser',{timeout:10000},async(t)=>{
  const opener=fakeOpen(t),f=await serverFixture(t,opener.env);
  const child=spawn(process.execPath,[join(f.dir,'app','scripts/server.mjs')],{env:{...process.env,...opener.env,GIT_HISTORY_PORT:new URL(f.origin).port},stdio:['ignore','ignore','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let error='';child.stderr.on('data',chunk=>{error+=chunk;});
  const [code]=await once(child,'close');assert.notEqual(code,0);assert.match(error,/EADDRINUSE/);
  assert.equal(existsSync(opener.log),false);assert.equal((await fetch(f.origin)).status,200);
});
