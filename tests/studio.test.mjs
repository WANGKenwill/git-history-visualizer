import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serverFixture } from './helpers/server.mjs';
import { historyState } from '../src/visualizer.js';

async function studioFixture(t) {
  const f=await serverFixture(t);
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  const page=await context.newPage();
  let picked=f.repo;
  await page.route('**/api/pick-local',route=>route.fulfill({json:{ok:true,path:picked}}));
  const select=async(path)=>{
    picked=path;await page.locator('#pick-local').click();
    await page.waitForFunction(path=>document.querySelector('#source').value===path&&!document.querySelector('#pick-local').disabled,path);
  };
  const generate=async()=>{
    const response=page.waitForResponse(response=>response.url().endsWith('/api/analyze'));
    await page.locator('#analyze').click();
    const result=await (await response).json();
    await page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
    assert.equal(result.ok,true,result.error);
    return result.manifest;
  };
  return {...f,page,select,generate};
}

test('file URLs show startup guidance, disable controls and never load the Studio module',{timeout:20000},async(t)=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),requests=[];page.on('request',request=>requests.push(request.url()));
  await page.goto(new URL('../studio.html',import.meta.url).href);
  assert.match(await page.locator('#status').textContent(),/npm run studio.*HTTP/);
  assert.equal(await page.locator('#status a').getAttribute('href'),'http://127.0.0.1:4173/');
  assert.equal(await page.locator('input:enabled, button:enabled, select:enabled').count(),0);
  assert(!requests.some(url=>url.endsWith('/src/studio.js')));
});

test('typed local paths preserve Unicode and spaces, clear remote URLs and omit tokens',{timeout:20000},async(t)=>{
  const f=await studioFixture(t),repo=join(f.dir,'中文 仓库');
  execFileSync('git',['clone',f.repo,repo],{stdio:'pipe'});
  await f.page.goto(f.origin);
  await f.page.getByText('远程 GitLab（可选，较慢）',{exact:true}).click();
  await f.page.locator('#remote-source').fill('https://gitlab.example.com/old');await f.page.locator('#token').fill('private-token');
  await f.page.locator('#source').fill(`  ${repo}  `);
  assert.equal(await f.page.locator('#remote-source').inputValue(),'');
  const submitted=f.page.waitForRequest(request=>request.url().endsWith('/api/analyze'));
  const result=await f.generate(),body=(await submitted).postDataJSON();
  assert.equal(body.source,repo);assert.equal(body.token,'');assert.equal(body.branch,'main');assert.equal(result.totalChurn,1);
  const remote='https://gitlab.example.com/new';
  await f.page.locator('#remote-source').fill(remote);
  await f.page.route('**/api/analyze',route=>{const body=route.request().postDataJSON();assert.equal(body.source,remote);assert.equal(body.token,'private-token');return route.fulfill({json:{ok:true,manifest:result}});});
  await f.generate();
});

test('picker cancellation and failure retain manually entered paths',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.page.goto(f.origin);
  await f.page.locator('#source').fill(f.repo);
  for(const result of [{ok:false,cancelled:true},{ok:false,error:'弹窗不可用'}]) {
    await f.page.route('**/api/pick-local',route=>route.fulfill({json:result}));
    await f.page.locator('#pick-local').click();await f.page.waitForFunction(()=>!document.querySelector('#pick-local').disabled);
    assert.equal(await f.page.locator('#source').inputValue(),f.repo);
    if(result.error)assert.match(await f.page.locator('#status').textContent(),/弹窗不可用/);
  }
  const response=f.page.waitForResponse(response=>response.url().endsWith('/api/analyze'));
  await f.page.locator('#source').fill(join(f.dir,'不存在的仓库'));await f.page.locator('#analyze').click();
  assert.equal((await response).status(),400);
  await f.page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
  assert.match(await f.page.locator('#status').textContent(),/生成失败.*不是 Git 仓库/);
});

test('switching repositories preserves their saved account associations',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);
  f.git('config','user.name','B');f.git('config','user.email','b@test');
  writeFileSync(join(f.repo,'second.js'),'two\n');f.git('add','.');f.git('commit','-m','second author');
  const links={'b@test':'test@example.com'};
  await f.analyze({source:f.repo,accountLinks:links});
  const other=join(f.dir,'other');
  execFileSync('git',['clone',f.repo,other],{stdio:'pipe'});
  await f.page.goto(f.origin);
  await f.select(other);await f.generate();
  await f.select(f.repo);
  assert.deepEqual((await f.generate()).settings.accountLinks,links);
  await f.page.locator('#accounts > summary').click();
  await f.page.locator('.account-row').filter({hasText:'b@test'}).getByRole('button',{name:'解除关联'}).click();
  assert.deepEqual((await f.generate()).settings.accountLinks,{});
});

