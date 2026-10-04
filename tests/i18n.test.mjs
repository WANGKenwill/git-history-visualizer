import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { messages, t, normalizeLocale, AppError } from '../src/i18n.js';
import { historyState, clockState } from '../src/visualizer.js';
import { serverFixture } from './helpers/server.mjs';

const sample = { version: 2, project: {name:'Original project', branch:'main'}, duration:15,
  settings:{timeZone:'UTC',maxAuthors:1}, totalChurn:12,
  retention:{version:2,totalLines:5,mappedLines:5,unmappedLines:0},
  authors:[{id:'a',name:'Alice',email:'a@example.com',churn:10,retainedLines:4},{id:'b',name:'Bob',email:'b@example.com',churn:2,retainedLines:1}],
  commits:[{sha:'1',authorId:'a',authoredAt:'2026-01-01T03:00:00Z',at:0,churn:10,additions:8,deletions:2,retainedLines:4},
    {sha:'2',authorId:'b',authoredAt:'2026-01-03T04:00:00Z',at:2,churn:2,additions:1,deletions:1,retainedLines:1}] };

test('translations have matching keys and parameters, and old manifests default to Chinese',()=>{
  assert.deepEqual(Object.keys(messages.en).sort(),Object.keys(messages['zh-CN']).sort());
  for(const key of Object.keys(messages.en)) {
    const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
    assert.deepEqual(parameters(messages.en[key]),parameters(messages['zh-CN'][key]),key);
  }
  for (const locale of [undefined,'fr','en-US','bad locale']) assert.equal(normalizeLocale(locale),'zh-CN');
  assert.equal(t('en','retentionFiles',{done:1234,total:2000}),'Analyzing retention: files processed 1,234/2,000');
  assert.equal(t('en','play'),'Play');assert.equal(t(undefined,'play'),'播放');
  assert.equal(new AppError('error.notRepository',{repo:'/repo'}).message,'不是 Git 仓库: /repo');
  const chinese=historyState(sample,15),english=historyState({...sample,settings:{...sample.settings,locale:'en'}},15);
  assert.equal(chinese.churn,english.churn);assert.equal(chinese.retainedLines,english.retainedLines);
  assert.deepEqual(chinese.nodes.map(({name,...node})=>node),english.nodes.map(({name,...node})=>node));
  assert.equal(english.nodes.find(node=>node.id==='__other__').name,'Other · 1');
  assert.equal(clockState(sample,3).timestamp,clockState({...sample,settings:{...sample.settings,locale:'en'}},3).timestamp);
});

async function fixture(t,locale='en-US') {
  const f=await serverFixture(t);
  mkdirSync(join(f.dir,'app/.cache/current'),{recursive:true});
  writeFileSync(join(f.dir,'app/.cache/current/manifest.js'),`window.__GIT_MANIFEST__=${JSON.stringify(sample)};`);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({locale});const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(f.origin);await page.locator('#summary strong').first().waitFor();
  return {...f,page,context};
}

test('browser language, persistent selection and state survive switching during playback and account editing',{timeout:30000},async(t)=>{
  const f=await fixture(t),page=f.page;
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#play').textContent(),'Play');
  assert.match(await page.locator('#status').textContent(),/History loaded/);
  assert.equal(await page.locator('#source').getAttribute('placeholder'),'Enter an absolute path or choose a folder');
  assert.equal(await page.locator('#scrub').getAttribute('aria-label'),'Playback position');
  await page.locator('#source').fill('/original/path');
  await page.locator('#duration').fill('42');await page.locator('#time-zone').fill('UTC');
  await page.locator('#scrub').evaluate(el=>{el.value=7;el.dispatchEvent(new Event('input'));});
  const alice=historyState(sample,7).nodes.find(node=>node.id==='a');
  const bounds=await page.locator('#preview').boundingBox();
  await page.locator('#preview').click({position:{x:alice.x*bounds.width/1920,y:alice.y*bounds.height/1080}});
  assert.match(await page.locator('#author-stats').textContent(),/Alice.*Added/);
  let analyses=0;page.on('request',request=>{if(request.url().endsWith('/api/analyze'))analyses++;});
  await page.locator('#language').selectOption('zh-CN');
  assert.equal(await page.locator('#play').textContent(),'播放');assert.equal(await page.locator('#scrub').inputValue(),'7');
  assert.match(await page.locator('#author-stats').textContent(),/Alice.*新增/);
  assert.equal(await page.locator('#source').inputValue(),'/original/path');assert.equal(await page.locator('#duration').inputValue(),'42');
  assert.equal(await page.locator('#time-zone').inputValue(),'UTC');
  await page.locator('#accounts > summary').click();
  await page.locator('.account-row').nth(1).getByRole('button',{name:'关联到',exact:true}).click();
  await page.locator('.account-row select').nth(1).selectOption('a');
  assert(await page.locator('#export').isDisabled());
  await page.locator('#language').selectOption('en');
  assert.match(await page.locator('#account-status').textContent(),/Account links have changed/);
  assert.match(await page.locator('.account-row').nth(1).textContent(),/Linked to: Alice/);
  assert(await page.locator('#export').isDisabled());
  await page.locator('#play').click();await page.waitForFunction(()=>Number(document.querySelector('#scrub').value)>7);
  await page.locator('#language').selectOption('zh-CN');assert.equal(await page.locator('#play').textContent(),'暂停');
  await page.locator('#play').click();assert(Number(await page.locator('#scrub').inputValue())>7);
  assert.equal(analyses,0);
  await page.reload();await page.locator('#summary strong').first().waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  for(const width of [390,1000,1440]) {await page.setViewportSize({width,height:900});await page.locator('#language').selectOption('en');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.locator('#fullscreen').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='player');
  assert.equal(await page.locator('#fullscreen').textContent(),'Exit fullscreen');
  await page.evaluate(()=>{const control=document.querySelector('#language');control.value='zh-CN';control.dispatchEvent(new Event('change'));});
  assert.equal(await page.locator('#fullscreen').textContent(),'退出全屏');
  await page.locator('#fullscreen').click();await page.waitForFunction(()=>!document.fullscreenElement);
  const zh=await f.context.browser().newContext({locale:'zh-TW'});await zh.newPage().then(async p=>{await p.goto(f.origin);await p.locator('#summary strong').first().waitFor();assert.equal(await p.locator('html').getAttribute('lang'),'zh-CN');});await zh.close();
  const unsupported=await f.context.browser().newContext({locale:'fr-FR'});const p=await unsupported.newPage();await p.goto(f.origin);await p.locator('#summary strong').first().waitFor();assert.equal(await p.locator('html').getAttribute('lang'),'en');await unsupported.close();
});

