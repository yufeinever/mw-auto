import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ensureCdpConfig,readCdpConfig} from '../lib/cdp-config.mjs';
import {Manager} from '../lib/manager.mjs';
import {runColdStartup} from '../lib/cold-start.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cdp-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'build-info.json');
  const original='{\n  "packagedCdpAllowed": false, "other": "preserve"\n}\n';
  await fs.writeFile(file,original);return {root,file,original};
}
test('enables CDP only, backs up exact original and leaves enabled configuration unchanged',async t=>{
  const {root,file,original}=await fixture(t);
  assert.equal((await ensureCdpConfig({file})).changed,true);
  assert.equal(await fs.readFile(file,'utf8'),original.replace('false','true'));
  const backup=(await fs.readdir(root)).find(f=>f.endsWith('.bak'));
  assert.equal(await fs.readFile(path.join(root,backup),'utf8'),original);
  assert.equal((await ensureCdpConfig({file})).changed,false);
  assert.equal((await fs.readdir(root)).length,2);
});
test('running client with disabled flag is corrected but must restart; malformed config remains intact',async t=>{
  const {file}=await fixture(t);
  await assert.rejects(()=>ensureCdpConfig({file,running:true}),/重启生效/);
  assert.equal((await readCdpConfig(file)).enabled,true);
  for(const invalid of ['{broken','{"other":false}']){
    await fs.writeFile(file,invalid);
    await assert.rejects(()=>ensureCdpConfig({file}),/无法读取/);
    assert.equal(await fs.readFile(file,'utf8'),invalid);
  }
});
test('cold and combined preflight finish before creating any batch or worker',async t=>{
  const {root,file}=await fixture(t);let calls=0;
  const manager=new Manager(root,[{id:'a'}],{listProcesses:async()=>[1],spawnCase:async()=>{calls++;},ensureCdp:opts=>ensureCdpConfig({...opts,file})});
  t.after(()=>manager.close());await manager.init();
  await assert.rejects(()=>manager.startCombined(['a'],'manual'),/重启生效/);
  assert.equal(manager.active,null);assert.equal(manager.preparingCold,false);assert.equal(calls,0);assert.equal((await manager.list()).length,0);
  await fs.writeFile(file,'{"packagedCdpAllowed":false}');
  await assert.rejects(()=>manager.startCold(true,['a']),/重启生效/);
  assert.equal(calls,0);
});
test('worker checks configuration before process launch and before timing begins',async()=>{
  let launched=false,clockStarted=false;
  await assert.rejects(()=>runColdStartup({listProcesses:async()=>[],ensureCdp:async()=>{throw Error('CDP blocked');},launch:async()=>{launched=true;},now:()=>{clockStarted=true;return 0;}}),/CDP blocked/);
  assert.equal(launched,false);assert.equal(clockStarted,false);
});
