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
  const context=await browser.newContext({locale:"zh-CN"});
  const page=await context.newPage();
  await page.addInitScript(()=>{
    const realFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await realFetch(...args);
      if(args[0]==='/api/analyze')window.analysisResult=response.clone().text().then(text=>response.headers.get('content-type')?.includes('application/x-ndjson')?text.trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.type==='complete'):JSON.parse(text));
      return response;
    };
  });
  let picked=f.repo;
  await page.route('**/api/pick-local',route=>route.fulfill({json:{ok:true,path:picked}}));
  const openConfig=async()=>{await page.locator('#summary strong').first().waitFor({state:'attached'});await page.locator('#config-panel').waitFor({state:'visible'});};
  const select=async(path)=>{
    await openConfig();
    picked=path;await page.locator('#pick-local').click();
    await page.waitForFunction(path=>document.querySelector('#source').value===path&&!document.querySelector('#pick-local').disabled,path);
  };
  const generate=async()=>{
    await openConfig();
    await page.locator("#source").blur();
    await page.waitForFunction(()=>!document.querySelector("#analyze").disabled);
    const response=page.waitForResponse(response=>response.url().endsWith('/api/analyze'));
    await page.locator('#analyze').click();
    await response;
    const result=await page.evaluate(()=>window.analysisResult);
    await page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
    assert.equal(result.ok,true,result.error);
    return result.manifest;
  };
  return {...f,page,select,generate,openConfig};
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

