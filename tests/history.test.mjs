import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzeHistory } from '../scripts/analyze-history.mjs';
import { clockAngle, clockState, prepareHistory, historyState, drawHistory } from '../src/visualizer.js';

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'contribution-test-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding:'utf8' }).trim();
  git('init', '-b', 'main'); git('config','user.name','A'); git('config','user.email','a@test');
  const commit = (name, date, content, file='file.txt') => {
    if(content!==null){writeFileSync(join(repo,file),content);git('add',file);}
    execFileSync('git',['-C',repo,'commit','--allow-empty','-m',name],{env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date},stdio:'pipe'});
    return git('rev-parse','HEAD');
  };
  return {repo,git,commit,cleanup:()=>rmSync(repo,{recursive:true,force:true})};
}

test('reachable commits, merges, squash, stock and cached earlier additions', async () => {
  const f=fixture();
  try {
    const first=f.commit('first','2020-01-01T00:00:00+08:00','one\n');
    f.git('checkout','-b','feature');f.git('config','user.name','B');f.git('config','user.email','b@test');
    const feature=f.commit('feature','2020-01-02T06:30:00+08:00','two\n','feature.txt');
    f.git('checkout','main');f.git('merge','--no-ff','feature','-m','Merge feature');
    f.git('merge','feature');
    const merge=f.git('rev-parse','HEAD');
    f.git('checkout','-b','unmerged'); const unreachable=f.commit('unmerged','2020-01-03T00:00:00+08:00','ignored\n','unmerged.txt'); f.git('checkout','main');
    const before=(await analyzeHistory({repo:f.repo}));
    assert.deepEqual(new Set(before.commits.map(c=>c.sha)),new Set([first,feature]));
    assert(!before.commits.some(c=>[merge,unreachable].includes(c.sha)));
    assert.equal(before.totalChurn,2);assert.equal(before.totalLines,2);assert.equal(before.groups.length,0);
    assert.deepEqual(before.commits.find(c=>c.sha===feature).groupIds,[]);
    assert.equal(historyState(before,before.duration).churn,2);
    const cached=(await analyzeHistory({repo:f.repo,previousManifest:before,timeZone:'UTC',maxAuthors:1,duration:15}));
    assert(cached.analysis.cacheHit);assert.equal(cached.settings.timeZone,'UTC');assert.equal(cached.duration,15);
    const inserted=f.commit('older author date','2019-12-31T23:00:00+08:00','three\n','older.txt');
    const after=(await analyzeHistory({repo:f.repo,previousManifest:before}));
    assert.equal(after.commits[0].sha,inserted);assert(after.analysis.incremental);assert.equal(after.analysis.analyzedEvents,1);
    assert.equal(after.totalChurn,3);
    for(const author of before.authors){assert.equal(after.authors.find(a=>a.id===author.id).color,author.color);assert.deepEqual(after.layout[author.id],before.layout[author.id]);}
    const legacy=(await analyzeHistory({repo:f.repo,previousManifest:{version:1,project:before.project,events:[]}}));assert.equal(legacy.analysis.cacheHit,false);assert.equal(legacy.commits.length,3);
    f.git('checkout','-b','squashed');const lost=f.commit('squash source','2020-01-04T00:00:00+08:00','squash\n','squash.txt');f.git('checkout','main');f.git('merge','--squash','squashed');const squash=f.commit('squash result','2020-01-05T00:00:00+08:00',null);
    const zero=f.commit('empty','2020-01-06T00:00:00+08:00',null);
    const binary=f.commit('binary','2020-01-07T00:00:00+08:00',Buffer.from([0,1,2]),'blob.bin');
    const m=(await analyzeHistory({repo:f.repo,previousManifest:after}));
    assert(!m.commits.some(c=>c.sha===lost));assert(m.commits.some(c=>c.sha===squash));
    assert.equal(m.commits.find(c=>c.sha===zero).churn,0);assert.equal(m.commits.find(c=>c.sha===binary).churn,0);
    assert.equal(m.totalChurn,4);assert.equal(m.totalLines,4);
    assert.equal(historyState(m,m.duration).churn,m.authors.reduce((sum,a)=>sum+a.churn,0));
    const groups=prepareHistory({...m,settings:{...m.settings,maxAuthors:1}});assert(groups.nodes.some(n=>n.hiddenCount));
  } finally {f.cleanup();}
});

