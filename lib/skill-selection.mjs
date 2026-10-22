import { assert, button } from './runtime.mjs';
import { skillPickerReady } from './skill-readiness.mjs';

export async function openSkillPicker(page){
  const input=page.getByPlaceholder('输入名称搜索...',{exact:true}).filter({visible:true});
  if(!await input.isVisible())await button(page,'技能').click();
  await page.waitForFunction(skillPickerReady,null,{timeout:8000});
}

export async function restoreSkillSelection(page,name,original){
  await openSkillPicker(page);
  // Exact label, no first-row assumption: selecting a skill may reorder the list.
  const row=page.getByRole('checkbox').filter({visible:true}).filter({has:page.locator('span.truncate').filter({hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
  assert(await row.count()===1,'无法唯一定位本轮技能，未修改其他选择');
  if(await row.getAttribute('aria-checked')!==original)await row.click();
  await page.waitForFunction(({name,original})=>{
    const rows=[...document.querySelectorAll('[role="checkbox"]')].filter(e=>e.getClientRects().length&&e.querySelector('span.truncate')?.textContent.trim()===name);
    return rows.length===1&&rows[0].getAttribute('aria-checked')===original;
  },{name,original},{timeout:5000});
}