test('local soundtrack selection matches the current timeline, preserves totals and removes audio', { timeout: 30000 }, async t => {
  const f = await studioFixture(t), page = f.page;
  writeFileSync(join(f.repo, 'second.js'), 'two\n'); f.git('add', '.'); f.git('commit', '-m', 'second');
  await page.goto(f.origin); await f.select(f.repo);
  const manifest = await f.generate();
  const audio = join(f.dir, '配乐.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18.25', audio]);
  await page.locator('#audio-options').evaluate(el => { el.open = true; });
  await page.locator('#audio-file').setInputFiles(audio);
  await page.waitForFunction(() => !document.querySelector('#match-audio-duration').disabled);
  assert.match(await page.locator('#audio-status').textContent(), /配乐.wav.*18.25/);
  await page.locator('#match-audio-duration').click();
  assert.equal(await page.locator('#duration').inputValue(), '18.25');
  assert.equal(await page.locator('#scrub').getAttribute('max'), '18.25');
  await page.locator('#scrub').evaluate(el => { el.value = el.max; el.dispatchEvent(new Event('input')); });
  assert.equal(await page.locator('#summary strong').first().textContent(), String(manifest.totalChurn));
  let submitted;
  await page.route('**/api/export', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, file: '/exports/test.mp4' } });
  });
  await page.locator('#export').click(); await page.locator('#export-status a').waitFor();
  assert.equal(submitted.manifest.duration, 18.25); assert(submitted.audioId);
  assert.equal(historyState(submitted.manifest, 18.25).churn, manifest.totalChurn);
  assert.equal(historyState(submitted.manifest, 18.25).retainedLines, manifest.retention.mappedLines);
  const invalidFile = join(f.dir, 'invalid.wav'); writeFileSync(invalidFile, 'not audio');
  await page.locator('#audio-file').setInputFiles(invalidFile);
  await page.waitForFunction(() => document.querySelector('#audio-status').textContent.includes('音频未更换'));
  assert(!(await page.locator('#clear-audio').isDisabled()));
  await page.locator('#export').click(); await page.locator('#export-status a').waitFor();
  assert(submitted.audioId);
  await page.locator('#audio-file').setInputFiles(audio);
  await page.waitForFunction(() => !document.querySelector('#match-audio-duration').disabled);
  await page.locator('#export').click(); await page.locator('#export-status a').waitFor();
  await page.locator('#language').selectOption('en');
  assert.match(await page.locator('#audio-status').textContent(), /18.25 seconds/);
  const id = submitted.audioId;
  const deletion = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(id));
  await page.locator('#clear-audio').click(); await deletion;
  assert(await page.locator('#match-audio-duration').isDisabled());
  await page.locator('#export').click(); await page.locator('#export-status a').waitFor();
  assert.equal(submitted.audioId, undefined);
  const invalid = await fetch(`${f.origin}/api/audio`, { method: 'POST', body: 'not audio' });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).errorCode, 'error.invalidAudio');
  const missing = await fetch(`${f.origin}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest, audioId: id }) });
  assert.equal(missing.status, 400); assert.equal((await missing.json()).errorCode, 'error.audioMissing');
});

test('typed local paths preserve Unicode and spaces, clear remote URLs and omit tokens',{timeout:20000},async(t)=>{
  const f=await studioFixture(t),repo=join(f.dir,'中文 仓库');
  execFileSync('git',['clone',f.repo,repo],{stdio:'pipe'});
  await f.page.goto(f.origin);
  await f.openConfig();await f.page.getByText('远程 GitLab（可选，较慢）',{exact:true}).click();
  await f.page.locator('#remote-source').fill('https://gitlab.example.com/old');await f.page.locator('#token').fill('private-token');
  await f.page.locator('#source').fill(`  ${repo}  `);
  assert.equal(await f.page.locator('#remote-source').inputValue(),'');
  const submitted=f.page.waitForRequest(request=>request.url().endsWith('/api/analyze'));
  const result=await f.generate(),body=(await submitted).postDataJSON();
  assert.equal(body.source,repo);assert.equal(body.token,'');assert.equal(body.branch,'main');assert.equal(result.totalChurn,1);
  const remote='https://gitlab.example.com/new';
  await f.openConfig();await f.page.locator('#remote-source').fill(remote);
  await f.page.route('**/api/analyze',route=>{const body=route.request().postDataJSON();assert.equal(body.source,remote);assert.equal(body.token,'private-token');return route.fulfill({json:{ok:true,manifest:result}});});
  await f.page.route('**/api/branches',route=>route.fulfill({json:{ok:true,branches:['main'],defaultBranch:'main'}}));
  await f.page.locator('#read-branches').click();
  await f.generate();
});

test('picker cancellation and failure retain manually entered paths',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.page.goto(f.origin);
  await f.page.locator('#source').fill(f.repo);
  for(const result of [{ok:false,cancelled:true},{ok:false,error:'弹窗不可用',errorCode:'folderUnavailable'}]) {
    await f.page.route('**/api/pick-local',route=>route.fulfill({json:result}));
    await f.page.locator('#pick-local').click();await f.page.waitForFunction(()=>!document.querySelector('#pick-local').disabled);
    assert.equal(await f.page.locator('#source').inputValue(),f.repo);
    if(result.error)assert.match(await f.page.locator('#status').textContent(),/弹窗不可用/);
  }
  await f.page.locator('#source').blur();
  await f.page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
  const response=f.page.waitForResponse(response=>response.url().endsWith('/api/branches')&&response.request().postDataJSON().source.endsWith('不存在的仓库'));
  await f.page.locator('#source').fill(join(f.dir,'不存在的仓库'));await f.page.locator('#source').blur();
  assert.equal((await response).status(),400);
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('读取分支失败'));
  assert(await f.page.locator('#analyze').isDisabled());
  assert.match(await f.page.locator('#status').textContent(),/读取分支失败.*不是 Git 仓库/);
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
  await f.openConfig();await f.page.getByText('远程 GitLab（可选，较慢）',{exact:true}).click();
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
  await f.page.route('**/api/branches',route=>route.fulfill({json:{ok:true,branches:['main','master'],defaultBranch:'master'}}));
  await f.page.goto(f.origin);await f.openConfig();
  assert(await f.page.locator('#analyze').isDisabled());
  await f.page.getByText('远程 GitLab（可选，较慢）',{exact:true}).click();
  await f.page.locator('#read-branches').click();await f.generate();
  assert.equal(submitted.branch,'main');
  await f.page.unroute('**/api/branches');
  manifest.project.source=f.repo;
  await f.page.goto(f.origin);await f.generate();
  assert.equal(submitted.branch,'main');
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
    await page.locator('#export-status a').waitFor();
  }
  assert.deepEqual(submitted,[{manifest:first},{manifest:second}]);
});

test('author details follow commit arrivals and legacy merge groups are not displayed',{timeout:20000},async(t)=>{
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
  assert.match(await f.page.locator('#author-stats').textContent(),/改动 100/);
  assert.equal(await f.page.locator('#merge-details').count(),0);
  assert.doesNotMatch(await f.page.locator('#extra-stats').textContent(),/合并组/);
  await seek(9);assert.match(await f.page.locator('#author-stats').textContent(),/改动 200/);
  await seek(1);assert.match(await f.page.locator('#author-stats').textContent(),/点击开发者球/);
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
  assert.equal(await f.page.locator('#export-status').textContent(),'准备导出…');
  await f.openConfig();await f.page.locator('#source').fill('/tmp/another repository');
  assert.match(await f.page.locator('#status').textContent(),/输入的本地路径/);
  assert.equal(await f.page.locator('#export-status').textContent(),'准备导出…');
  await enqueue(Buffer.from('1,"total":90}\n'));
  await f.page.waitForFunction(()=>document.querySelector('#export-status').textContent.includes('1/90'));
  assert.match(await f.page.locator('#export-status').textContent(),/1%/);assert(await f.page.locator('#export').isDisabled());
  await enqueue(Buffer.from('{"type":"progress","frame":90,"total":90}\n'));
  await f.page.waitForFunction(()=>document.querySelector('#export-status').textContent.includes('正在完成编码'));
  assert.equal(await f.page.locator('#export-status a').count(),0);
  const complete=Buffer.from(JSON.stringify({type:'complete',file:'/exports/测试.mp4'})),split=complete.indexOf(Buffer.from('测'))+1;
  await enqueue(complete.subarray(0,split));await enqueue(complete.subarray(split));
  await f.page.evaluate(()=>window.exportController.close());
  await f.page.locator('#export-status a').waitFor();assert.equal(await f.page.locator('#export-status a').getAttribute('href'),'/exports/测试.mp4');
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
      if(kind==='error'){const bytes=new TextEncoder().encode('{"type":"error","error":"本地编码失败","errorCode":"error.encoding"}\n');const split=new TextEncoder().encode('{"type":"error","error":"').length+1;c.enqueue(bytes.slice(0,split));c.enqueue(bytes.slice(split));c.close();}
      else if(kind==='eof')c.close();
      else c.error(new Error('连接断开'));
    },kind);
    await f.page.waitForFunction(()=>!document.querySelector('#export').disabled);
    const status=await f.page.locator('#export-status').textContent();assert.match(status,/导出失败/);
    assert.match(status,kind==='error'?/视频编码失败/:kind==='eof'?/未收到完成结果/:/查看终端日志/);
    assert.equal(await f.page.locator('#export-status a').count(),0);
  }
});


test('configuration stays visible before and after generation and fits narrow windows',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.page.goto(f.origin);await f.openConfig();
  assert.equal(await f.page.locator('#project-title').textContent(),'Git History');
  assert.equal(await f.page.locator('#toggle-config, #focus-view').count(),0);
  await f.select(f.repo);const manifest=await f.generate();
  assert(await f.page.locator('#config-panel').isVisible());
  assert.equal(await f.page.locator('#project-title').textContent(),manifest.project.name);
  assert.equal(await f.page.locator('#summary .stat').count(),4);
  assert.equal(await f.page.locator('#statistics-details').evaluate(el=>el.open),false);
  assert.match(await f.page.locator('#extra-stats').textContent(),/未纳入贡献事件/);
  await f.page.goto(f.origin);await f.openConfig();
  for(const width of [1440,1000,803,390]){
    await f.page.setViewportSize({width,height:1000});
    const metrics=await f.page.evaluate(()=>{
      const canvas=document.querySelector('#preview').getBoundingClientRect(),panel=document.querySelector('#config-panel').getBoundingClientRect();
      return {width:canvas.width,height:canvas.height,panelWidth:panel.width,panelBottom:panel.bottom,canvasTop:canvas.top,scroll:document.documentElement.scrollWidth};
    });
    assert(metrics.scroll<=width,`overflow at ${width}`);
    assert(Math.abs(metrics.width/metrics.height-16/9)<.02);
    if(width>=1000)assert.equal(metrics.panelWidth,320);
    else assert(metrics.canvasTop>=metrics.panelBottom);
  }
  f.git('branch','feature/test');
  await f.select(f.repo);await f.page.locator('#branch').selectOption('feature/test');
  assert.equal(await f.page.locator('#branch').inputValue(),'feature/test');
  await f.page.locator('#source').fill(join(f.dir,'missing'));
  const response=f.page.waitForResponse(r=>r.url().endsWith('/api/branches'));
  await f.page.locator('#source').blur();await response;
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('读取分支失败'));
  assert(await f.page.locator('#analyze').isDisabled());
  assert(await f.page.locator('#config-panel').isVisible());
});

test('fullscreen includes controls, preserves aspect ratio and follows exit events',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.analyze({source:f.repo});await f.page.goto(f.origin);await f.page.locator('#summary strong').first().waitFor({state:'attached'});
  await f.page.locator('#statistics-details > summary').click();await f.page.locator('#accounts > summary').click();
  const source=await f.page.locator('#source').inputValue();
  await f.page.locator('#scrub').evaluate(el=>{el.value=10;el.dispatchEvent(new Event('input',{bubbles:true}));});
  await f.page.locator('#fullscreen').click();
  await f.page.waitForFunction(()=>document.fullscreenElement?.id==='player' && document.querySelector('#fullscreen').textContent==='退出全屏');
  assert.equal(await f.page.locator('#fullscreen').textContent(),'退出全屏');
  const ratio=await f.page.locator('#preview').evaluate(el=>{const r=el.getBoundingClientRect();return r.width/r.height;});assert(Math.abs(ratio-16/9)<.02);
  assert(await f.page.locator('#export').isVisible());assert.equal(await f.page.locator('#scrub').inputValue(),'10');
  await f.page.locator('#fullscreen').click();await f.page.waitForFunction(()=>!document.fullscreenElement);
  await f.page.locator('#fullscreen').click();await f.page.waitForFunction(()=>document.fullscreenElement);
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(()=>!document.fullscreenElement);
  await f.page.waitForFunction(()=>document.querySelector('#fullscreen').textContent==='全屏');
  assert.equal(await f.page.locator('#fullscreen').getAttribute('aria-pressed'),'false');
  assert(await f.page.locator('#config-panel').isVisible());assert.equal(await f.page.locator('#source').inputValue(),source);
  assert.equal(await f.page.locator('#statistics-details').evaluate(el=>el.open),true);
  assert.equal(await f.page.locator('#accounts').evaluate(el=>el.open),true);
  await f.page.evaluate(()=>{document.querySelector('#player').requestFullscreen=()=>Promise.reject(new Error('浏览器拒绝请求'));});
  await f.page.locator('#fullscreen').click();await f.page.locator('#player-status').getByText('无法切换全屏：操作失败，请重试并查看终端日志。').waitFor();
  assert.equal(await f.page.locator('#fullscreen').textContent(),'全屏');
});

test('local branch selection detects master, analyzes a chosen branch and restores it',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);f.git('branch','-m','main','master');f.git('checkout','-b','feature/test');
  writeFileSync(join(f.repo,'feature.js'),'two\n');f.git('add','.');f.git('commit','-m','feature');f.git('checkout','master');
  await f.page.goto(f.origin);await f.select(f.repo);
  assert.equal(await f.page.locator('#branch').evaluate(el=>el.tagName),'SELECT');
  assert.equal(await f.page.locator('#branch').inputValue(),'master');
  assert.deepEqual(await f.page.locator('#branch option').allTextContents(),['feature/test','master']);
  await f.page.locator('#branch').selectOption('feature/test');
  const m=await f.generate();assert.equal(m.project.branch,'feature/test');assert.equal(m.totalChurn,2);
  await f.page.goto(f.origin);await f.page.waitForFunction(()=>!document.querySelector('#branch').disabled);
  assert.equal(await f.page.locator('#branch').inputValue(),'feature/test');
});

test('branch responses from a previous local path cannot overwrite the latest selection',{timeout:20000},async(t)=>{
  const f=await studioFixture(t);await f.page.goto(f.origin);
  let firstRoute,resolveFirst;const first=new Promise(done=>{resolveFirst=done;});
  await f.page.route('**/api/branches',route=>{
    if(route.request().postDataJSON().source.endsWith('/first')){firstRoute=route;resolveFirst();return;}
    return route.fulfill({json:{ok:true,branches:['master'],defaultBranch:'master'}});
  });
  await f.page.locator('#source').fill('/tmp/first');await f.page.locator('#source').blur();await first;
  assert(await f.page.locator('#analyze').isDisabled());
  await f.page.locator('#source').fill('/tmp/second');
  assert.equal(await f.page.locator('#branch').inputValue(),'');
  await f.page.locator('#source').blur();await f.page.waitForFunction(()=>!document.querySelector('#branch').disabled);
  const oldResponse=f.page.waitForResponse(r=>r.url().endsWith('/api/branches')&&r.request().postDataJSON().source.endsWith('/first'));
  await firstRoute.fulfill({json:{ok:true,branches:['wrong'],defaultBranch:'wrong'}});await oldResponse;
  // Drain the browser fetch callback before checking its effect.
  await f.page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  assert.equal(await f.page.locator('#branch').inputValue(),'master');
  assert.deepEqual(await f.page.locator('#branch option').allTextContents(),['master']);
  assert.match(await f.page.locator('#status').textContent(),/已读取分支/);
});

test('remote branches require an explicit read, allow retry and invalidate on URL or Token changes',{timeout:20000},async(t)=>{
  const f=await studioFixture(t),m=await f.analyze({source:f.repo});
  m.project.source='https://example.invalid/restored.git';m.project.branch='origin/main';
  await f.page.route('**/data/manifest.js',route=>route.fulfill({contentType:'text/javascript',body:`window.__GIT_MANIFEST__=${JSON.stringify(m)};`}));
  let calls=0,submitted;
  await f.page.route('**/api/branches',route=>{
    calls++;submitted=route.request().postDataJSON();
    return route.fulfill({json:calls===1?{ok:false,error:'鉴权失败，请重试',errorCode:'error.branchRemote'}:{ok:true,branches:['feature/test','main','master'],defaultBranch:'master'}});
  });
  await f.page.goto(f.origin);await f.openConfig();
  assert.equal(calls,0);assert(await f.page.locator('#analyze').isDisabled());
  assert(await f.page.locator('#export').isEnabled());await f.page.locator('#play').click();
  await f.page.waitForFunction(()=>Number(document.querySelector('#scrub').value)>0);await f.page.locator('#play').click();
  await f.page.getByText('远程 GitLab（可选，较慢）',{exact:true}).click();
  await f.page.locator('#read-branches').click();
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('读取远程分支失败'));
  assert(await f.page.locator('#analyze').isDisabled());assert(await f.page.locator('#read-branches').isEnabled());
  await f.page.locator('#read-branches').click();await f.page.waitForFunction(()=>!document.querySelector('#branch').disabled);
  assert.equal(await f.page.locator('#branch').inputValue(),'main','restore saved branch before the remote default');
  await f.page.locator('#token').fill('new-token');assert(await f.page.locator('#analyze').isDisabled());
  assert.equal(await f.page.locator('#branch').inputValue(),'');
  await f.page.locator('#remote-source').fill('https://example.invalid/new.git');
  await f.page.locator('#read-branches').click();await f.page.waitForFunction(()=>!document.querySelector('#branch').disabled);
  assert.deepEqual(submitted,{source:'https://example.invalid/new.git',token:'new-token'});
  assert.equal(await f.page.locator('#branch').inputValue(),'master');
  await f.page.locator('#branch').selectOption('feature/test');
  let analysis;
  await f.page.route('**/api/analyze',route=>{analysis=route.request().postDataJSON();return route.fulfill({json:{ok:true,manifest:m}});});
  await f.generate();assert.equal(analysis.branch,'feature/test');
  await f.openConfig();
  await f.page.locator('#remote-source').fill('https://example.invalid/other.git');
  assert(await f.page.locator('#analyze').isDisabled());assert.equal(await f.page.locator('#branch').inputValue(),'');
});

test('shallow local history completes with one click, recovers from failure and blocks duplicate actions',{timeout:20000},async t=>{
  const f=await studioFixture(t);
  writeFileSync(join(f.repo,'app.js'),'one\ntwo\n');f.git('add','.');f.git('commit','-m','追加');
  const shallow=join(f.dir,'shallow');
  execFileSync('git',['clone','--depth','1',new URL(`file://${f.repo}`).href,shallow],{stdio:'pipe'});
  await f.page.goto(f.origin);await f.select(shallow);
  await f.page.locator('#shallow-warning').waitFor({state:'visible'});
  assert(await f.page.locator('#analyze').isDisabled());assert(await f.page.locator('#branch').isEnabled());
  assert.equal(await f.page.locator('#branch').inputValue(),'main');
  assert.match(await f.page.locator('#shallow-warning').textContent(),/git fetch --unshallow/);
  await f.page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await f.page.locator('#copy-unshallow').click();
  assert.equal(await f.page.evaluate(()=>navigator.clipboard.readText()),'git fetch --unshallow');
  let completeRoute;
  const pendingRoute=new Promise(done=>{completeRoute=done;});
  await f.page.route('**/api/unshallow',route=>completeRoute(route));
  await f.page.locator('#unshallow').click();
  const route=await pendingRoute;
  assert.deepEqual(route.request().postDataJSON(),{source:shallow});
  assert(await f.page.locator('#unshallow').isDisabled());assert(await f.page.locator('#source').isDisabled());
  assert(await f.page.locator('#retry-branches').isDisabled());assert(await f.page.locator('#analyze').isDisabled());
  assert.match(await f.page.locator('#status').textContent(),/正在下载/);
  await route.fulfill({status:400,json:{ok:false,error:'测试网络失败',errorCode:'error.unshallowFailed'}});
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('补全历史失败'));
  assert(await f.page.locator('#unshallow').isEnabled());assert(await f.page.locator('#source').isEnabled());
  assert(await f.page.locator('#shallow-warning').isVisible());assert(await f.page.locator('#analyze').isDisabled());
  await f.page.unroute('**/api/unshallow');
  await f.page.locator('#unshallow').click();await f.page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
  assert.match(await f.page.locator('#status').textContent(),/历史已补全/);
  assert(await f.page.locator('#shallow-warning').isHidden());
  const m=await f.generate();assert.equal(m.totalChurn,2);assert.equal(m.rules.historyCompleteness,'full-v1');
});

