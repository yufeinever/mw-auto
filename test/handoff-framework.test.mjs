import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Manager, aggregateWarm } from '../lib/manager.mjs';
import { executeWorker } from '../lib/worker.mjs';
import { inspectHandoff, viewFingerprint } from '../lib/handoff.mjs';

async function until(check){for(let i=0;i<300;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('condition timeout');}
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-handoff-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('serial queue records all failures and cleanup issues; only manual pause or stop interrupts the plan',async t=>{
  const root=await temp(t),calls=[];let release;
  const m=new Manager(root,['a','b','c','d','e'].map(id=>({id})),{warmRepetitions:1,
    spawnCase:async id=>{calls.push(id);if(id==='c')await new Promise(r=>release=r);return {id,functional:id==='a'?'failed':id==='b'?'interrupted':'blocked',restored:false,cleanupIssues:['synthetic cleanup issue']};}});
  t.after(()=>m.close());await m.init();const run=await m.start(['a','b','c','d','e']);
  await until(()=>!!release);assert.deepEqual(calls,['a','b','c']);assert.equal(run.stopRequested,undefined);
  await assert.rejects(()=>m.start(['e']),/占用/);
  await m.control('pause');release();await until(()=>run.status==='paused');
  assert.equal(run.results[1].functional,'interrupted');assert.equal(run.results[1].restored,false);
  assert.equal(aggregateWarm('b',[run.results[1]],2).functional,'interrupted');
  await m.control('resume');await until(()=>!m.active);
  assert.deepEqual(calls,['a','b','c','d','e']);assert.equal(run.status,'completed');assert.equal(run.schedulingHold,false);
  release=null;const second=await m.start(['c','e']);await until(()=>!!release);await m.control('stop');release();await until(()=>!m.active);
  assert.equal(second.status,'stopped');assert.equal(second.results.length,1);assert.equal(second.results[0].restored,false);
});

test('timeout retains last stage and waits for the actual worker process to exit',async t=>{
  const root=await temp(t),pidFile=path.join(root,'pid.txt'),worker=path.join(root,'worker.mjs');
  await fs.writeFile(worker,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send({type:'progress',stage:'封面 12/44'});console.log(JSON.stringify({functional:'pass',restored:true}));setInterval(()=>{},1000);`);
  const progress=[];const result=await executeWorker({file:worker,cwd:root,timeoutMs:1200,onProgress:p=>progress.push(p)});
  const pid=Number(await fs.readFile(pidFile,'utf8'));
  assert.throws(()=>process.kill(pid,0));assert.equal(result.workerExited,true);
  assert.equal(result.functional,'interrupted');assert.equal(result.restored,false);
  assert.equal(result.failure.stage,'封面 12/44');assert.equal(progress.at(-1).stage,'封面 12/44');
  assert.match(result.reason,/已确认执行进程退出/);
});

test('handoff inspection requires completed cleanup and preserves drafts and unknown dialogs',async()=>{
  const original={hash:'#/explore',hasDraft:false,search:''};let current=original,overlays=0,connections=0,closed=0;
  const connect=async()=>{connections++;return {browser:{close:async()=>{closed++;}},page:{evaluate:async()=>current,locator:()=>({filter:()=>({count:async()=>overlays})})}};};
  const checkpoint={cleanupComplete:false,fingerprint:viewFingerprint(original)};
  assert.equal((await inspectHandoff(checkpoint,connect)).ready,false);assert.equal(connections,0);
  checkpoint.cleanupComplete=true;overlays=1;assert.equal((await inspectHandoff(checkpoint,connect)).ready,false);
  overlays=0;current={...original,search:'user unsent input'};assert.equal((await inspectHandoff(checkpoint,connect)).ready,false);
  assert.equal(current.search,'user unsent input');current=original;
  assert.equal((await inspectHandoff(checkpoint,connect)).ready,true);assert.equal(connections,closed);
});
