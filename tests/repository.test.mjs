import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {serverFixture} from './helpers/server.mjs';
import {analyzeHistory} from '../scripts/analyze-history.mjs';
import {historyState} from '../src/visualizer.js';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();

test('ordinary, bare and worktree repositories have identical statistics',async t=>{
  const f=await serverFixture(t);
  f.git('checkout','-b','feature');writeFileSync(join(f.repo,'feature.js'),'feature\n');f.git('add','.');f.git('commit','-m','功能');
  f.git('checkout','main');f.git('merge','--no-ff','feature','-m','合并');
  writeFileSync(join(f.repo,'app.js'),'rewritten\nsecond\n');f.git('add','.');f.git('commit','-m','改写');
  const bare=join(f.dir,'bare.git'),worktree=join(f.dir,'worktree');
  execFileSync('git',['clone','--bare',f.repo,bare],{stdio:'pipe'});f.git('worktree','add',worktree,'main','--force');
  const ordinary=await analyzeHistory({repo:f.repo});
  for(const repo of [bare,worktree]) {
    const m=await analyzeHistory({repo});
    assert.deepEqual(m.commits,ordinary.commits);assert.deepEqual(m.retention,ordinary.retention);
    assert.equal(m.totalChurn,ordinary.totalChurn);assert.equal(m.totalLines,ordinary.totalLines);
    const final=historyState(m,m.duration);assert.equal(final.churn,m.totalChurn);assert.equal(final.retainedLines,m.retention.mappedLines);
  }
  const branches=await (await fetch(`${f.origin}/api/branches`,{method:'POST',body:JSON.stringify({source:bare})})).json();
  assert.equal(branches.shallow,false);assert(branches.branches.includes('main'));
  assert.equal((await f.analyze({source:bare})).totalChurn,ordinary.totalChurn);
});

test('shallow API and CLI refuse analysis, and unshallow rebuilds old same-HEAD caches',async t=>{
  const f=await serverFixture(t);f.git('config','user.name','B');f.git('config','user.email','b@test');writeFileSync(join(f.repo,'app.js'),'one\ntwo\n');f.git('add','.');f.git('commit','-m','追加');
  const shallow=join(f.dir,'shallow');execFileSync('git',['clone','--depth','1',pathToFileURL(f.repo).href,shallow],{stdio:'pipe'});
  const valid=await f.analyze({source:f.repo,accountLinks:{'b@test':'test@example.com'}}),saved=readFileSync(join(f.dir,'app/.cache/current/manifest.json'),'utf8');
  const post=(api,body)=>fetch(`${f.origin}/api/${api}`,{method:'POST',body:JSON.stringify(body)});
  assert.equal((await (await post('branches',{source:shallow})).json()).shallow,true);
  const rejected=await post('analyze',{source:shallow,branch:'main'});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/浅克隆.*git fetch --unshallow/);
  await assert.rejects(()=>analyzeHistory({repo:shallow,previousManifest:valid}),/浅克隆/);
  assert.throws(()=>execFileSync(process.execPath,['scripts/analyze-history.mjs',shallow,'main',join(f.dir,'out.json')],{stdio:'pipe'}),error=>/浅克隆/.test(error.stderr.toString()));
  assert.equal(readFileSync(join(f.dir,'app/.cache/current/manifest.json'),'utf8'),saved);
  const head=git(shallow,'rev-parse','HEAD');
  const localChanges='local unsaved changes\n';writeFileSync(join(shallow,'app.js'),localChanges);
  git(shallow,'remote','set-url','origin',join(f.dir,'missing-remote'));
  const failed=await post('unshallow',{source:shallow});assert.equal(failed.status,400);assert.match((await failed.json()).error,/补全历史失败/);
  assert.equal(git(shallow,'rev-parse','--is-shallow-repository'),'true');
  assert.equal(readFileSync(join(f.dir,'app/.cache/current/manifest.json'),'utf8'),saved);
  git(shallow,'remote','set-url','origin',pathToFileURL(f.repo).href);
  const completed=await post('unshallow',{source:shallow});assert.equal(completed.status,200);assert.deepEqual(await completed.json(),{ok:true});
  assert.equal(git(shallow,'rev-parse','HEAD'),head);assert.equal(readFileSync(join(shallow,'app.js'),'utf8'),localChanges);
  assert.equal((await post('unshallow',{source:shallow})).status,200);
  assert.equal((await post('unshallow',{source:'https://example.invalid/repo.git'})).status,400);
  assert.equal((await (await post('branches',{source:shallow})).json()).shallow,false);
  const old=structuredClone(valid);old.project.repo=shallow;delete old.rules.historyCompleteness;
  old.totalChurn=999;old.totalLines=999;old.retention.totalLines=999;
  old.settings.accountLinks={'b@test':'test@example.com'};
  old.commits[0].churn=998;
  const rebuilt=await analyzeHistory({repo:shallow,previousManifest:old});
  assert.equal(rebuilt.analysis.cacheHit,false);assert.equal(rebuilt.analysis.incremental,false);assert.equal(rebuilt.analysis.retentionCacheHit,false);
  assert.deepEqual(rebuilt.commits,valid.commits);assert.deepEqual(rebuilt.retention,valid.retention);assert.equal(rebuilt.totalChurn,valid.totalChurn);assert.equal(rebuilt.totalLines,valid.totalLines);
  assert.deepEqual(rebuilt.layout,valid.layout);assert.deepEqual(rebuilt.settings.accountLinks,old.settings.accountLinks);
  const cached=await analyzeHistory({repo:shallow,previousManifest:rebuilt});assert(cached.analysis.cacheHit);assert(cached.analysis.retentionCacheHit);
});
