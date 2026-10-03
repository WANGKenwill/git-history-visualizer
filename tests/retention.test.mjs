import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {analyzeHistory} from '../scripts/analyze-history.mjs';
import {analyzeRetention} from '../scripts/retention.mjs';
import {historyState,prepareHistory,drawHistory} from '../src/visualizer.js';

function fixture(t) {
  const repo=mkdtempSync(join(tmpdir(),'retention-'));t.after(()=>rmSync(repo,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','A');git('config','user.email','a@test');
  const write=(file,body)=>{mkdirSync(dirname(join(repo,file)),{recursive:true});writeFileSync(join(repo,file),body);};
  let serial=0;
  const commit=()=>{git('add','-A');git('commit','--allow-empty','-m',`测试提交 ${++serial}`);return git('rev-parse','HEAD');};
  return {repo,git,write,commit};
}
function check(m) {
  const sum=m.commits.reduce((s,c)=>s+c.retainedLines,0);
  assert.equal(sum,m.authors.reduce((s,a)=>s+a.retainedLines,0));
  assert.equal(sum,m.retention.mappedLines);assert.equal(sum+m.retention.unmappedLines,m.retention.totalLines);
  for(const c of m.commits)assert(c.retainedLines>=0&&c.retainedLines<=c.churn);
  assert.equal(historyState(m,m.duration).retainedLines,sum);
}

test('rewrites and deletions update earlier retention; renamed files, blank lines and no newline are counted',t=>{
  const f=fixture(t);f.write('old.txt','a\n\nb');const first=f.commit();
  const before=analyzeHistory({repo:f.repo,duration:15});assert.equal(before.retention.totalLines,3);
  f.git('mv','old.txt','new.txt');const rename=f.commit();
  f.git('config','user.name','B');f.git('config','user.email','b@test');f.write('new.txt','changed\n\nb\nnew\n');const rewrite=f.commit();
  const m=analyzeHistory({repo:f.repo,previousManifest:before,duration:15});check(m);
  assert.equal(m.commits.find(c=>c.sha===first).retainedLines,1);assert.equal(m.commits.find(c=>c.sha===rename).retainedLines,0);assert.equal(m.commits.find(c=>c.sha===rewrite).retainedLines,3);
  f.write('new.txt','changed\nnew\n');f.commit();const deleted=analyzeHistory({repo:f.repo,previousManifest:m});check(deleted);
  assert.equal(deleted.commits.find(c=>c.sha===first).retainedLines,0);assert.equal(deleted.retention.totalLines,2);
});

test('Unicode, tabs, newlines, binary and files originally excluded preserve exact paths',t=>{
  const f=fixture(t);for(const name of ['中文.txt','a\tb.txt','a\nb.txt','a"b.txt'])f.write(name,'one\ntwo');
  f.write('vendor/old.txt','ignored\n');f.write('blob.bin',Buffer.from([0,1,2]));const first=f.commit();
  f.git('mv','vendor/old.txt','imported.txt');f.commit();const m=analyzeHistory({repo:f.repo});check(m);
  assert.equal(m.retention.totalLines,9);assert.equal(m.retention.unmappedLines,1);assert.equal(m.commits.find(c=>c.sha===first).retainedLines,8);
});

test('merge resolution stays unmapped, ordinary branch commits map, squash only attributes the surviving commit',t=>{
  const f=fixture(t);f.write('conflict.txt','base\n');f.commit();
  f.git('checkout','-b','feature');f.write('conflict.txt','feature\n');f.write('feature.txt','kept\n');const feature=f.commit();
  f.git('checkout','main');f.write('conflict.txt','main\n');f.commit();
  assert.throws(()=>f.git('merge','--no-ff','feature','-m','合并'));f.write('conflict.txt','resolved\n');const merge=f.commit();
  let m=analyzeHistory({repo:f.repo});check(m);assert.equal(m.retention.unmappedLines,1);assert.equal(m.commits.find(c=>c.sha===feature).retainedLines,1);assert(!m.commits.some(c=>c.sha===merge));
  f.git('checkout','-b','squash');f.write('squash.txt','squash\n');const lost=f.commit();f.git('checkout','main');f.git('merge','--squash','squash');const kept=f.commit();
  m=analyzeHistory({repo:f.repo,previousManifest:m});check(m);assert(!m.commits.some(c=>c.sha===lost));assert.equal(m.commits.find(c=>c.sha===kept).retainedLines,1);
});

test('cache reuse ignores display settings; legacy retention is rebuilt; changed head and exclusions invalidate',t=>{
  const f=fixture(t);f.write('a.txt','a\n');f.commit();let m=analyzeHistory({repo:f.repo});
  const cached=analyzeHistory({repo:f.repo,previousManifest:m,duration:15,timeZone:'UTC',maxAuthors:1});assert(cached.analysis.retentionCacheHit);
  const old=structuredClone(m);delete old.retention;for(const c of old.commits)delete c.retainedLines;
  const rebuilt=analyzeHistory({repo:f.repo,previousManifest:old});assert(!rebuilt.analysis.retentionCacheHit);assert(rebuilt.analysis.cacheHit);check(rebuilt);
  f.write('a.txt','updated\n');f.commit();m=analyzeHistory({repo:f.repo,previousManifest:m});assert(!m.analysis.retentionCacheHit);check(m);
  f.git('reset','--hard','HEAD~1');const reset=analyzeHistory({repo:f.repo,previousManifest:m});assert(!reset.analysis.retentionCacheHit);check(reset);
  const excluded=analyzeHistory({repo:f.repo,previousManifest:reset,excludes:['**/*.txt']});assert(!excluded.analysis.retentionCacheHit);assert.equal(excluded.retention.totalLines,0);
  const unchanged=structuredClone(m);assert.throws(()=>analyzeRetention(f.repo,'invalid',[], '[]',()=>false,m));assert.deepEqual(m,unchanged);
});

test('inner area shares the churn scale, follows absorption growth, aliases and other; seeking is deterministic',t=>{
  const f=fixture(t);f.write('a.txt','a\nb\n');f.commit();f.git('config','user.name','B');f.git('config','user.email','b@test');f.write('b.txt','c\n');f.commit();
  const m=analyzeHistory({repo:f.repo,duration:15,accountLinks:{'b@test':'a@test'}});const scene=prepareHistory(m);assert.equal(scene.nodes.length,1);
  const arrival=scene.arrivals[0].arrival;assert.equal(historyState(m,arrival-.01).retainedLines,0);assert.equal(historyState(m,arrival).nodes[0].visualRetainedLines,0);
  const mid=historyState(m,arrival+.175).nodes[0];assert(Math.abs(mid.visualRetainedLines-scene.arrivals[0].retainedLines*.5)<1e-8);
  const final=historyState(m,15).nodes[0];assert.equal(final.retainedLines,3);assert.equal(final.finalRetainedLines,3);
  const circles=[];const ctx=new Proxy({arc(x,y,r){circles.push(r);},createRadialGradient:()=>({addColorStop(){}}),measureText:text=>({width:text.length*9})},{get:(o,k)=>k in o?o[k]:()=>{}});
  drawHistory(ctx,m,15);assert(circles.some(r=>Math.abs(r-final.radius*Math.sqrt(final.visualRetainedLines/final.finalChurn))<1e-8));
  const direct=historyState(m,5);for(let time=0;time<15;time+=.1)historyState(m,time);assert.deepEqual(historyState(m,5),direct);historyState(m,1);assert.deepEqual(historyState(m,5),direct);
  const other=analyzeHistory({repo:f.repo,previousManifest:m,accountLinks:{},maxAuthors:1});assert.equal(prepareHistory(other).nodes.find(n=>n.id==='__other__').retainedLines,1);check(other);
  const legacy=structuredClone(m);delete legacy.retention;assert.equal(historyState(legacy,15).retentionAvailable,false);
});

test('33-node dense history renders zero cores, preserves motion, and totals exactly at the end',()=>{
  const authors=Array.from({length:33},(_,i)=>({id:`p${i}`,name:'很长的开发者姓名'.repeat(3),churn:i+1,retainedLines:Math.floor((i+1)/2),color:'#79dce8'}));
  const commits=authors.map((a,i)=>({sha:`s${i}`,authorId:a.id,churn:a.churn,retainedLines:a.retainedLines,additions:a.churn,deletions:0,authoredAt:'2020-01-01T00:00:00Z',at:.6,groupIds:[]}));
  for(let i=0;i<40;i++)commits.push({...commits[0],sha:`dense${i}`,at:.6+i*.001,churn:1,additions:1,retainedLines:i%2});
  authors[0].churn+=40;authors[0].retainedLines+=20;
  const mapped=authors.reduce((s,a)=>s+a.retainedLines,0),m={authors,commits,duration:15,settings:{maxAuthors:32,timeZone:'UTC'},project:{name:'sample',branch:'main'},totalChurn:authors.reduce((s,a)=>s+a.churn,0),retention:{version:1,totalLines:mapped,mappedLines:mapped,unmappedLines:0}};
  const legacy=structuredClone(m);delete legacy.retention;
  assert.deepEqual(prepareHistory(m).motion.positions,prepareHistory(legacy).motion.positions);
  const final=historyState(m,15);assert.equal(final.retainedLines,mapped);assert.equal(final.churn,m.totalChurn);assert.equal(final.nodes.length,33);
  for(const n of final.nodes)assert(n.visualRetainedLines<=n.visualChurn);
  const ops=[];const ctx=new Proxy({arc(x,y,r){ops.push([x,y,r]);},createRadialGradient:()=>({addColorStop(){}}),measureText:text=>({width:text.length*9})},{get:(o,k)=>k in o?o[k]:()=>{}});
  drawHistory(ctx,m,15);const first=structuredClone(ops);ops.length=0;drawHistory(ctx,m,4);ops.length=0;drawHistory(ctx,m,15);assert.deepEqual(ops,first);
});


test('symlinks and submodules are not text files in the retention inventory',t=>{
  const f=fixture(t);f.write('regular.txt','one\n');f.commit();symlinkSync('regular.txt',join(f.repo,'link'));f.commit();
  f.git('update-index','--add','--cacheinfo',`160000,${f.git('rev-parse','HEAD')},submodule`);f.git('commit','-m','添加子模块指针');
  const m=analyzeHistory({repo:f.repo});check(m);assert.equal(m.retention.totalLines,1);
});