test('source names containing excluded directory names remain counted',async ()=>{
  const f=fixture();
  try {
    const kept=['app.js','distance.js','build-config.js','vendor-helper.js','src/distribution.js','src/foo.lock.js'];
    const ignored=['dist/output.js','src/dist/output.js','build/output.js','vendor/lib.js','node_modules/lib.js','coverage/out.js','.next/out.js','yarn.lock','pnpm-lock.yaml','package-lock.json','foo.lock','src/package-lock.json'];
    for(const file of [...kept,...ignored]){
      mkdirSync(dirname(join(f.repo,file)),{recursive:true});
      writeFileSync(join(f.repo,file),'one\n');
    }
    f.git('add','.');f.commit('sources and generated files','2020-01-01T00:00:00Z',null);
    const m=(await analyzeHistory({repo:f.repo}));
    assert.equal(m.commits[0].additions,6);
    assert.equal(m.totalChurn,6);assert.equal(m.totalLines,6);
    f.commit('remove source line','2020-01-02T00:00:00Z','','distance.js');
    const updated=(await analyzeHistory({repo:f.repo,previousManifest:m}));
    assert.equal(updated.commits[1].deletions,1);
    assert.equal(updated.totalChurn,7);assert.equal(updated.totalLines,5);
  }finally{f.cleanup();}
});

test('cached statistics from the old substring filter are rebuilt',async ()=>{
  const f=fixture();
  try {
    f.commit('source','2020-01-01T00:00:00Z','one\n','distance.js');
    const legacy=(await analyzeHistory({repo:f.repo}));
    delete legacy.rules.exclusionMatching;
    Object.assign(legacy.commits[0],{additions:0,churn:0});
    legacy.totalLines=0;
    const rebuilt=(await analyzeHistory({repo:f.repo,previousManifest:legacy}));
    assert.equal(rebuilt.totalChurn,1);assert.equal(rebuilt.totalLines,1);
    assert.equal(rebuilt.analysis.cacheHit,false);
    assert.equal((await analyzeHistory({repo:f.repo,previousManifest:rebuilt})).analysis.cacheHit,true);
  }finally{f.cleanup();}
});

test('same HEAD cache skips history queries, updates presentation and never mutates its input',async (t)=>{
  const f=fixture();
  try {
    f.commit('初始提交','2020-01-01T00:00:00Z','one\n');
    f.git('checkout','-b','feature');f.git('config','user.name','B');f.git('config','user.email','b@test');
    f.commit('功能提交','2020-01-02T00:00:00Z','two\n','b.txt');f.git('checkout','main');f.git('merge','--no-ff','feature','-m','合并功能');
    const original=(await analyzeHistory({repo:f.repo})), unchanged=structuredClone(original), calls=[];
    const real=childProcess.execFileSync;
    t.mock.method(childProcess,'execFileSync',(command,args,options)=>{if(command==='git')calls.push(args);return real(command,args,options);});
    syncBuiltinESMExports();
    try {
      const fresh=await analyzeHistory({repo:f.repo});
      assert.equal(fresh.groups.length,0);assert(!calls.some(args=>args.includes('rev-list')));
      calls.length=0;
      const linked=(await analyzeHistory({repo:f.repo,previousManifest:original,duration:15,timeZone:'UTC',maxAuthors:1,accountLinks:{'b@test':'a@test'},projectName:'缓存展示'}));
      assert(linked.analysis.cacheHit);assert(linked.analysis.retentionCacheHit);assert.equal(linked.analysis.analyzedEvents,0);
      assert.deepEqual(calls,[['-C',f.repo,'rev-parse','main^{commit}']]);
      assert.equal(linked.project.name,'缓存展示');assert.equal(linked.duration,15);assert.equal(linked.settings.timeZone,'UTC');assert.equal(linked.settings.maxAuthors,1);
      assert.deepEqual(linked.groups,original.groups);assert.equal(linked.totalLines,original.totalLines);assert.equal(linked.totalChurn,original.totalChurn);
      assert.deepEqual(linked.commits.map(({at,...c})=>c),original.commits.map(({at,...c})=>c));
      assert.notEqual(linked.commits[1].at,original.commits[1].at);assert.equal(prepareHistory(linked).authors.length,1);
      assert.deepEqual(original,unchanged);
      for(const version of [undefined,0]) {
        const old=structuredClone(original);if(version===undefined)delete old.retention;else old.retention.version=version;
        const before=structuredClone(old);calls.length=0;
        const rebuilt=(await analyzeHistory({repo:f.repo,previousManifest:old}));
        assert(rebuilt.analysis.cacheHit);assert(!rebuilt.analysis.retentionCacheHit);
        assert(!calls.some(args=>args.includes('log')||args.includes('rev-list')));
        assert(calls.some(args=>args.includes('ls-tree')));assert.deepEqual(rebuilt.retention,original.retention);assert.deepEqual(old,before);
      }
    } finally {t.mock.restoreAll();syncBuiltinESMExports();}
  } finally {f.cleanup();}
});

