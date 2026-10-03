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
