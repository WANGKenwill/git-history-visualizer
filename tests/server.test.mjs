import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { serverFixture as fixture } from './helpers/server.mjs';

test('local Git worktrees can be analyzed through Studio API',{timeout:20000},async(t)=>{
  const f=await fixture(t);
  const worktree=join(f.dir,'worktree');
  f.git('worktree','add','--detach',worktree);
  const m=await f.analyze({source:worktree});
  assert.equal(m.project.head,f.git('rev-parse','HEAD'));
  assert.equal(m.totalChurn,1);
});

test('export API uses the submitted snapshot instead of the latest analyzed history',{timeout:20000},async(t)=>{
  const f=await fixture(t);
  const snapshot=await f.analyze({source:f.repo});
  snapshot.duration=3;snapshot.commits[0].at=0;
  snapshot.commits[0].subject='用于验证超过旧请求上限的历史快照'.repeat(4000);
  writeFileSync(join(f.repo,'app.js'),'one\ntwo\n');f.git('add','.');f.git('commit','-m','追加历史');
  const latest=await f.analyze({source:f.repo});
  assert.equal(snapshot.totalChurn,1);assert.equal(latest.totalChurn,2);
  const response=await fetch(`${f.origin}/api/export`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({manifest:snapshot})});
  const result=await response.json();assert.equal(response.status,200,result.error);
  const output=join(f.dir,'app',result.file);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=nb_frames','-of','json',output],{encoding:'utf8'}));
  assert.equal(Number(probe.format.duration),3);assert.equal(Number(probe.streams[0].nb_frames),90);
  execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-'],{stdio:'pipe'});
  const missing=await fetch(`${f.origin}/api/export`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(missing.status,400);assert.match((await missing.json()).error,/manifest/);
});

test('streaming exports report progress, preserve JSON errors and clean up failed videos',{timeout:20000},async(t)=>{
  const f=await fixture(t), snapshot=await f.analyze({source:f.repo});
  snapshot.duration=3;snapshot.commits[0].at=0;
  const post=manifest=>fetch(`${f.origin}/api/export`,{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({manifest})});
  const missing=await post(null);assert.equal(missing.status,400);assert.match(missing.headers.get('content-type'),/application\/json/);
  const invalid=await post({...snapshot,duration:0});assert.equal(invalid.status,400);assert.match(invalid.headers.get('content-type'),/application\/json/);
  const response=await post(snapshot);assert.match(response.headers.get('content-type'),/application\/x-ndjson/);
  const reader=response.body.getReader(), first=await reader.read();
  const initial=Buffer.from(first.value).toString('utf8');assert.equal(JSON.parse(initial.trim()).type,'start');
  const conflict=await post(snapshot);assert.equal(conflict.status,409);assert.match(conflict.headers.get('content-type'),/application\/json/);
  let body=initial;
  while(true){const {done,value}=await reader.read();if(done)break;body+=Buffer.from(value).toString('utf8');}
  const events=body.trim().split('\n').map(line=>JSON.parse(line)),progress=events.filter(e=>e.type==='progress');
  assert.deepEqual(progress[0],{type:'progress',frame:1,total:90});assert.deepEqual(progress.at(-1),{type:'progress',frame:90,total:90});
  assert(progress.every((e,i)=>e.total===90&&(i===0||e.frame>progress[i-1].frame)));
  assert.equal(events.at(-1).type,'complete');
  const output=join(f.dir,'app',events.at(-1).file);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=nb_frames','-of','json',output],{encoding:'utf8'}));
  assert.equal(Number(probe.format.duration),3);assert.equal(Number(probe.streams[0].nb_frames),90);
  execFileSync('ffmpeg',['-v','error','-i',output,'-f','null','-'],{stdio:'pipe'});
  const failed=await post({...snapshot,duration:.2});
  const failure=(await failed.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(failure[0].type,'start');assert.equal(failure.at(-1).type,'error');assert.match(failure.at(-1).error,/末帧累计量/);
  assert(!failure.some(e=>e.type==='complete'));
  const files=readdirSync(join(f.dir,'app','exports'));
  assert.deepEqual(files,[events.at(-1).file.split('/').at(-1)]);
});

test('streamed encoder failures emit an error and leave no incomplete MP4',{timeout:20000},async(t)=>{
  const bin=mkdtempSync(join(tmpdir(),'history-bad-encoder-'));t.after(()=>rmSync(bin,{recursive:true,force:true}));
  writeFileSync(join(bin,'ffmpeg'),'#!/bin/sh\nif [ "$1" = "-version" ]; then exit 0; fi\nfor arg do target="$arg"; done\nprintf broken > "$target"\nprintf "test encoding failure" >&2\nexit 1\n',{mode:0o755});
  const f=await fixture(t,{PATH:`${bin}:${process.env.PATH}`}),manifest=await f.analyze({source:f.repo});
  manifest.duration=3;manifest.commits[0].at=0;
  const response=await fetch(`${f.origin}/api/export`,{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({manifest})});
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events[0].type,'start');assert.equal(events.at(-1).type,'error');assert.match(events.at(-1).error,/导出失败/);
  assert(!events.some(e=>e.type==='complete'));assert.deepEqual(readdirSync(join(f.dir,'app','exports')),[]);
});