test('clock quadrants, half-hours, seconds and time zones',()=>{
  for(const [time,angle] of [['00:00:00',Math.PI/2],['06:00:00',Math.PI],['12:00:00',Math.PI*1.5],['18:00:00',Math.PI*2],['06:30:00',Math.PI+Math.PI/24]]) assert(Math.abs(clockAngle(`2020-01-01T${time}+08:00`)-angle)<1e-8);
  assert(Math.abs(clockAngle('2020-01-01T00:00:30Z','UTC')-(Math.PI/2+Math.PI/1440))<1e-8);
  assert.equal(clockAngle('2020-01-01T20:00:00Z'),clockAngle('2020-01-02T04:00:00+08:00'));
});

function sample(count=33){
  const authors=Array.from({length:count},(_,i)=>({id:`person-${i}`,name:'一个特别长的开发者名字'.repeat(3),color:'#79dce8',churn:i+1}));
  const commits=authors.map((a,i)=>({sha:`sha${i}`,authorId:a.id,churn:a.churn,additions:a.churn,deletions:0,authoredAt:'2020-01-01T00:00:00Z',at:.6,groupIds:[]}));
  return {project:{name:'sample',branch:'main'},settings:{maxAuthors:32,timeZone:'UTC'},authors,commits,duration:15,totalChurn:authors.reduce((sum,a)=>sum+a.churn,0)};
}

test('32 authors plus other fit, no overlap, proportional areas and dense grouping',()=>{
  const m=sample();const p=prepareHistory(m);
  for(const n of p.nodes){assert(n.x-n.envelope>225&&n.x+n.envelope<1695);assert(n.y-n.envelope>200&&n.y+n.envelope<910);for(const other of p.nodes)if(other!==n)assert(Math.hypot(n.x-other.x,n.y-other.y)>n.envelope+other.envelope);}
  const nodes=historyState(m,15).nodes;assert.equal(nodes.reduce((sum,n)=>sum+n.churn,0),m.totalChurn);
  const ratios=p.nodes.filter(n=>n.churn).map(n=>n.radius**2/n.churn);assert(ratios.every(r=>Math.abs(r-ratios[0])<1e-8));
  const dense=sample(1);dense.commits=Array.from({length:200},(_,i)=>({...dense.commits[0],sha:`dense-${i}`,at:.6+i*.0001,churn:1,additions:1}));dense.authors[0].churn=200;
  assert.equal(prepareHistory(dense).particles.length,200);assert.equal(historyState(dense,15).churn,200);
});

test('increasing author count repacks when cached positions prevent a valid layout',()=>{
  const authors=Array.from({length:34},(_,i)=>({id:`a${i}`,name:`作者${i}`,churn:100,color:'#79dce8'}));
  const m={authors,commits:[],duration:15,settings:{maxAuthors:31}};
  const positions=nodes=>Object.fromEntries(nodes.map(n=>[n.id,{x:n.x,y:n.y}]));
  const layout=positions(prepareHistory(m).nodes);
  assert.deepEqual(positions(prepareHistory({...m,layout}).nodes),layout);
  const expanded={...m,layout,settings:{maxAuthors:32}};
  const nodes=prepareHistory(expanded).nodes;
  assert.equal(nodes.length,33);
  assert.equal(nodes.reduce((sum,n)=>sum+n.churn,0),3400);
  assert.deepEqual(positions(prepareHistory({...expanded}).nodes),positions(nodes));
  for(const n of nodes)for(const other of nodes)if(n!==other)assert(Math.hypot(n.x-other.x,n.y-other.y)>n.envelope+other.envelope);
});

