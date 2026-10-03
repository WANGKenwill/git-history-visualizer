import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
