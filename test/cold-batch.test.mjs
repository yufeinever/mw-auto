import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../lib/manager.mjs';
import { VERSION } from '../lib/version.mjs';
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cold-batch-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const manager=new Manager(root,[{id:'a'},{id:'b'},{id:'c'}],options);await manager.init();return manager;
}
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition timeout');}
const startup={durationMs:20,launchAt:'2026-10-20T09:54:55.830Z',scope:'simulated launch'};
const result=(id,mode)=>({id,mode:'cold',functional:'pass',restored:true,measurements:[],...(mode==='cold'?{coldStart:startup}:{})});
test('one launch serves all selected cases, with references instead of duplicated startup measurements',async t=>{
 const calls=[];let processes=[];
 const m=await fixture(t,{listProcesses:async()=>processes,spawnCase:async(id,mode)=>{calls.push([id,mode]);processes=[123];return result(id,mode);}});
 const run=await m.startCold(true,['a','b','c']);await until(()=>!m.active);
 assert.deepEqual(calls,[['a','cold'],['b','after-cold-start'],['c','after-cold-start']]);
 assert.equal(run.status,'completed');assert.deepEqual(run.coldStart,startup);
 assert.equal(run.results[1].coldStart,undefined);assert.equal(run.results[1].startupPerformed,false);
 assert.deepEqual(run.results[1].batchStartupRef,{runId:run.id,caseId:'a'});
 assert.equal(run.logs.some(l=>/等待执行/.test(l.text)),false);
});
test('pause and resume never launch another MW inside the batch',async t=>{
 const calls=[];let release,processes=[];
 const m=await fixture(t,{listProcesses:async()=>processes,spawnCase:async(id,mode)=>{calls.push([id,mode]);processes=[123];if(id==='a')await new Promise(r=>release=r);return result(id,mode);}});
 const run=await m.startCold(true,['a','b']);await until(()=>!!release);await m.control('pause');release();await until(()=>run.status==='paused');
 await m.control('resume');await until(()=>!m.active);
 assert.deepEqual(calls,[['a','cold'],['b','after-cold-start']]);assert.equal(run.status,'completed');
});
test('lost original process stops remaining cases instead of silently relaunching',async t=>{
 let checks=0,calls=0;
 const m=await fixture(t,{listProcesses:async()=>++checks===2?[123]:[],spawnCase:async(id,mode)=>{calls++;return result(id,mode);}});
 const run=await m.startCold(true,['a','b']);await until(()=>!m.active);
 assert.equal(calls,1);assert.equal(run.status,'stopped');assert.equal(run.results.length,1);
});
test('missing startup evidence stops the queue without inventing a duration',async t=>{
 let processes=[],calls=0;
 const m=await fixture(t,{listProcesses:async()=>processes,spawnCase:async id=>{calls++;processes=[123];return result(id,'after-cold-start');}});
 const run=await m.startCold(true,['a','b']);await until(()=>!m.active);
 assert.equal(run.status,'stopped');assert.equal(calls,1);assert.equal(run.coldStart,undefined);
});
async function legacy(m){
 const run={id:'1234567890-legacy',version:'0.0.5',mode:'cold',status:'waiting_for_cold',startedAt:'2026-10-20',selected:['a','b','c'],results:[result('a','cold')],logs:[],current:null,pendingColdId:'b',repetitions:1,resumeCheckpoint:{processIds:[123],at:new Date().toISOString()}};
 await m.save(run);return run;
}
test('explicit upgrade resume preserves completed results and original version, and skips relaunch',async t=>{
 const calls=[];
 const m=await fixture(t,{listProcesses:async()=>[123],spawnCase:async(id,mode)=>{calls.push([id,mode]);return result(id,mode);}});
 const old=await legacy(m);await m.init();assert.equal((await m.read(old.id)).status,'interrupted');assert.equal(calls.length,0);
 const run=await m.resumeColdBatch(old.id);await until(()=>!m.active);
 assert.deepEqual(calls,[['b','after-cold-start'],['c','after-cold-start']]);
 assert.deepEqual(run.results[0],old.results[0]);assert.equal(run.version,'0.0.5');assert.equal(run.resumeVersion,VERSION);assert.equal(run.status,'completed');
});
test('resume rejects changed processes and missing checkpoint without executing anything',async t=>{
 let calls=0;const m=await fixture(t,{listProcesses:async()=>[999],spawnCase:async()=>calls++});
 const old=await legacy(m);await m.init();await assert.rejects(()=>m.resumeColdBatch(old.id),/进程已退出或改变/);
 old.status='stopped';delete old.resumeCheckpoint;await m.save(old);
 await assert.rejects(()=>m.resumeColdBatch(old.id),/检查点/);assert.equal(calls,0);assert.equal(m.preparingCold,false);
});