test('frame output is independent of previous playback or scrubbing',()=>{
  const m=sample(5);m.commits=m.commits.map((c,i)=>({...c,at:.6+i*2,authoredAt:`2020-01-0${i+1}T23:00:00Z`}));let operations=[];
  const gradient={addColorStop(){}};
  const ctx=new Proxy({}, {get(_,key){if(key==='measureText')return text=>({width:text.length*10});if(String(key).startsWith('create'))return ()=>gradient;return (...args)=>operations.push([key,...args]);},set(_,key,value){operations.push([key,value]);return true;}});
  drawHistory(ctx,m,1);operations=[];drawHistory(ctx,m,3);const direct=JSON.stringify(operations);
  for(let t=0;t<3;t+=.1)drawHistory(ctx,m,t);operations=[];drawHistory(ctx,m,3);assert.equal(JSON.stringify(operations),direct);
  drawHistory(ctx,m,14);operations=[];drawHistory(ctx,m,3);assert.equal(JSON.stringify(operations),direct);
});

function clockSample(dates, timeZone='Asia/Shanghai') {
  const m=sample(1);m.settings.timeZone=timeZone;
  m.commits=dates.map((authoredAt,i)=>({...m.commits[0],sha:`clock-${i}`,authoredAt,at:1+i*4}));
  m.authors[0].churn=m.commits.length;
  return m;
}

test('clock cursor interpolates real times, wraps clockwise and folds empty dates',()=>{
  const same=clockSample(['2020-01-01T06:00:00+08:00','2020-01-01T08:00:00+08:00']);
  assert.equal(clockState(same,3).timestamp,Date.parse('2020-01-01T07:00:00+08:00'));
  assert.equal(clockState(same,0).timestamp,Date.parse(same.commits[0].authoredAt));
  assert.equal(clockState(same,15).timestamp,Date.parse(same.commits[1].authoredAt));
  const wrap=clockSample(['2020-01-01T23:00:00+08:00','2020-01-02T01:00:00+08:00']);
  assert.equal(clockState(wrap,3).timestamp,Date.parse('2020-01-02T00:00:00+08:00'));
  let last=clockState(wrap,1).angle;
  for(let t=1.1;t<=5;t+=.1){let a=clockState(wrap,t).angle;while(a<last-1e-8)a+=Math.PI*2;assert(a-last<.1);last=a;}
  const folded=clockSample(['2020-01-01T23:00:00+08:00','2020-01-05T01:00:00+08:00']);
  assert.equal(clockState(folded,2).timestamp,Date.parse('2020-01-01T23:30:00+08:00'));
  assert.equal(clockState(folded,3).timestamp,Date.parse('2020-01-05T00:00:00+08:00'));
  assert.equal(clockState(folded,4).timestamp,Date.parse('2020-01-05T00:30:00+08:00'));
  assert.equal(clockState(folded,3).skippedDays,3);assert.equal(clockState(folded,5).skippedDays,0);
  assert.equal(clockState({...same,commits:[]},3),null);
  const single=clockSample(['2020-01-01T12:00:00+08:00']);assert.equal(clockState(single,10).angle,Math.PI*1.5);
  const simultaneous=clockSample(['2020-01-01T12:00:00+08:00','2020-01-01T12:00:00+08:00']);simultaneous.commits[1].at=1;
  assert.equal(clockState(simultaneous,1).timestamp,Date.parse(simultaneous.commits[1].authoredAt));
});

test('date folding respects configured zone and non-24-hour dates',()=>{
  const dates=['2020-01-01T15:00:00Z','2020-01-03T17:00:00Z'];
  const shanghai=clockSample(dates), utc=clockSample(dates,'UTC');
  assert.equal(clockState(shanghai,3).skippedDays,2);assert.equal(clockState(utc,3).skippedDays,1);
  // March 8 is a 23-hour date in New York: the retained first part is 22 hours, not 23.
  const dst=clockSample(['2020-03-08T01:00:00-05:00','2020-03-11T01:00:00-04:00'],'America/New_York');
  assert.equal(clockState(dst,1+4*22/23).timestamp,Date.parse('2020-03-11T00:00:00-04:00'));
  assert.equal(clockState(dst,2).timestamp,Date.parse('2020-03-08T07:45:00-04:00'));
  const fall=clockSample(['2020-11-01T00:00:00-04:00','2020-11-04T01:00:00-05:00'],'America/New_York');
  assert.equal(clockState(fall,1+4*25/26).timestamp,Date.parse('2020-11-04T00:00:00-05:00'));
});