test('analysis and export messages retranslate in flight, preserve snapshots and localize errors',{timeout:30000},async(t)=>{
  const f=await fixture(t),page=f.page;
  await page.route('**/api/branches',route=>route.fulfill({json:{ok:true,branches:['main'],defaultBranch:'main'}}));
  await page.locator('#source').fill('/test/repo');await page.locator('#source').blur();await page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
  await page.evaluate(()=>{
    const original=fetch;
    window.fetch=(url,options)=>{
      if(url==='/api/analyze'||url==='/api/export') {
        window.submitted=JSON.parse(options.body);return Promise.resolve(new Response(new ReadableStream({start(controller){window.controller=controller;}}),{headers:{'content-type':'application/x-ndjson'}}));
      }
      return original(url,options);
    };
  });
  const send=event=>page.evaluate(event=>window.controller.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n')),event);
  await page.locator('#analyze').click();await page.waitForFunction(()=>window.controller);
  assert.equal(await page.evaluate(()=>window.submitted.locale),'en');
  await send({type:'progress',stage:'retention',completed:2,total:9});await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('2/9'));
  await page.locator('#language').selectOption('zh-CN');assert.match(await page.locator('#status').textContent(),/分析最终存留.*2\/9/);
  await send({type:'complete',ok:true,manifest:sample});await page.evaluate(()=>window.controller.close());await page.waitForFunction(()=>!document.querySelector('#analyze').disabled);
  await page.locator('#language').selectOption('en');assert.match(await page.locator('#status').textContent(),/Generated 2 events \(first full analysis\)/);
  await page.evaluate(()=>window.controller=null);await page.locator('#export').click();await page.waitForFunction(()=>window.controller);
  assert.equal(await page.evaluate(()=>window.submitted.manifest.settings.locale),'en');
  await send({type:'progress',frame:3,total:9});await page.waitForFunction(()=>document.querySelector('#export-status').textContent.includes('3/9'));
  await page.locator('#language').selectOption('zh-CN');assert.match(await page.locator('#export-status').textContent(),/正在导出 3\/9/);
  assert.equal(await page.evaluate(()=>window.submitted.manifest.settings.locale),'en');
  await send({type:'complete',file:'/exports/sample.mp4'});await page.evaluate(()=>window.controller.close());await page.locator('#export-status a').waitFor();
  await page.locator('#language').selectOption('en');assert.equal(await page.locator('#export-status a').textContent(),'Download MP4');
  await page.locator('#export').click();await send({type:'error',error:'缺少本地 FFmpeg',errorCode:'error.ffmpegMissing'});await page.evaluate(()=>window.controller.close());await page.waitForFunction(()=>!document.querySelector('#export').disabled);
  assert.match(await page.locator('#export-status').textContent(),/Export failed: Local FFmpeg/);
  await page.locator('#language').selectOption('zh-CN');assert.match(await page.locator('#export-status').textContent(),/导出失败.*本地 FFmpeg/);
  await page.route('**/api/branches',route=>route.fulfill({json:{ok:false,error:'diagnostic',errorCode:'error.branchRemote'}}));
  await page.locator('#source').fill('/other');await page.locator('#source').blur();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('读取分支失败'));
  await page.locator('#language').selectOption('en');assert.match(await page.locator('#status').textContent(),/Cannot read branches.*Check the URL/);
  const failed=await fetch(f.origin+'/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'/missing'})});
  const result=await failed.json();assert.equal(result.errorCode,'error.notRepository');assert.equal(result.errorParams.repo,'/missing');assert.match(result.error,/不是 Git 仓库/);
  const analyzed=await f.analyze({source:f.repo,locale:'en'});assert.equal(analyzed.settings.locale,'en');
});