test('remote refresh reuses downloaded history and analyzes new commits',{timeout:20000},async(t)=>{
  const f=await fixture(t), remote=join(f.dir,'remote.git');
  execFileSync('git',['clone','--bare',f.repo,remote],{stdio:'pipe'});
  const publish=()=>execFileSync('git',['--git-dir',remote,'update-server-info'],{stdio:'pipe'});
  publish();
  const oldHead=f.git('rev-parse','HEAD');
  const oldObject=`/repo.git/objects/${oldHead.slice(0,2)}/${oldHead.slice(2)}`;
  let oldDownloads=0;
  const remoteServer=createServer((request,response)=>{
    if(request.method==='GET'&&request.url===oldObject)oldDownloads++;
    try {response.end(readFileSync(join(remote,new URL(request.url,'http://localhost').pathname.slice('/repo.git/'.length))));}
    catch {response.writeHead(404);response.end();}
  });
  await new Promise(done=>remoteServer.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>remoteServer.close(done)));
  const source=`http://127.0.0.1:${remoteServer.address().port}/repo.git`;
  const first=await f.analyze({source});
  assert.equal(first.totalChurn,1);assert.equal(oldDownloads,1);
  f.git('config','user.name','B');f.git('config','user.email','b@test');
  writeFileSync(join(f.repo,'app.js'),'one\ntwo\n');f.git('add','.');f.git('commit','-m','second');
  f.git('push',remote,'main');publish();
  const refreshed=await f.analyze({source});
  assert.equal(refreshed.project.head,f.git('rev-parse','HEAD'));
  assert.equal(refreshed.totalChurn,2);assert.equal(refreshed.totalLines,2);
  assert.equal(oldDownloads,1,'already downloaded commits should not be downloaded again');
  assert.equal(refreshed.analysis.incremental,true);
  assert.equal((await f.analyze({source})).analysis.cacheHit,true);
  await t.test('legacy remote cache retains its saved account associations',async()=>{
    const links={'b@test':'test@example.com'};
    const legacy=await f.analyze({source,accountLinks:links});
    legacy.project.branch='main';delete legacy.rules.exclusionMatching;
    const cacheFile=branch=>join(f.dir,'app','.cache','manifests',`${createHash('sha256').update(`${source}\0${branch}`).digest('hex').slice(0,20)}.json`);
    writeFileSync(cacheFile('main'),JSON.stringify(legacy));
    rmSync(cacheFile('origin/main'),{force:true});
    const upgraded=await f.analyze({source});
    assert.deepEqual(upgraded.settings.accountLinks,links);
    assert.equal(upgraded.analysis.cacheHit,false);
    assert.equal((await f.analyze({source})).analysis.cacheHit,true);
  });
});