test('every launch meets the clock cursor and only exact simultaneous events merge',()=>{
  const m=clockSample(['2020-01-01T06:00:00+08:00','2020-01-01T06:00:30+08:00','2020-01-01T06:01:00+08:00']);
  m.commits[1].at=1.01;m.commits[2].at=1.02;
  const scene=prepareHistory(m);assert.equal(scene.particles.length,3);
  for(const particle of scene.particles) assert(Math.abs(particle.angle-clockState(m,particle.at).angle)<1e-8);
  m.commits.push({...m.commits[0],sha:'duplicate-time'});
  const identical={...m,commits:[...m.commits].sort((a,b)=>a.at-b.at)};
  assert.equal(prepareHistory(identical).particles.length,3);
  assert.equal(historyState(identical,15).churn,4);
});

test('account linking, unlinking, primary changes and aggregated identities',async()=>{
  const {accountLinks,changeAccount,groupedAuthors}=await import('../src/accounts.js');
  const m=sample(3), [a,b,c]=m.authors.map(a=>a.id);
  let links=changeAccount(m.authors,{},b,'link',a);
  links=changeAccount(m.authors,links,c,'link',a);
  assert.deepEqual(links,{[b]:a,[c]:a});
  links=changeAccount(m.authors,links,b,'primary');
  assert.deepEqual(links,{[a]:b,[c]:b});
  m.settings.accountLinks=links;
  const grouped=groupedAuthors(m).authors;assert.equal(grouped.length,1);assert.equal(grouped[0].name,m.authors[1].name);
  assert.equal(grouped[0].churn,6);assert.equal(grouped[0].memberIds.length,3);
  const p=prepareHistory(m);assert.equal(p.nodes.length,1);assert.equal(p.particles.length,1);
  assert.equal(p.particles[0].authorId,b);assert.equal(p.particles[0].color,p.nodes[0].color);
  assert.equal(historyState(m,15).churn,6);assert.equal(historyState(m,15).nodes[0].commitCount,3);
  assert.deepEqual(m.commits.map(c=>c.authorId),[a,b,c]);
  links=changeAccount(m.authors,links,c,'unlink');assert.deepEqual(links,{[a]:b});
  links=changeAccount(m.authors,links,b,'link',c);assert.deepEqual(links,{[a]:c,[b]:c});
  assert.throws(()=>accountLinks(m.authors,{[a]:b,[b]:a}),/循环/);
  const other=prepareHistory({...m,settings:{maxAuthors:1,accountLinks:{[a]:b}}});
  assert.equal(other.nodes.find(n=>n.id==='__other__').hiddenCount,1);
});

test('account settings survive cached and incremental analysis',async ()=>{
  const f=fixture();try {
    f.commit('A','2020-01-01T00:00:00Z','one\n');f.git('config','user.name','B');f.git('config','user.email','b@test');
    f.commit('B','2020-01-02T00:00:00Z','two\n','b.txt');
    const m=(await analyzeHistory({repo:f.repo,accountLinks:{'b@test':'a@test'}}));
    const cached=(await analyzeHistory({repo:f.repo,previousManifest:m}));assert(cached.analysis.cacheHit);assert.deepEqual(cached.settings.accountLinks,m.settings.accountLinks);
    assert.equal(prepareHistory(cached).authors.length,1);
    f.commit('more B','2020-01-03T00:00:00Z','three\n','c.txt');
    const increment=(await analyzeHistory({repo:f.repo,previousManifest:cached}));assert(increment.analysis.incremental);assert.equal(historyState(increment,60).nodes[0].churn,3);
    const clear=(await analyzeHistory({repo:f.repo,previousManifest:increment,accountLinks:{}}));assert.equal(prepareHistory(clear).authors.length,2);
  }finally{f.cleanup();}
});

test('particle area follows changed lines within display bounds and force-driven authors stay separated',async()=>{
  const {particleRadius,hitAuthor}=await import('../src/visualizer.js');
  assert.equal(particleRadius(64)**2/particleRadius(16)**2,4);
  assert(particleRadius(1000)>particleRadius(100));assert.equal(particleRadius(0),1.5);assert.equal(particleRadius(1e8),18);
  const m=sample(33);const early=historyState(m,3).nodes,late=historyState(m,6).nodes;
  assert(early.some((n,i)=>Math.hypot(n.x-late[i].x,n.y-late[i].y)>1));
  for(let time=3;time<15;time+=.2){const nodes=historyState(m,time).nodes;for(const n of nodes){assert.equal(hitAuthor(m,time,n.x,n.y).id,n.id);for(const other of nodes)if(other!==n)assert(Math.hypot(n.x-other.x,n.y-other.y)>=n.safeRadius+other.safeRadius-.5);}}
});