test('analysis progress decodes split messages and failed streams retain the current history',{timeout:20000},async(t)=>{
  const f=await studioFixture(t),manifest=await f.analyze({source:f.repo});await f.page.goto(f.origin);await f.openConfig();
  await f.page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
  await f.page.evaluate(()=>{
    const original=window.fetch;
    window.fetch=(url,options)=>url==='/api/analyze'?Promise.resolve(new Response(new ReadableStream({start(controller){window.analysisController=controller;}}),{headers:{'content-type':'application/x-ndjson'}})):original(url,options);
  });
  const send=text=>f.page.evaluate(text=>window.analysisController.enqueue(new TextEncoder().encode(text)),text);
  const start=async()=>{await f.page.evaluate(()=>window.analysisController=null);await f.page.locator('#analyze').click();await f.page.waitForFunction(()=>window.analysisController);};
  await start();await send('{"type":"progress","stage":"retention","completed":2,');await send('"total":9}\n');
  await f.page.waitForFunction(()=>document.querySelector('#status').textContent.includes('2/9'));
  assert(await f.page.locator('#analyze').isDisabled());
  await send(JSON.stringify({type:'complete',ok:true,manifest}));await f.page.evaluate(()=>window.analysisController.close());
  await f.page.waitForFunction(()=>!document.querySelector('#analyze').disabled);assert.match(await f.page.locator('#status').textContent(),/已生成/);
  for(const error of [true,false]){
    await start();if(error)await send('{"type":"error","error":"下载超时，请重新生成","errorCode":"error.downloadTimeout"}\n');
    await f.page.evaluate(()=>window.analysisController.close());
    await f.page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
    assert.match(await f.page.locator('#status').textContent(),error?/下载历史超时/:/未收到完成结果/);
    assert.equal(await f.page.locator('#project-title').textContent(),manifest.project.name);
  }
});
