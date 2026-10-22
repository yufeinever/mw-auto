import { Blocked, assert, available, button, dismiss, measure, paint } from './runtime.mjs';
import { skillPickerReady } from './skill-readiness.mjs';

const sentinel = '__MW_QA_NO_MATCH_20261020__';
const visible = ':visible';
const editor = p => p.locator('[contenteditable="true"][role="textbox"]').filter({visible:true}).first();
const recent = p => p.getByTestId('recent-tasks-scroll');
function note(c, message) { c.assertions.push(message); c.log(message); }
function partial(c, reason) { c.coverage='partial'; c.limitations.push(reason); }
async function need(l, reason) { await l.waitFor({state:'visible',timeout:6000}).catch(()=>{}); return available(l, reason); }
async function click(p,name) { await (await need(button(p,name),`当前版本缺少入口：${name}`)).click(); }
export async function home(c) {
  await dismiss(c.page);await click(c.page,'新建任务');
  await c.page.waitForFunction(()=>/^#\/workspace\/[^/]+\/session$/.test(location.hash)&&!Array.from(document.querySelectorAll('button')).some(e=>e.getClientRects().length&&e.textContent.trim()==='历史提问'),null,{timeout:8000});
  await need(editor(c.page),'新任务输入区未就绪');await paint(c.page);
}
export async function expandTasks(c) {
  const heading=c.page.locator('#recent-tasks-heading');
  const expand=heading.getByRole('button',{name:'展开',exact:true});
  if(await expand.isVisible()){
    await expand.click();
    c.defer(async()=>{const collapse=heading.getByRole('button',{name:'收起',exact:true});if(await collapse.isVisible())await collapse.click();});
  }
}
export async function history(c) {
  await home(c);
  await expandTasks(c);
  const row=recent(c.page).locator('button[data-slot="context-menu-trigger"]').first();
  await (await need(row,'当前没有可读取的历史任务；请准备一条已完成的测试会话')).click();
  await need(button(c.page,'历史提问'),'历史任务未加载，或未提供历史提问入口');
  await need(editor(c.page),'历史任务输入区不可见');
}
export async function workspace(c, type) {
  await dismiss(c.page); await click(c.page,/专家工作区:/);
  await need(c.page.getByPlaceholder('请输入关键词查询'),'市场搜索输入框未加载');await paint(c.page);
  const activeHeader=c.page.locator('main').first().getByRole('button',{name:type,exact:true}).first();
  if (!await activeHeader.isVisible().catch(()=>false)) {
    await click(c.page,'更多');
    const item=c.page.getByRole('menuitem',{name:type,exact:true});
    if(await item.isVisible().catch(()=>false))await item.click();
    else if(await activeHeader.isVisible().catch(()=>false))await dismiss(c.page);
    else await (await need(item,`模块菜单中缺少${type}`)).click();
  }
  await need(activeHeader,`${type}模块标题未就绪`);
  await need(c.page.getByPlaceholder('请输入关键词查询'),'市场搜索输入框未加载');
  await c.page.waitForFunction(()=>!Array.from(document.querySelectorAll('main')).some(e=>e.innerText.trim().endsWith('加载中...')),{},{timeout:8000}).catch(()=>{});
  if(type==='专家')await (await need(c.page.getByRole('button',{name:'专家',exact:true}).last(),'专家列表页签未找到')).click();
}
export async function cases(c) { await dismiss(c.page); await click(c.page,/案例库:/); await need(c.page.locator('.mw-case-card').first(),'案例服务未返回可用案例'); }
export async function preview(c) {
  await cases(c);
  const card=c.page.locator('.mw-case-card').filter({hasText:'供应链降本'}).first();
  await (await need(card,'缺少稳定案例夹具“供应链降本”')).click();
  await need(button(c.page,'效果预览'),'案例预览未就绪');
  await need(c.page.getByText('详细介绍',{exact:true}),'案例预览详情未加载');
}
async function mode(c) {
  const p=c.page; await click(p,'模式');
  const selected=p.getByRole('button',{name:/^(执行模式|计划模式)$/}).filter({has:p.locator('svg.lucide-check')});
  const original=(await (await need(selected,'无法识别原工作模式')).innerText()).trim();
  const target=original==='执行模式'?'计划模式':'执行模式';
  c.defer(async()=>{await dismiss(p);await click(p,'模式');await click(p,original);});
  await measure(c,()=>click(p,target),`() => !Array.from(document.querySelectorAll('button')).some(e => e.getClientRects().length && e.textContent.trim() === '${target}')`,'切换模式并关闭选择菜单');
  await click(p,'模式'); assert(await p.getByRole('button',{name:target,exact:true}).locator('svg.lucide-check').count(),'模式未回显为目标选项');
  note(c,'模式从原选项切至另一选项，重新打开菜单确认勾选；结束恢复原模式');
}
async function model(c) {
  const p=c.page; const composer=editor(p).locator('xpath=ancestor::div[.//button[@aria-label="模式"]][1]');
  const trigger=composer.locator('button[aria-label]').filter({has:p.locator('svg.lucide-chevron-down')});
  // Model is the chevron control whose accessible name is not a fixed capability label.
  const labels=await trigger.evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')).filter(x=>x&&!['模式','技能','专家','数智员工','工具','知识库','权限'].includes(x)));
  if(labels.length!==1) throw new Blocked('不能唯一识别模型按钮，需适配当前版本模型控件');
  const open=async()=>{if(!await p.getByRole('option').first().isVisible().catch(()=>false)) await click(p,labels[0]);};
  await open(); const selected=p.locator('[role="option"][data-checked="true"]');
  const original=(await (await need(selected,'模型菜单无原选项状态')).innerText()).trim();
  const alt=p.locator('[role="option"]:not([data-checked="true"]):not([data-disabled])').first();
  await need(alt,'没有第二个可切换模型'); const target=(await alt.innerText()).trim();
  const options=p.getByRole('option');
  c.defer(async()=>{await dismiss(p); const name=await trigger.evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')).find(x=>x&&!['模式','技能','专家','数智员工','工具','知识库','权限'].includes(x)));await click(p,name);await options.filter({hasText:original.split('\n').at(-1)}).last().click();});
  await measure(c,()=>alt.click(),'() => !Array.from(document.querySelectorAll(\'[role="option"]\')).some(e=>e.getClientRects().length)','切换模型并关闭菜单');
  const nextName=await trigger.evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')).find(x=>x&&!['模式','技能','专家','数智员工','工具','知识库','权限'].includes(x)));
  await click(p,nextName); assert((await p.locator('[role="option"][data-checked="true"]').innerText()).trim()===target,'模型勾选未更新');
  note(c,'切换模型后重新打开菜单确认选中项，结束恢复原模型；未发送模型请求');
}
async function skill(c) {
  const p=c.page;await dismiss(p);
  await measure(c,()=>click(p,'技能'),`(${skillPickerReady.toString()})`,'打开技能弹层至列表加载展示完成');
  note(c,'技能弹层搜索框、技能名称列表及可视资源加载完成');
  const box=p.getByRole('checkbox').filter({visible:true}).first();await need(box,'没有可绑定的已安装技能');
  const original=await box.getAttribute('aria-checked');const text=await box.locator('span.truncate').first().innerText();
  const target=original==='true'?'false':'true';
  c.defer(async()=>{await dismiss(p);await click(p,'技能');const b=p.getByRole('checkbox').filter({hasText:text}).first();if(await b.getAttribute('aria-checked')!==original)await b.click();});
  await measure(c,()=>box.click(),`() => Array.from(document.querySelectorAll('[role="checkbox"]')).find(e=>e.getClientRects().length)?.getAttribute('aria-checked') === '${target}'`,'技能选择开关');
  assert(await box.getAttribute('aria-checked')===target,'技能选择状态未更新');note(c,'已安装技能选择状态切换成功，结束恢复原选择；未执行技能');
}
async function tool(c) {
  const p=c.page;await click(p,'工具');const sw=p.getByRole('switch').first();await need(sw,'没有已连接工具的会话选择开关；请先配置测试工具');
  const original=await sw.getAttribute('aria-checked');const target=original==='true'?'false':'true';
  c.defer(async()=>{await dismiss(p);await click(p,'工具');if(await sw.getAttribute('aria-checked')!==original)await sw.click();});
  await measure(c,()=>sw.click(),`() => Array.from(document.querySelectorAll('[role="switch"]')).find(e=>e.getClientRects().length)?.getAttribute('aria-checked') === '${target}'`,'已连接工具的会话选择开关');
  assert(await sw.getAttribute('aria-checked')===target,'工具选择状态未更新');note(c,'已连接工具会话开关状态发生变化，结束恢复；不触发新授权或工具业务调用');
}
export async function search(c,kind) {
  const p=c.page;let input,keyword,positive;
  if(kind==='tasks') { await click(p,'搜索');input=p.getByPlaceholder('搜索任务',{exact:true});keyword=await recent(p).locator('button[data-slot="context-menu-trigger"]').first().locator('span').first().innerText();positive=()=>p.getByRole('dialog').getByRole('button').filter({hasText:keyword}).first(); }
  else if(kind==='chat') {await click(p,'搜索对话（Ctrl+F）');input=p.getByPlaceholder('搜索对话…');}
  else {input=p.getByPlaceholder('请输入关键词查询');keyword={专家:'文档生成专家',技能:'Office',工具:'百度地图',案例:'供应链降本'}[kind];}
  await need(input,'搜索输入框不可见');const original=await input.inputValue();
  c.defer(async()=>{if(await input.isVisible().catch(()=>false))await input.fill(original);await dismiss(p);});
  await input.fill('');await paint(p);
  await measure(c,()=>input.fill(sentinel),`() => Array.from(document.querySelectorAll('span,p,div')).some(e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && e.textContent.trim().length<80 && /无结果|无匹配|没有匹配|未匹配|暂无.*(?:结果|专家|技能|工具|案例)|未找到|没有找到|0\\s*\\/\\s*0/.test(e.textContent))`,'搜索无匹配结果呈现');
  const empty=p.getByText(/无结果|无匹配|没有匹配|未匹配|暂无.*(?:结果|专家|技能|工具|案例)|未找到|没有找到|0\s*\/\s*0/).filter({visible:true}).first();
  await need(empty,'输入无匹配词后，未找到明确的无结果终态');
  note(c,'无匹配关键词得到明确空结果状态');
  c.limitations.push('搜索计时仅覆盖无匹配分支，不代表命中查询、大数据量或冷启动性能');
  if(kind==='chat') {partial(c,'仅验证会话内无匹配搜索；未以真实内容校验匹配高亮与上下条跳转');return;}
  await input.fill(keyword);
  if(kind==='tasks') {await need(positive(),'已存在任务关键词未返回匹配结果');}
  else {await need(p.getByRole('button').filter({hasText:keyword}).filter({visible:true}).first(),'已知关键词未返回市场/案例记录');}
  note(c,'已有样本关键词返回可见结果；未记录任务标题和正文');
}

export async function execute(row,c) {
  const retry = await import('./retry-actions.mjs');
  if (retry.rows.includes(row)) return retry.executeRetry(row,c);
  const p=c.page;c.coverage='verified';
  if(row>=19&&row<=26) await history(c);
  else if(row>=27&&row<=31) await workspace(c,'专家');
  else if(row>=32&&row<=37) await workspace(c,'技能');
  else if(row>=38&&row<=39) await workspace(c,'工具');
  else if(row>=40&&row<=45) await cases(c);
  else if(row>=46) {await dismiss(p);await click(p,/自动化:/);await need(button(p,'从模板添加'),'自动化列表未就绪');}
  else await home(c);
  switch(row) {
    case 8: await search(c,'tasks');break;
    case 10:case 17:case 24:await tool(c);break;
    case 20:await search(c,'chat');break;
    case 14:case 21:await mode(c);break;
    case 15:case 22:await model(c);break;
    case 16:case 23:case 37:if(row===37)await home(c);await skill(c);if(row===37){for(const m of c.measurements){m.targetRelation='supporting';m.scope+='；用户确认的新映射，原表回跳耗时阈值不适用于此操作';}note(c,'按用户确认，037验证输入区技能弹层加载和已有技能选择；市场＋下载由036独立验证');c.limitations.push('当前映射为输入区技能加载与选择；原表市场添加后回跳任务的流程未由本项覆盖。');}break;
    case 30:await search(c,'专家');break;
    case 35:await search(c,'技能');break;
    case 39:await search(c,'工具');break;
    case 44:await search(c,'案例');break;
    case 47: {
      const records=p.locator('section').filter({has:p.getByRole('heading',{name:'已完成',exact:true})}).locator('div.cursor-pointer').filter({hasText:'成功'});
      const title=records.first().locator('span.w-32');await need(title,'没有可只读打开的成功自动化记录；不会点击补跑或运行');
      await measure(c,()=>title.click(),'() => /\\/session\\/[^/]+$/.test(location.hash) && Array.from(document.querySelectorAll(\'[role="textbox"]\')).some(e=>e.getClientRects().length)','自动化成功记录进入历史详情');
      await need(button(p,'历史提问'),'自动化记录未进入历史任务详情');note(c,'成功运行记录点击标题后进入历史任务详情，文本区及历史工具栏就绪；未点击运行或补跑');break;
    }
    default:throw new Blocked('待实现');
  }
}
