import test from 'node:test';
import assert from 'node:assert/strict';
import {precomputeMotion,motionPosition} from '../src/motion.js';
import {prepareHistory,historyState} from '../src/visualizer.js';
const node=(id,x=960,y=555)=>({id,x,y,radius:40,envelope:52,finalChurn:1000});
const event=(id,size=6,churn=100,arrival=1,sx=225,sy=555)=>({id:`${id}-${arrival}-${sx}`,authorId:id,size,churn,arrival,sx,sy});
const distance=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y);

test('impact scales with area, zero changes have no impulse, opposite simultaneous impulses cancel',()=>{
  const nodes=[node('a')];
  const input=[event('a')], before=structuredClone(input);
  precomputeMotion(nodes,input,5);assert.deepEqual(input,before);
  const run=events=>precomputeMotion(nodes,events,5);
  const small=run([event('a',3)]),large=run([event('a',12)]),zero=run([event('a',12,0)]);
  assert(motionPosition(large,0,1.3).x-960>3*(motionPosition(small,0,1.3).x-960));
  assert.equal(motionPosition(zero,0,2).x,960);
  const opposite=run([event('a',6,100,1,225),event('a',6,100,1,1695)]);
  assert.equal(motionPosition(opposite,0,2).x,960);
  const speed=t=>distance(motionPosition(large,0,t),motionPosition(large,0,t+1/60))*60;
  assert(speed(3)<speed(1.1)*.3);
  assert.deepEqual(motionPosition(large,0,.5),{x:960,y:555});
});

test('pair forces separate close authors, gather distant authors and return their mass center',()=>{
  const run=(xs)=>precomputeMotion(xs.map((x,i)=>node(String(i),x)),xs.map((_,i)=>event(String(i),1.5,0)),5);
  const close=run([900,950]),far=run([650,1250]);
  assert(distance(motionPosition(close,0,2),motionPosition(close,1,2))>94);
  assert(distance(motionPosition(far,0,4),motionPosition(far,1,4))<600);
  const center=t=>(motionPosition(close,0,t).x+motionPosition(close,1,t).x)/2;
  assert(Math.abs(center(4)-960)<Math.abs(center(1)-960));
});

test('birth avoids occupied sites, inactive authors exert no force, non-grid impacts wait at most one tick',()=>{
  const solo=precomputeMotion([node('a')],[event('a')],5);
  const combined=precomputeMotion([node('a'),node('b')],[event('a'),event('b',6,100,3.001)],5);
  assert.deepEqual(motionPosition(solo,0,2),motionPosition(combined,0,2));
  assert(combined.births[1]>=3.001&&combined.births[1]-3.001<=1/60);
  assert(distance(motionPosition(combined,0,combined.births[1]),motionPosition(combined,1,combined.births[1]))>=94);
});

test('33 nodes / 180 seconds stay inside, do not overlap, and use under 4 MiB',()=>{
  const authors=Array.from({length:33},(_,i)=>({id:`p${i}`,name:'长姓名验证',churn:100+i,color:'#79dce8'}));
  const manifest={authors,commits:authors.map((a,i)=>({sha:`s${i}`,authorId:a.id,churn:a.churn,additions:a.churn,deletions:0,authoredAt:'2020-01-01T00:00:00Z',at:1})),duration:180,settings:{maxAuthors:32}};
  const started=performance.now(),scene=prepareHistory(manifest),elapsed=performance.now()-started;
  console.log(`33 节点 / 180 秒：预计算 ${elapsed.toFixed(1)} ms，位置缓存 ${(scene.motion.positions.byteLength/2**20).toFixed(3)} MiB`);
  assert(scene.motion.positions.byteLength<4*2**20);
  for(let t=2.7;t<180;t+=.37){const ns=historyState(manifest,t).nodes;for(let i=0;i<ns.length;i++){
    const a=ns[i];assert(Math.hypot((a.x-960)/(570-a.safeRadius),(a.y-555)/(290-a.safeRadius))<=1.001);
    for(let j=i+1;j<ns.length;j++)assert(distance(a,ns[j])>=a.safeRadius+ns[j].safeRadius-.5);
  }}
  assert.equal(historyState(manifest,180).churn,authors.reduce((s,a)=>s+a.churn,0));
  const direct=historyState(manifest,9);for(let t=0;t<12;t+=.1)historyState(manifest,t);
  assert.deepEqual(historyState(manifest,9),direct);historyState(manifest,2);assert.deepEqual(historyState(manifest,9),direct);
});
