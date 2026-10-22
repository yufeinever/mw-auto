import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {clearOwnedDraft,settledDraft,captureView,restoreView,TEST_DRAFT} from '../lib/state.mjs';
import {marketEntry,waitMarket} from '../lib/market.mjs';
import {aggregateWarm} from '../lib/manager.mjs';
import {search,newTaskEntry,waitHistoryRows} from '../lib/actions.mjs';
import {dismiss} from '../lib/runtime.mjs';

async function page(t){const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());return browser.newPage();}
test('draft cleanup preserves unknown content and rejects content returning after navigation',async t=>{
 const p=await page(t);await p.setContent('<div contenteditable="true" role="textbox">personal draft</div>');const c={page:p};
 await assert.rejects(()=>clearOwnedDraft(c,TEST_DRAFT),/未覆盖/);
 assert.equal(await settledDraft(p),'personal draft');
 await p.getByRole('textbox').fill(TEST_DRAFT);
 await assert.rejects(()=>clearOwnedDraft(c,TEST_DRAFT,()=>p.getByRole('textbox').fill(TEST_DRAFT)),/重新出现/);
 await clearOwnedDraft(c,TEST_DRAFT,async()=>{});assert.equal(await settledDraft(p),'');
 assert.ok(!JSON.stringify(c.diagnostics).includes(TEST_DRAFT));
});
test('view recovery verifies drafts instead of trusting a restored hash',async t=>{
 const p=await page(t);await p.setContent('<div contenteditable="true" role="textbox">personal draft</div>');
 const v=await captureView(p);await p.getByRole('textbox').fill('changed');
 await assert.rejects(()=>restoreView(p,v),/草稿状态发生变化/);
 assert.equal(await settledDraft(p),'changed');
});
test('market navigation clicks a visible target tab even when all tab labels exist',async t=>{
 const p=await page(t);await p.setContent('<main><button>技能</button><button id="tools">工具</button><h1>技能市场</h1><input placeholder="请输入关键词查询"></main><script>tools.onclick=()=>document.querySelector("h1").textContent="工具市场"</script>');
 const c={page:p};await (await marketEntry(c,'工具')).click();await waitMarket(c,'工具');
 assert.equal(await p.locator('h1').innerText(),'工具市场');
});
test('warmup diagnostics survive without contributing warmup performance samples',()=>{
 const first={functional:'blocked',restored:true,diagnostics:[{stage:'准备工具市场'}],failure:{kind:'precondition'},measurements:[]};
 const r=aggregateWarm('x',[first]);assert.deepEqual(r.warmup.diagnostics,first.diagnostics);assert.equal(r.warmup.failure.kind,'precondition');assert.deepEqual(r.measurements,[]);
});
test('tool search uses a present title instead of a hard-coded catalog item and restores the query',async t=>{
 const p=await page(t);await p.setContent(`<main><input placeholder="请输入关键词查询"><div role="button" id="card"><p data-slot="tooltip-trigger">新工具样本</p></div><p id="empty" hidden>没有匹配</p></main><script>document.querySelector('input').oninput=e=>{const hit=!e.target.value||'新工具样本'.includes(e.target.value);card.hidden=!hit;empty.hidden=hit;}</script>`);
 const cleanup=[],c={page:p,assertions:[],limitations:[],measurements:[],defer:f=>cleanup.push(f),log:()=>{}};
 await search(c,'工具');assert.equal(await p.getByPlaceholder('请输入关键词查询').inputValue(),'新工具样本');
 for(const f of cleanup.reverse())await f();assert.equal(await p.getByPlaceholder('请输入关键词查询').inputValue(),'');
 assert.equal(c.measurements.length,1);assert.ok(!JSON.stringify(c.diagnostics).includes('新工具样本'));
});
test('isolated new task uses its workspace action instead of the global new task',async t=>{
 const p=await page(t);await p.setContent('<button id="global">新建任务</button><div id="workspace"><button id="owned">新建任务</button></div><p id="result"></p><script>global.onclick=()=>result.textContent="personal";owned.onclick=()=>result.textContent="fixture";</script>');
 const c={page:p,fixtureEntry:{header:p.locator('#workspace'),button:p.locator('#owned')}};
 await (await newTaskEntry(c)).click();assert.equal(await p.locator('#result').textContent(),'fixture');
});
test('history preparation waits for delayed list data instead of treating its initial empty DOM as a result',async t=>{
 const p=await page(t);await p.setContent('<div data-testid="recent-tasks-scroll" id="rows"></div><script>setTimeout(()=>rows.innerHTML=\'<button data-slot="context-menu-trigger">fixture</button>\',250)</script>');
 const row=await waitHistoryRows({page:p});assert.equal(await row.count(),1);
});
test('cleanup closes a known preview that ignores Escape but does not accept unknown dialogs',async t=>{
 const p=await page(t);await p.setContent('<div role="dialog" id="preview"><button>效果预览</button><button aria-label="关闭" onclick="preview.remove()">x</button></div><div role="dialog" id="confirm"><button>确认删除</button></div>');
 await dismiss(p);assert.equal(await p.locator('#preview').count(),0);assert.equal(await p.locator('#confirm').count(),1);
});
test('case search reads the actual text-block title rather than requiring heading markup',async t=>{
 const p=await page(t);await p.setContent(`<main><input placeholder="请输入关键词查询"><div class="mw-case-card" id="card"><div class="truncate">案例样本</div></div><p id="empty" hidden>没有匹配</p></main><script>document.querySelector('input').oninput=e=>{const hit=!e.target.value||'案例样本'.includes(e.target.value);card.hidden=!hit;empty.hidden=hit;}</script>`);
 const c={page:p,assertions:[],limitations:[],measurements:[],defer:()=>{},log:()=>{}};
 await search(c,'案例');assert.equal(await p.getByPlaceholder('请输入关键词查询').inputValue(),'案例样本');
});
