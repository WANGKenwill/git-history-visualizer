import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('license generation includes transitive notices, is deterministic and preserves output on incomplete inputs',t=>{
  const root=mkdtempSync(join(tmpdir(),'history-licenses-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'scripts'));cpSync(new URL('../scripts/update-licenses.mjs',import.meta.url),join(root,'scripts/update-licenses.mjs'));
  const packages={'':{dependencies:{direct:'1.0.0'}},'node_modules/direct':{version:'1.0.0'},'node_modules/transitive':{version:'2.0.0'}};
  writeFileSync(join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages}));
  for(const [name,version] of [['direct','1.0.0'],['transitive','2.0.0']]){
    const dir=join(root,'node_modules',name);mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'package.json'),JSON.stringify({name,version,license:'MIT'}));
    writeFileSync(join(dir,'LICENSE'),'Permission to use this test package.\n');
    writeFileSync(join(dir,'NOTICE'),`Notice for ${name}.\n`);
    writeFileSync(join(dir,'ThirdPartyNotices.txt'),`Bundled components for ${name}.\n`);
    mkdirSync(join(dir,'lib','nested'),{recursive:true});
    writeFileSync(join(dir,'lib','nested','bundle.js.LICENSE'),`Bundled license for ${name}.\n`);
    writeFileSync(join(dir,'lib','nested','bundle.js'),'Unrelated bundle content.\n');
  }
  const script=join(root,'scripts/update-licenses.mjs'),output=join(root,'LICENSES_THIRD_PARTY.md');
  execFileSync(process.execPath,[script]);const original=readFileSync(output,'utf8');
  assert.match(original,/direct 1\.0\.0/);assert.match(original,/transitive 2\.0\.0/);
  assert.match(original,/Permission to use/);assert.match(original,/Notice for transitive/);
  for(const name of ['direct','transitive']){
    assert.ok(original.includes(`### ThirdPartyNotices.txt\n\nBundled components for ${name}.`));
    assert.ok(original.includes(`### ${join('lib','nested','bundle.js.LICENSE')}\n\nBundled license for ${name}.`));
  }
  assert.doesNotMatch(original,/Unrelated bundle content/);
  execFileSync(process.execPath,[script]);assert.equal(readFileSync(output,'utf8'),original);
  const pkgPath=join(root,'node_modules/direct/package.json');
  writeFileSync(pkgPath,JSON.stringify({name:'direct',version:'9.0.0',license:'MIT'}));
  let result=spawnSync(process.execPath,[script],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/安装版本与锁文件不一致/);assert.equal(readFileSync(output,'utf8'),original);
  writeFileSync(pkgPath,JSON.stringify({name:'direct',version:'1.0.0',license:'MIT'}));
  rmSync(join(root,'node_modules/transitive/LICENSE'));
  result=spawnSync(process.execPath,[script],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/transitive 缺少许可证文本/);assert.equal(readFileSync(output,'utf8'),original);
  writeFileSync(pkgPath,JSON.stringify({name:'direct',version:'1.0.0'}));
  result=spawnSync(process.execPath,[script],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/direct 缺少许可证标识/);assert.equal(readFileSync(output,'utf8'),original);
});
