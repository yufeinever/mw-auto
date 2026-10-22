import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConsole } from '../server.mjs';
import { loadPlaywright } from '../lib/dependencies.mjs';

test('browser confirms once and automatically runs both cold-batch cases',async t=>{
  const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cold-browser-'));
  await fs.mkdir(path.join(root,'data'));await fs.cp(path.join(source,'data/cases.json'),path.join(root,'data/cases.json'));await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  const calls=[],errors=[];let processes=[123];
  const app=await createConsole({port:0,projectRoot:root,managerOptions:{listProcesses:async()=>processes,spawnCase:async(id,mode)=>{
    calls.push({id,mode});processes=[123];return{id,mode,functional:'pass',restored:true,assertions:[],measurements:[],...(mode==='cold'?{coldStart:{durationMs:20,scope:'simulated launch'}}:{})};
  }}});
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(async()=>{await browser.close();await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.port}`);await page.locator('#total').filter({hasText:'44'}).waitFor();
  await page.locator('#run-cold:disabled').waitFor(); // Static total is present before the first state request finishes.
  assert.equal(await page.locator('#run-cold').isDisabled(),true);
  assert.equal(await page.locator('#run-cold').evaluate(e=>e.nextElementSibling.id),'run');
  await page.locator('input[data-id="MW-UI-004"]').check();await page.locator('input[data-id="MW-UI-005"]').check();
  await page.locator('#run-cold').click();await page.locator('#cold-target').filter({hasText:'已选择 2 项'}).waitFor();
  await page.locator('#cold-confirm').click();await page.locator('#cold-message').filter({hasText:'仍在运行'}).waitFor();assert.equal(calls.length,0);
  processes=[];await page.locator('#cold-confirm').click();
  await page.locator('#run-status').filter({hasText:'已完成'}).waitFor();await page.locator('#counter').filter({hasText:'2 / 2'}).waitFor();
  assert.deepEqual(calls,[{id:'MW-UI-004',mode:'cold'},{id:'MW-UI-005',mode:'after-cold-start'}]);assert.equal(await page.locator('#cold-dialog').isVisible(),false);assert.deepEqual(errors,[]);
  const base=`http://127.0.0.1:${app.port}`,state=await fetch(base+'/api/state').then(r=>r.json());
  assert.equal(state.runs.length,1);assert.equal(state.latestColdResults['MW-UI-005'].mode,'cold');assert.deepEqual(state.latestResults,{});
});
