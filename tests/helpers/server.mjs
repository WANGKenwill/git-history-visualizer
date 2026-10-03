import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../..',import.meta.url));

export async function serverFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'history-server-'));
  const app=join(dir,'app'), repo=join(dir,'repo');
  mkdirSync(app);mkdirSync(repo);
  for(const file of ['scripts','src','package.json','index.html','studio.html']) cpSync(join(root,file),join(app,file),{recursive:true});
  symlinkSync(join(root,'node_modules'),join(app,'node_modules'),'dir');
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.com');
  writeFileSync(join(repo,'app.js'),'one\n');git('add','.');git('commit','-m','first');
  const reservation=createServer();
  await new Promise(done=>reservation.listen(0,'127.0.0.1',done));
  const port=reservation.address().port;
  await new Promise(done=>reservation.close(done));
  const child=spawn(process.execPath,[join(app,'scripts/server.mjs')],{env:{...process.env,GIT_HISTORY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{
    if(child.exitCode===null){const closed=once(child,'close');child.kill();await closed;}
    rmSync(dir,{recursive:true,force:true});
  });
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error(stderr||'Server exited');})]);
  const analyze=async(body)=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({branch:'main',...body})});
    const result=await response.json();
    assert.equal(response.status,200,result.error);
    return result.manifest;
  };
  return {dir,repo,git,analyze,origin:`http://127.0.0.1:${port}`};
}