test('choosing a local repository replaces a previously entered remote source',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);
  const manifest=await f.analyze({source:f.repo});
  await f.page.goto(f.origin);
  await f.page.getByText('远程 GitLab（可选，较慢）',{exact:true}).click();
  await f.page.locator('#remote-source').fill('https://gitlab.example.com/group/old');
  await f.page.locator('#token').fill('private-token');
  let submitted;
  await f.page.route('**/api/analyze',route=>{
    submitted=route.request().postDataJSON();
    return route.fulfill({json:{ok:true,manifest}});
  });
  await f.select(f.repo);await f.generate();
  assert.equal(submitted.source,f.repo);
  assert.equal(submitted.token,'');
});

test('restoring a remote history submits the actual remote branch name',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);
  const manifest=await f.analyze({source:f.repo});
  manifest.project.source='https://gitlab.example.com/group/repo';
  manifest.project.branch='origin/main';
  await f.page.route('**/data/manifest.js',route=>route.fulfill({contentType:'text/javascript',body:`window.__GIT_MANIFEST__ = ${JSON.stringify(manifest)};`}));
  let submitted;
  await f.page.route('**/api/analyze',route=>{
    submitted=route.request().postDataJSON();
    return route.fulfill({json:{ok:true,manifest}});
  });
  await f.page.goto(f.origin);await f.generate();
  assert.equal(submitted.branch,'main');
  manifest.project.source=f.repo;
  await f.page.goto(f.origin);await f.generate();
  assert.equal(submitted.branch,'origin/main');
});

test('each Studio page exports its own manifest after another page analyzes history',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);
  const first=await f.analyze({source:f.repo});
  await f.page.goto(f.origin);
  writeFileSync(join(f.repo,'app.js'),'one\ntwo\n');f.git('add','.');f.git('commit','-m','追加历史');
  const second=await f.analyze({source:f.repo,timeZone:'UTC',maxAuthors:1});
  const other=await f.page.context().newPage();await other.goto(f.origin);
  const submitted=[];
  await f.page.context().route('**/api/export',route=>{
    submitted.push(route.request().postDataJSON());
    return route.fulfill({json:{ok:true,file:'/exports/test.mp4'}});
  });
  for(const page of [f.page,other]) {
    await page.locator('#export').click();
    await page.locator('#status a').waitFor();
  }
  assert.deepEqual(submitted,[{manifest:first},{manifest:second}]);
});

test('merge details remain clickable while playing and update when arrivals change',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);
  const manifest={version:2,project:{name:'详情测试',branch:'main'},duration:30,
    authors:[{id:'a@test',name:'测试作者',email:'a@test',churn:200,color:'#79dce8'}],
    commits:[.6,6].map((at,i)=>({sha:`commit${i}`,authorId:'a@test',churn:100,additions:100,deletions:0,at,authoredAt:`2020-01-01T0${i}:00:00Z`,groupIds:[`merge${i}`]})),
    groups:[0,1].map(i=>({id:`merge${i}`,title:`合并组${i}`})),
    settings:{maxAuthors:16,timeZone:'UTC'},totalChurn:200};
  await f.page.route('**/data/manifest.js',route=>route.fulfill({contentType:'text/javascript',body:`window.__GIT_MANIFEST__=${JSON.stringify(manifest)};`}));
  await f.page.goto(f.origin);
  const seek=async time=>f.page.locator('#scrub').evaluate((el,time)=>{el.value=time;el.dispatchEvent(new Event('input',{bubbles:true}));},time);
  await seek(3);
  const node=historyState(manifest,3).nodes[0],bounds=await f.page.locator('#preview').boundingBox();
  await f.page.mouse.click(bounds.x+node.x*bounds.width/1920,bounds.y+node.y*bounds.height/1080);
  const summary=f.page.locator('#author-detail summary');await summary.waitFor();
  const original=await summary.elementHandle();
  await f.page.locator('#play').click();
  for(const expected of [true,false]) {
    await summary.scrollIntoViewIfNeeded();
    const box=await summary.boundingBox();await f.page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    const pressedAt=await f.page.locator('#scrub').evaluate(el=>Number(el.value));
    await f.page.mouse.down();
    await f.page.waitForFunction(time=>Number(document.querySelector('#scrub').value)>time+.06,pressedAt);
    await f.page.mouse.up();
    assert.equal(await original.evaluate(el=>el.isConnected),true);
    assert.equal(await f.page.locator('#author-detail details').evaluate(el=>el.open),expected);
  }
  await seek(9);assert.match(await summary.textContent(),/2 个合并组/);
  assert.equal(await original.evaluate(el=>el.isConnected),true);
  assert.match(await f.page.locator('#author-detail').textContent(),/改动 200/);
  await seek(3);assert.match(await summary.textContent(),/1 个合并组/);
  await seek(1);assert.equal(await f.page.locator('#author-detail details:visible').count(),0);
});

