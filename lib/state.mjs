import { Blocked, assert, dismiss, stage } from './runtime.mjs';
import { marketEntry, waitMarket } from './market.mjs';

export const TEST_DRAFT='__MW_QA_INPUT_ONLY__';
export const editor=p=>p.locator('[contenteditable="true"][role="textbox"]').filter({visible:true}).first();
export async function writeDraft(p,text) {
  const input=editor(p);await input.click();await input.press('ControlOrMeta+A');await input.press('Backspace');
  if(text)await p.keyboard.insertText(text);
  await input.blur();
}

// Values stay in worker memory only. Diagnostics persist stages, never content.
export async function settledDraft(p) {
  const input=editor(p);await input.waitFor();
  await input.evaluate(e=>{delete e.__mwDraftSettle;});
  await p.waitForFunction(()=>{
    const e=[...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(e=>e.getClientRects().length);
    if(!e)return false;
    const text=e.textContent,now=performance.now(),s=e.__mwDraftSettle;
    if(!s||s.text!==text){e.__mwDraftSettle={text,at:now};return false;}
    return now-s.at>=500;
  },null,{timeout:8000});
  return (await input.innerText()).trim();
}

export async function requireEmptyDraft(c) {
  stage(c,'核验空白草稿');
  if(await settledDraft(c.page))throw new Blocked('当前新任务有未发送草稿，未覆盖；请保留草稿后使用空白测试空间');
}

export async function clearOwnedDraft(c,expected,reenter) {
  stage(c,'清理本轮测试草稿');
  const p=c.page,text=await settledDraft(p);
  assert(!text||text===expected,'草稿与本轮测试内容不符，未覆盖');
  await writeDraft(p,'');
  assert(!(await settledDraft(p)),'清空测试草稿未生效');
  if(reenter)await reenter();
  assert(!(await settledDraft(p)),'返回页面后测试草稿重新出现，停止后续执行');
  stage(c,'测试草稿清理及返回复核通过');
}

export async function captureView(p) {
  const view=await p.evaluate(()=>{
    const visible=e=>!!e.getClientRects().length;
    const input=[...document.querySelectorAll('input[placeholder="请输入关键词查询"]')].find(visible);
    const draft=[...document.querySelectorAll('[role="textbox"][contenteditable="true"]')].find(visible);
    const market=[...document.querySelectorAll('main button')].find(e=>visible(e)&&e.className.includes('mw-workspace-tab-active-bg')&&['技能','专家','工具'].includes(e.textContent.trim()))?.textContent.trim();
    return {hash:location.hash,hasDraft:!!draft,search:input?.value??null,market};
  });
  if(view.hasDraft)view.draft=await settledDraft(p);
  return view;
}

export async function restoreView(p,view) {
  await dismiss(p);
  await p.evaluate(hash=>{location.hash=hash;},view.hash);
  await p.waitForFunction(hash=>location.hash===hash,view.hash);
  if(view.market){const c={page:p};await (await marketEntry(c,view.market)).click();await waitMarket(c,view.market);}
  if(view.search!==null){
    const search=p.getByPlaceholder('请输入关键词查询');await search.waitFor();
    if(await search.inputValue()!==view.search)await search.fill(view.search);
    assert(await search.inputValue()===view.search,'搜索条件未恢复');
  }
  if(view.hasDraft)assert(await settledDraft(p)===view.draft,'原页面草稿状态发生变化，未覆盖');
  await p.waitForFunction(()=>![...document.querySelectorAll('[role="menu"],[role="dialog"],[data-slot="popover-content"]')].some(e=>e.getClientRects().length),null,{timeout:3000});
}
