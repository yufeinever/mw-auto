import { Blocked, button, stage } from './runtime.mjs';

export const marketMarkers={专家:'精选专家/专家团',技能:'技能市场',工具:'工具市场'};
export async function marketEntry(c,type) {
  stage(c,`准备${type}市场：定位导航`);
  const p=c.page;
  const tab=p.locator('main').getByRole('button',{name:type,exact:true}).filter({visible:true}).first();
  if(await tab.isVisible())return tab;
  const more=button(p,'更多');
  if(!await more.isVisible())throw new Blocked(`${type}市场导航缺失：未找到直显页签或更多菜单`);
  await more.click();
  const item=p.getByRole('menuitem',{name:type,exact:true});await item.waitFor();return item;
}
export async function waitMarket(c,type) {
  stage(c,`准备${type}市场：核验目标内容`);
  await c.page.getByText(marketMarkers[type],{exact:true}).filter({visible:true}).first().waitFor();
  await c.page.getByPlaceholder('请输入关键词查询').waitFor();
  await c.page.waitForFunction(()=>![...document.querySelectorAll('main [aria-busy="true"],main [role="progressbar"]')].some(e=>e.getClientRects().length),null,{timeout:10000});
}