test('particles meet the moving author edge at absorption, including overlapping growth',()=>{
  const m=clockSample(['2020-01-01T06:00:00Z','2020-01-01T06:01:00Z','2020-01-01T06:02:00Z'],'UTC');
  m.commits[1].at=1.1;m.commits[2].at=1.2;
  for(const p of prepareHistory(m).particles){
    const node=historyState(m,p.arrival).nodes.find(n=>n.id===p.authorId);
    const radius=Math.max(1,node.radius*Math.sqrt(node.visualChurn/node.finalChurn));
    assert(Math.abs(Math.hypot(p.path.ex-node.x,p.path.ey-node.y)-radius)<1e-7);
  }
});


test('presentation colors are stable, follow primary identities and leave manifests untouched',()=>{
  const m=sample(16), original=structuredClone(m);
  const scene=prepareHistory(m), reversed=prepareHistory({...m,authors:[...m.authors].reverse()});
  for(const node of scene.nodes) {
    assert.equal(node.color,reversed.nodes.find(n=>n.id===node.id).color);
    assert.match(node.color,/^#[0-9A-F]{6}$/);
  }
  assert.deepEqual(m,original);
  const [main,alias]=m.authors.map(a=>a.id);
  const linked=prepareHistory({...m,settings:{...m.settings,accountLinks:{[alias]:main}}});
  assert.equal(linked.nodes.find(n=>n.id===main).color,scene.nodes.find(n=>n.id===main).color);
  for(const particle of linked.particles) assert.equal(particle.color,linked.nodes.find(n=>n.id===particle.authorId).color);
  const limited=prepareHistory({...m,settings:{...m.settings,maxAuthors:1}});
  assert.equal(limited.nodes.find(n=>n.id==='__other__').color,'#91A0B2');
  for(const particle of limited.particles) assert.equal(particle.color,limited.nodes.find(n=>n.id===particle.authorId).color);
  assert.deepEqual(m,original);
});

test('full single-line author names and numbers share two fixed size tiers',()=>{
  const m=sample(2);
  m.authors[0].name='Alexandra Victoria Longlastname';
  m.authors[1].name='中文开发者完整姓名👩‍💻';
  const labels=[], properties={};
  const ctx=new Proxy(properties,{
    get(target,key){
      if(key==='measureText')return text=>({width:[...text].length*parseFloat(target.font.match(/[\d.]+(?=px)/)[0])*.6});
      if(key==='createRadialGradient')return ()=>({addColorStop(){}});
      if(key==='fillText')return (text,x,y)=>labels.push({text,x,y,font:target.font,color:target.fillStyle});
      return ()=>{};
    },
    set(target,key,value){target[key]=value;return true;}
  });
  const nodes=drawHistory(ctx,m,m.duration);
  for(const node of nodes){
    const largeLabel=node.radius*Math.sqrt(node.visualChurn/Math.max(1,node.finalChurn))>=60;
    const name=labels.filter(l=>l.text===node.name);
    assert.equal(name.length,1);
    assert.equal(name[0].text,node.name);
    assert.equal(name[0].color,'#E7EDF3');
    assert.equal(name[0].font,`600 ${largeLabel ? 24 : 16}px system-ui`);
    const numeric=labels.find(l=>l.x===node.x && l.y===node.y+20);
    assert.equal(parseFloat(numeric.font),largeLabel ? 18 : 12);
    assert.equal(numeric.color,name[0].color);
    assert(name.every(l=>!l.text.includes('…')));
    assert.equal(name[0].x,node.x);
    assert.equal(name[0].y,node.y-4);
  }
  const growing=sample(1);growing.authors[0].name='Ada';labels.length=0;
  drawHistory(ctx,growing,2.3);
  const early=labels.find(l=>l.text==='Ada').font;
  labels.length=0;drawHistory(ctx,growing,growing.duration);
  const late=labels.find(l=>l.text==='Ada').font;
  assert.equal(early,'600 16px system-ui');
  assert.equal(late,'600 24px system-ui');
});
