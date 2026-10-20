import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/version.mjs';
import { loadPlaywright } from '../lib/dependencies.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),base='http://127.0.0.1:17866';
const before=await fetch(base+'/api/state').then(r=>r.json());assert.equal(before.active,null);
const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  await page.locator('#total').filter({hasText:'44'}).waitFor();assert.equal(await page.locator('.version').textContent(),'v'+VERSION);
  assert.equal(await page.locator('#run-cold').isDisabled(),true);
  await page.locator('input[data-id="MW-UI-004"]').check();await page.locator('input[data-id="MW-UI-005"]').check();
  assert.equal(await page.locator('#run-cold').isEnabled(),true);assert.equal(await page.locator('#run').isEnabled(),true);
  const coldBox=await page.locator('#run-cold').boundingBox(),hotBox=await page.locator('#run').boundingBox();
  assert.ok(coldBox.x<hotBox.x&&Math.abs(coldBox.y-hotBox.y)<2,'selected cold and warm buttons must be adjacent on the same line');
  await page.screenshot({path:path.join(root,`data/console-v${VERSION}.png`)});
  await page.locator('#run-cold').click();await page.locator('#cold-target').filter({hasText:'已选择 2 项'}).waitFor();
  assert.match(await page.locator('#cold-dialog').innerText(),/每批只启动一次/);
  const readiness=await fetch(base+'/api/cold-readiness').then(r=>r.json());let gateChecked=false;
  if(readiness.runningCount){
    const response=page.waitForResponse(r=>r.url()===base+'/api/cold-start'&&r.request().method()==='POST');await page.locator('#cold-confirm').click();
    assert.equal((await response).status(),409);await page.locator('#cold-message').filter({hasText:'仍在运行'}).waitFor();gateChecked=true;
  }
  await page.screenshot({path:path.join(root,`data/cold-selection-v${VERSION}.png`)});await page.locator('#cold-cancel').click();
  const after=await fetch(base+'/api/state').then(r=>r.json());assert.equal(after.runs.length,before.runs.length);assert.equal(after.active,null);assert.deepEqual(errors,[]);
  const evidence={at:new Date().toISOString(),version:VERSION,browser:'Microsoft Edge headless',checks:['冷启动所选与热启动所选相邻','未选用例时两个按钮禁用','勾选2项后启用','批量托盘退出提示','取消后不创建批次'],gateChecked,pageErrors:errors,coldStartupMeasured:false};
  await fs.writeFile(path.join(root,`data/console-acceptance-v${VERSION}.json`),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();}
