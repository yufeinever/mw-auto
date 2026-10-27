import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProbeManager} from '../lib/probe-manager.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('timed out');await delay(5);}}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-continuous-')),browsers=[];
  const connect=async()=>{
    const browser=new EventEmitter(),context=new EventEmitter(),page=new EventEmitter(),session=new EventEmitter();
    session.send=async()=>({});session.detach=async()=>{};page.context=()=>context;
    context.newCDPSession=async()=>session;context.pages=()=>[page];browser.contexts=()=>[context];browser.close=async()=>browser.emit('disconnected');
    browser.session=session;browsers.push(browser);return browser;
  };
  const manager=new ProbeManager(root,{connect,...options});await manager.init();
  t.after(async()=>{await manager.close();await fs.rm(root,{recursive:true,force:true});});
  return {manager,browsers};
}
function request(browser){browser.session.emit('Network.requestWillBeSent',{requestId:'1',timestamp:1,wallTime:1700000001,request:{url:'http://127.0.0.1/health?token=SECRET',method:'GET'}});}

test('continuous idle segments preserve evidence, session identity and manual stop cancels renewal',async t=>{
  const {manager,browsers}=await fixture(t,{continuousSegmentMs:150});
  const first=await manager.start({application:true},{seconds:0,scenario:'idle'});request(browsers[0]);
  await until(()=>manager.active?.monitoring?.segment===2&&manager.active.state==='recording');
  const second=manager.snapshot(),saved=await manager.read(first.id);
  assert.equal(second.requestedSeconds,0);assert.equal(second.monitoring.id,first.id);assert.equal(second.monitoring.previousId,first.id);
  assert.equal(saved.application.requests,1);assert.equal(saved.stopReason,'定期分段');assert.ok(second.monitoring.gapMs>=0);assert.equal(second.application.requests,0);
  assert.doesNotMatch(JSON.stringify(saved),/SECRET/);
  request(browsers[1]);const stopped=await manager.stop();assert.equal(stopped.application.requests,1);
  const count=browsers.length;await delay(180);assert.equal(browsers.length,count);assert.equal(manager.active,null);assert.equal(manager.continuous,null);
  const reloaded=new ProbeManager(path.dirname(path.dirname(manager.dir)));await reloaded.init();assert.equal(reloaded.history.length,2);assert.equal(reloaded.history[0].monitoring.id,first.id);
});

test('continuous capacity rollover releases old arrays and starts fresh collectors',async t=>{
  const {manager,browsers}=await fixture(t,{continuousSegmentMs:60000,maintenanceMs:10});
  const first=await manager.start({application:true},{seconds:0,scenario:'idle'});request(browsers[0]);manager.active.bytes=49*1024*1024;
  await until(()=>manager.active?.monitoring?.segment===2&&manager.active.state==='recording');
  assert.equal((await manager.read(first.id)).stopReason,'容量分段');assert.equal(manager.active.bytes,0);assert.equal(manager.active.page.rows.length,0);
  await manager.stop();
});

test('manual stop during rotation cancels next segment, and CDP loss does not retry forever',async t=>{
  const {manager,browsers}=await fixture(t,{continuousSegmentMs:60000});
  await manager.start({application:true},{seconds:0,scenario:'idle'});
  const rotating=manager.rotate(manager.active,'定期分段');await manager.stop();await rotating;
  assert.equal(manager.active,null);assert.equal(browsers.length,1);
  await manager.start({application:true},{seconds:0,scenario:'idle'});browsers[1].emit('disconnected');
  await until(()=>manager.active===null);assert.equal(manager.history[0].status,'partial');assert.equal(manager.continuous,null);
});

test('continuous validation rejects operation and invalid durations; finite timer still stops',async t=>{
  const {manager}=await fixture(t);
  await assert.rejects(manager.start({application:true},{seconds:0,scenario:'operation'}),/仅用于静置/);
  for(const seconds of [-1,1,9000,NaN])await assert.rejects(manager.start({application:true},{seconds,scenario:'idle'}),/记录时长/);
  await manager.start({application:true},{seconds:5,scenario:'idle'});assert.equal(manager.snapshot().monitoring,undefined);
  await delay(5100);await until(()=>manager.active===null);assert.equal(manager.history.length,1);assert.equal(manager.continuous,null);
});

test('unavailable collectors end continuous mode instead of creating endless failed segments',async t=>{
  const {manager}=await fixture(t,{connect:async()=>{throw Error('offline');},continuousSegmentMs:10});
  const failed=await manager.start({application:true},{seconds:0,scenario:'idle'});
  assert.equal(failed.status,'failed');await delay(30);assert.equal(manager.active,null);assert.equal(manager.continuous,null);assert.equal(manager.history.length,1);
});

test('a premature stop rejection does not silently cancel renewal, and close during startup cleans up',async t=>{
  const {manager,browsers}=await fixture(t);const connect=manager.options.connect;let release;
  manager.options.connect=async()=>{await new Promise(r=>release=r);return connect();};
  const starting=manager.start({application:true},{seconds:0,scenario:'idle'});
  await until(()=>release);await assert.rejects(manager.stop(),/正在启动/);assert.notEqual(manager.continuous.cancelled,true);
  await manager.close();release();await starting;assert.equal(manager.active,null);assert.equal(manager.continuous,null);assert.equal(browsers.length,1);
});
