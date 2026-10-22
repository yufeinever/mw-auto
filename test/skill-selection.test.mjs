import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {restoreSkillSelection} from '../lib/skill-selection.mjs';

test('skill cleanup reuses an open picker, finds exact reordered names, and verifies restoration',async t=>{
  const {chromium}=loadPlaywright();const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent(`<button aria-label="技能" onclick="window.opens++;document.querySelector('#picker').hidden=!document.querySelector('#picker').hidden">技能</button>
    <div id="picker"><input placeholder="输入名称搜索..."><button>添加技能</button><div id="list">
    <div role="checkbox" aria-checked="false"><span class="truncate">Alpha[1] extra</span></div>
    <div role="checkbox" aria-checked="true"><span class="truncate">Alpha[1]</span></div></div></div>
    <script>window.opens=0;document.querySelector('#list').onclick=e=>{const row=e.target.closest('[role="checkbox"]');if(row){row.setAttribute('aria-checked',row.getAttribute('aria-checked')==='true'?'false':'true');row.parentNode.prepend(row);}};</script>`);
  await restoreSkillSelection(page,'Alpha[1]','false');assert.equal(await page.evaluate(()=>window.opens),0);
  const states=await page.locator('[role="checkbox"]').evaluateAll(es=>es.map(e=>({name:e.textContent,state:e.getAttribute('aria-checked')})));
  assert.deepEqual(states,[{name:'Alpha[1]',state:'false'},{name:'Alpha[1] extra',state:'false'}]);
  await page.locator('[aria-label="技能"]').click();await restoreSkillSelection(page,'Alpha[1]','true');assert.equal(await page.evaluate(()=>window.opens),2);
  await page.locator('#list').evaluate(el=>el.append(el.firstElementChild.cloneNode(true)));
  await assert.rejects(()=>restoreSkillSelection(page,'Alpha[1]','false'),/唯一定位/);
  assert.equal(await page.locator('[aria-checked="true"]').count(),2);
});