test('play restarts at the end and continues from an intermediate pause',{timeout:20000},async(t)=>{
  const f=await studioFixture(t),manifest=await f.analyze({source:f.repo});manifest.duration=.5;
  await f.page.route('**/data/manifest.js',route=>route.fulfill({contentType:'text/javascript',body:`window.__GIT_MANIFEST__=${JSON.stringify(manifest)};`}));
  await f.page.goto(f.origin);
  const play=()=>f.page.locator('#play').evaluate(el=>{el.click();return {time:Number(document.querySelector('#scrub').value),label:el.textContent};});
  await play();
  await f.page.waitForFunction(()=>Number(document.querySelector('#scrub').value)===.5&&document.querySelector('#play').textContent==='播放');
  assert.deepEqual(await play(),{time:0,label:'暂停'});
  await f.page.waitForFunction(()=>Number(document.querySelector('#scrub').value)>.1);
  const paused=await play();assert.equal(paused.label,'播放');assert(paused.time>.1&&paused.time<.5);
  assert.deepEqual(await play(),{time:paused.time,label:'暂停'});
  await f.page.locator('#scrub').evaluate(el=>{el.value=.5;el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.deepEqual(await play(),{time:0,label:'暂停'});
});

test('Studio decodes split progress messages and only offers downloads after completion',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.analyze({source:f.repo});await f.page.goto(f.origin);
  await f.page.evaluate(()=>{
    const realFetch=window.fetch;
    window.fetch=(url,options)=>{
      if(url!=='/api/export')return realFetch(url,options);
      window.exportAccept=options.headers.accept;
      return Promise.resolve(new Response(new ReadableStream({start(controller){window.exportController=controller;}}),{headers:{'content-type':'application/x-ndjson'}}));
    };
  });
  const enqueue=bytes=>f.page.evaluate(bytes=>window.exportController.enqueue(Uint8Array.from(bytes)),Array.from(bytes));
  await f.page.locator('#export').click();await f.page.waitForFunction(()=>window.exportController);
  assert.equal(await f.page.evaluate(()=>window.exportAccept),'application/x-ndjson');
  await enqueue(Buffer.from('{"type":"start"}\n{"type":"progress","frame":'));
  assert.equal(await f.page.locator('#status').textContent(),'准备导出…');
  await enqueue(Buffer.from('1,"total":90}\n'));
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('1/90'));
  assert.match(await f.page.locator('#status').textContent(),/1%/);assert(await f.page.locator('#export').isDisabled());
  await enqueue(Buffer.from('{"type":"progress","frame":90,"total":90}\n'));
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('正在完成编码'));
  assert.equal(await f.page.locator('#status a').count(),0);
  const complete=Buffer.from(JSON.stringify({type:'complete',file:'/exports/测试.mp4'})),split=complete.indexOf(Buffer.from('测'))+1;
  await enqueue(complete.subarray(0,split));await enqueue(complete.subarray(split));
  await f.page.evaluate(()=>window.exportController.close());
  await f.page.locator('#status a').waitFor();assert.equal(await f.page.locator('#status a').getAttribute('href'),'/exports/测试.mp4');
  await f.page.waitForFunction(()=>!document.querySelector('#export').disabled);
});

test('Studio restores export controls after streamed errors, premature EOF and network failures',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.analyze({source:f.repo});await f.page.goto(f.origin);
  for(const kind of ['error','eof','network']) {
    await f.page.evaluate(()=>{
      window.exportController=null;
      window.fetch=()=>Promise.resolve(new Response(new ReadableStream({start(controller){window.exportController=controller;}}),{headers:{'content-type':'application/x-ndjson'}}));
    });
    await f.page.locator('#export').click();await f.page.waitForFunction(()=>window.exportController);
    await f.page.evaluate(kind=>{
      const c=window.exportController;
      c.enqueue(new TextEncoder().encode('{"type":"start"}\n'));
      if(kind==='error'){const bytes=new TextEncoder().encode('{"type":"error","error":"本地编码失败"}\n');const split=new TextEncoder().encode('{"type":"error","error":"').length+1;c.enqueue(bytes.slice(0,split));c.enqueue(bytes.slice(split));c.close();}
      else if(kind==='eof')c.close();
      else c.error(new Error('连接断开'));
    },kind);
    await f.page.waitForFunction(()=>!document.querySelector('#export').disabled);
    const status=await f.page.locator('#status').textContent();assert.match(status,/导出失败/);
    assert.match(status,kind==='error'?/本地编码失败/:kind==='eof'?/未收到完成结果/:/连接断开/);
    assert.equal(await f.page.locator('#status a').count(),0);
  }
});
