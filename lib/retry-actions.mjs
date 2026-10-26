import { Blocked, assert, button, dismiss, measure, paint, stage } from './runtime.mjs';
import { TEST_DRAFT, requireEmptyDraft, clearOwnedDraft, settledDraft, writeDraft } from './state.mjs';
import { marketEntry } from './market.mjs';
import { home, newTaskEntry, history, expandTasks, waitHistoryRows, workspace, cases, preview, search } from './actions.mjs';
import { gallerySnapshot, galleryComplete } from './case-gallery.mjs';
import { installRendering, waitSurface } from './render-readiness.mjs';

export const rows = [4,5,6,7,9,11,12,13,18,19,25,26,27,28,29,31,32,33,34,36,38,40,41,42,43,45,46];
const ed = p => p.locator('[contenteditable="true"][role="textbox"]').filter({visible:true}).first();
const taskRows = p => p.getByTestId('recent-tasks-scroll').locator('button[data-slot="context-menu-trigger"]');
const note = (c,s) => {c.assertions.push(s);c.log(s);};
function partial(c,s) {if(!c.renderOnly)c.coverage='partial';c.limitations.push(s);}
async function click(p,name) {await button(p,name).click();}

// Readiness is evaluated in the same renderer as the input-event clock. No page
// text, input values, response bodies, URLs or credentials are persisted here.
async function instrumentation(p) {
  await installRendering(p);
}
const terminal = expr => `() => {const q=window.__mwQA;return !!q && (${expr});}`;
async function timed(c,action,expr,label,{supporting=false,timeout=10000,region=null,allowAlreadySatisfied=false}={}) {
  const sample=await measure(c,action,terminal(expr),label,{timeoutMs:timeout,region,allowAlreadySatisfied});
  sample.targetRelation=supporting?'supporting':'direct';
  sample.scope+='；'+(supporting?'补充场景，不与原表该项阈值比较':'本标签声明的可见 DOM、字体、已进入可视区域图片及有限动画就绪');
  return sample;
}
async function idle(p,expr) {await p.waitForFunction(terminal(expr),null,{timeout:15000});}
async function renderSelection(c,target,label,region='main') {
  if(!await target.isVisible())throw new Blocked('当前页面没有可操作的切换入口');
  const marker='mw-render-'+Date.now();
  await target.evaluate((e,marker)=>{e.setAttribute('data-mw-render-target',marker);},marker);
  c.defer(()=>c.page.locator(`[data-mw-render-target="${marker}"]`).evaluateAll(es=>es.forEach(e=>e.removeAttribute('data-mw-render-target'))));
  await timed(c,()=>target.click(),`q.ready(document.querySelector(${JSON.stringify(region)}))`,label,{region,allowAlreadySatisfied:true});
}
async function renderCategory(c,label){
  const buttons=c.page.locator('main button.rounded-full').filter({visible:true});
  const states=await buttons.evaluateAll(es=>es.map(e=>({selected:e.className.includes('border-[var(--mw-brand)]')||e.getAttribute('aria-pressed')==='true',disabled:e.disabled})));
  const original=states.findIndex(s=>s.selected),next=states.findIndex(s=>!s.selected&&!s.disabled);
  if(original<0||next<0)throw new Blocked('当前列表没有可识别的分类切换入口；不猜测或修改未知筛选');
  c.defer(()=>buttons.nth(original).click());
  await renderSelection(c,buttons.nth(next),label);
  note(c,'分类选中状态更新且结果区渲染完成；不核对分类名称、卡片归属及数量');
}
async function freshHome(c,label) {
  // Only navigate away; rendering the home page must not require remote cases.
  await dismiss(c.page);await click(c.page,/案例库:/);
  const entry=await newTaskEntry(c);
  await timed(c,()=>entry.click(),'/\\/session$/.test(location.hash) && q.editor()?.isContentEditable && q.ready(q.main())',label,{region:'main'});
  if(c.fixtureHash)assert(await c.page.evaluate(()=>location.hash)===c.fixtureHash,'加载终点不属于本轮独立工作空间');
}
async function openHistory(c,{content=false,supporting=false}={}) {
  await home(c);await expandTasks(c);const p=c.page;
  await waitHistoryRows(c);
  await timed(c,()=>taskRows(p).first().click(),`/\\/session\\/[^/]+$/.test(location.hash) && q.editor() && q.ready(q.main())`,content?'点击历史任务至首屏消息及界面就绪':'点击历史任务至详情和输入区就绪',{supporting,region:'main'});
}
async function loadMarket(c,type) {
  const p=c.page;
  let entry;
  await workspace(c,type);await home(c);
  await timed(c,()=>click(p,/专家工作区:/),`q.visible(document.querySelector('main input[placeholder="请输入关键词查询"]')) && q.ready(q.main())`,`${type}市场进入至首屏内容就绪`,{region:'main'});
  note(c,`${type}市场结构及可视区域渲染就绪，正常空态有效，不核对卡片名称`);
  partial(c,'当前进程热态首屏；未滚动穷尽服务端分页数据，不代表冷启动或离屏元素全部加载');
}
async function fixture(c) {
  const p=c.page,name=`MW-QA-v002-${Date.now()}`;let createdHash;
  c.stage='准备独立测试空间';await home(c);const baseHash=await p.evaluate(()=>location.hash);
  const baseDraft=await settledDraft(p);
  const picker=()=>p.locator('main button[data-slot="popover-trigger"]:not([aria-label])').filter({visible:true});
  assert(await picker().count()===1,'不能唯一识别活动工作空间切换器，未创建夹具');
  const baseName=(await picker().innerText()).trim();
  const section=p.getByTestId('workspace-section'),expand=section.getByRole('button',{name:'展开',exact:true}),collapsed=await expand.isVisible();
  if(collapsed){await expand.click();c.defer(async()=>{const b=section.getByRole('button',{name:'收起',exact:true});if(await b.isVisible())await b.click();});}
  await dismiss(p);await click(p,'添加工作空间');
  await p.getByRole('menuitem',{name:'默认存储空间创建',exact:true}).click();
  await p.getByPlaceholder('请输入工作空间名称').fill(name);
  // Register cleanup before confirmation so a delayed creation is not forgotten.
  c.defer(async()=>{
    c.stage='切回原空间并删除测试空间';
    await dismiss(p);
    const header=p.getByTestId('workspace-scroll').locator('[data-workspace-row-header]').filter({has:p.getByText(name,{exact:true})});
    if(!await header.count())return;
    // Leave the fixture before deleting it so the active runtime never points
    // at a workspace that has just been removed.
    c.stage='通过界面恢复原活动工作空间';
    delete c.fixtureEntry;delete c.fixtureHash;
    await picker().click();
    await p.locator('[data-slot="popover-content"]').getByRole('button',{name:baseName,exact:true}).click();
    // Selecting a workspace may resume its last historical session. Requiring
    // the empty-draft route would incorrectly reject this valid UI behavior.
    await p.waitForFunction(id=>location.hash.split('/')[2]===id&&Array.from(document.querySelectorAll('[role="textbox"]')).some(e=>e.getClientRects().length),baseHash.split('/')[2],{timeout:15000});
    await home(c);
    const returned=(await ed(p).innerText()).trim();
    if(returned!==baseDraft){
      const generated=c.fixtureGeneratedText||'';
      assert(!returned||(generated&&returned===generated),'原空间草稿出现未知变化，未覆盖');
      await writeDraft(p,baseDraft);
    }
    assert(await settledDraft(p)===baseDraft,'原空间草稿未恢复');
    await home(c);assert(await settledDraft(p)===baseDraft,'返回原空间后草稿未保持');
    await paint(p);
    await header.hover();await header.locator('[aria-haspopup="menu"]').click();
    await p.getByRole('menuitem',{name:'删除工作空间',exact:true}).click();
    await p.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();
    await header.waitFor({state:'detached'});
    c.stage='刷新清理后的运行时配置';
    const reload=button(p,'立即重新加载');
    await reload.waitFor({timeout:2000}).catch(()=>{});
    if(await reload.isVisible()){
      await reload.click();
      await p.getByText('需要重新加载',{exact:true}).waitFor({state:'hidden',timeout:20000});
    }
    note(c,'清空夹具后经 UI 切回原活动空间，删除测试空间；待生效配置若出现则完成重新加载');
  });
  await p.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  c.stage='等待测试空间注册';await p.getByTestId('workspace-scroll').getByText(name,{exact:true}).waitFor({state:'attached',timeout:15000});
  const header=p.getByTestId('workspace-scroll').locator('[data-workspace-row-header]').filter({has:p.getByText(name,{exact:true})});
  c.stage='从测试空间新建空白任务';await header.hover();await header.locator('[data-workspace-actions] button').first().click();
  await p.waitForFunction(()=>/^#\/workspace\/[^/]+\/session$/.test(location.hash));
  createdHash=await p.evaluate(()=>location.hash);assert(createdHash.split('/')[2]!==baseHash.split('/')[2],'没有切换到独立测试空间');
  c.fixtureHash=createdHash;c.fixtureEntry={header,button:header.locator('[data-workspace-actions] button').first()};
  c.defer(async()=>{
    c.stage='清空测试空间草稿及专家绑定';await dismiss(p);
    await header.hover();await header.locator('[data-workspace-actions] button').first().click();
    await p.waitForFunction(hash=>location.hash===hash,createdHash,{timeout:15000});
    const input=ed(p);await input.waitFor({timeout:15000});
    await p.waitForFunction(()=>{const e=Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]')).find(e=>e.getClientRects().length);if(!e)return false;const text=e.textContent,now=performance.now();const w=window.__mwDraftSettle;if(!w||w.text!==text){window.__mwDraftSettle={text,at:now};return false;}return now-w.at>=300;},null,{timeout:10000});
    c.fixtureGeneratedText=await settledDraft(p);await clearOwnedDraft(c,c.fixtureGeneratedText,async()=>{await home(c);});
    const bar=p.locator('[data-composer-toolbar-item="expert"]').filter({visible:true}).first();
    if(await bar.count()){await bar.hover();const exit=bar.getByRole('button',{name:/^退出「/});if(await exit.isVisible())await exit.click();}
  });
  const initialDraft=await settledDraft(p);
  // Some builds carry the current composer draft into a newly created space.
  // Only this newly-owned space is cleared; the original is restored and checked.
  assert(!initialDraft||initialDraft===baseDraft,'独立测试空间出现未知草稿，停止测试');
  if(initialDraft){await writeDraft(p,'');assert(!(await settledDraft(p)),'独立测试空间草稿未清空');}
  c.stage='测试空间已就绪';
  note(c,'通过产品 UI 创建本轮独立工作空间；结束清空测试草稿并删除空间注册');
  return name;
}
async function uninstallAddedSkill(p,name) {
  await dismiss(p);await workspace({page:p},'技能');
  await click(p,/^已安装技能/);
  const more=button(p,`打开${name}更多操作`);
  await more.waitFor({timeout:10000});await more.click();
  await p.getByRole('menuitem',{name:'卸载',exact:true}).click();
  await p.getByRole('dialog').getByRole('button',{name:'卸载',exact:true}).click();
  await more.waitFor({state:'hidden',timeout:15000});
}

export async function executeRetry(row,c) {
  const p=c.page;c.coverage='verified';c.renderOnly=true;await instrumentation(p);
  if(row===4){
    await home(c);const heading=p.locator('#recent-tasks-heading');
    const wasCollapsed=await heading.getByRole('button',{name:'展开',exact:true}).count()>0;
    if(wasCollapsed){await heading.getByRole('button',{name:'展开',exact:true}).click();await paint(p);}
    c.defer(async()=>{const area=p.getByTestId('recent-tasks-scroll');const collapse=area.getByRole('button',{name:'收起',exact:true}),more=area.getByRole('button',{name:/查看更多/});if(!originallyExpanded&&await collapse.isVisible())await collapse.click();if(originallyExpanded&&await more.isVisible())await more.click();if(wasCollapsed&&await heading.getByRole('button',{name:'收起',exact:true}).isVisible())await heading.getByRole('button',{name:'收起',exact:true}).click();});
    const collapse=p.getByTestId('recent-tasks-scroll').getByRole('button',{name:'收起',exact:true});const originallyExpanded=await collapse.isVisible();
    await waitHistoryRows(c);
    if(originallyExpanded)await collapse.click();
    const more=p.getByTestId('recent-tasks-scroll').getByRole('button',{name:/查看更多/});
    if(await more.isVisible())await timed(c,()=>more.click(),`!q.visible([...document.querySelectorAll('[data-testid="recent-tasks-scroll"] button')].find(e=>/查看更多/.test(e.textContent))) && q.ready(document.querySelector('[data-testid="recent-tasks-scroll"]'))`,'工作任务区展开至列表渲染完成',{supporting:true});
    note(c,`当前挂载 ${await taskRows(p).count()} 条任务；不核对标题内容、状态或与总数逐条对账`);
    await openHistory(c,{supporting:true});note(c,'首条任务可打开对应历史会话');
    c.limitations.push('仅观察列表展开和历史会话首屏渲染，不代表全部任务数据完整性或应用启动加载。');return;
  }
  if(row===5){
    await home(c);const area=p.getByTestId('workspace-section');const original=await area.getByRole('button',{name:'展开',exact:true}).isVisible();
    if(original)await area.getByRole('button',{name:'展开',exact:true}).click();
    const count=await p.getByTestId('workspace-scroll').locator('[data-workspace-row-header]').count();assert(count>0,'工作空间为空');
    c.defer(async()=>{const name=original?'收起':'展开';const b=area.getByRole('button',{name,exact:true});if(await b.isVisible())await b.click();});
    await area.getByRole('button',{name:'收起',exact:true}).click();
    await timed(c,()=>area.getByRole('button',{name:'展开',exact:true}).click(),'q.visible(document.querySelector(\'[data-testid="workspace-scroll"] [data-workspace-row-header]\')) && q.ready(document.querySelector(\'[data-testid="workspace-section"]\'))','展开工作空间区至空间标题就绪',{supporting:true});
    note(c,`工作空间区展开、收起正常，当前 ${count} 个空间标题均已挂载`);
    partial(c,'补测空间区展开时间；未逐一切换个人空间及其全部历史任务，不代表应用进入时空间数据加载');return;
  }
  if([6,12].includes(row)){
    await freshHome(c,row===6?'进入首页至右侧首屏和输入区就绪':'新建任务页进入至输入区及有限动画就绪');
    if(row===12){note(c,'独立空间的新任务输入区已渲染；不填业务内容，控件由对应独立用例测量');partial(c,'仅新任务页渲染；未发送任务或验证输入内容。');}
    else {note(c,'右侧标题、输入区、字体及可视区域图片均就绪，有限动画完成');partial(c,'仅 Windows 热态可见 DOM 完成；未做像素逐帧对比，也没有冷启动');}return;
  }
  if(row===7){
    await home(c);
    const heading=p.locator('#recent-tasks-heading'),expand=heading.getByRole('button',{name:'展开',exact:true}),collapsed=await expand.isVisible();
    if(collapsed)await expand.click();
    c.defer(async()=>{if(collapsed&&await heading.getByRole('button',{name:'收起',exact:true}).isVisible())await heading.getByRole('button',{name:'收起',exact:true}).click();});
    await click(p,'筛选');
    const selected=p.getByRole('menuitemradio').filter({hasText:'全部状态'});if(await selected.getAttribute('aria-checked')!=='true')throw new Blocked('存在用户状态筛选，未覆盖');
    c.defer(async()=>{await dismiss(p);await click(p,'筛选');await p.getByRole('menuitemradio',{name:'全部状态',exact:true}).click();await dismiss(p);});
    await timed(c,()=>p.getByRole('menuitemradio',{name:'执行成功',exact:true}).click(),'true','筛选执行成功至任务列表渲染完成',{region:'[data-testid="recent-tasks-scroll"]',allowAlreadySatisfied:true});
    note(c,'筛选菜单关闭且目标列表渲染就绪；允许结果不变或为空，不逐条核对业务状态');return;
  }
  if(row===9){
    await home(c);const office=p.getByRole('button',{name:'日常办公',exact:true}).filter({visible:true}).first();const code=p.getByRole('button',{name:'代码开发',exact:true}).filter({visible:true}).first();
    const original=await code.getAttribute('class');c.defer(()=>office.click());
    await timed(c,()=>code.click(),`q.btn('代码开发')?.getAttribute('class')!==${JSON.stringify(original)} && q.ready(q.main())`,'快捷入口切换至代码开发并渲染场景内容');note(c,'日常办公切换至代码开发，样式及场景区域就绪；结束恢复日常办公');return;
  }
  if(row===11){
    await home(c);
    await timed(c,()=>click(p,/案例库:/),`q.visible(document.querySelector('main input[placeholder="请输入关键词查询"]')) && q.ready(q.main())`,'进入案例库至首屏卡片或正常空态就绪',{region:'main'});
    note(c,'仅测案例库首屏渲染；不要求指定案例、数量、标题，不遍历离屏封面');
    c.limitations.push('列表空态有效；案例内容、分页完整性及详情未由本项验证。');return;
  }
  if(row===13){
    await home(c);await expandTasks(c);await search(c,'tasks');
    note(c,'按用户截图确认映射：新任务页左侧工作任务区放大镜“搜索”，打开搜索任务弹窗；按任务名称查询，空结果及已有任务命中均已验证');
    c.limitations.push('当前映射与008为同一任务名称搜索入口；不代表会话正文搜索，正文搜索由020单独覆盖。');
    return;
  }
  if(row===18){
    await openHistory(c);
    assert(await ed(p).isEditable(),'历史任务详情输入区未就绪');
    note(c,'按用户确认映射：点击左侧已有历史任务，详情、输入区及可视资源加载完成；不要求打开历史提问浮层');
    c.limitations.push('当前映射与019历史任务详情共用入口；计时为任务详情加载，原表0.5秒弹窗目标保留但不套用于此操作。');
    return;
  }
  if(row===19||row===26){await openHistory(c,{content:row===26});assert(await ed(p).isEditable(),'历史会话输入区不可编辑');note(c,row===26?'首屏消息复制控件、字体、可见图片及会话界面就绪':'历史详情、可编辑输入区、工具栏和可见资源就绪');partial(c,'单条已有会话首屏热态样本；不代表全部历史消息或冷启动加载');return;}
  if(row===25){await history(c);await historyPopup(c);return;}
  if([27,32,38].includes(row)){await loadMarket(c,{27:'专家',32:'技能',38:'工具'}[row]);return;}
  if(row===28){
    await workspace(c,'专家');
    await renderSelection(c,button(p,'专家团'),'专家列表切换至专家团内容就绪');
    await renderSelection(c,p.locator('main').getByRole('button',{name:'专家',exact:true}).last(),'专家团切回专家内容就绪');
    note(c,'专家/专家团页签切换后的结果区已渲染；不要求指定专家名称');return;
  }
  if(row===29||row===34){
    await workspace(c,row===29?'专家':'技能');
    await renderCategory(c,'分类切换至结果区渲染完成');
    return;
  }
  if(row===33){
    await workspace(c,'技能');
    await renderSelection(c,button(p,/^已安装技能/),'技能市场切换至已安装列表');
    await renderSelection(c,button(p,'技能市场'),'已安装列表返回技能市场');
    note(c,'市场/已安装列表切换完成，允许正常空列表；不要求Office办公助手或指定数量');return;
  }
  if(row===36){
    await workspace(c,'技能');await click(p,/^已安装技能/);
    await click(p,'技能市场');await waitSurface(p);
    const card=p.locator('main [role="button"]').filter({has:p.getByRole('button',{name:'安装',exact:true})}).filter({visible:true}).first();
    if(!await card.isVisible())throw new Blocked('没有可安装样本；不卸载已有技能来制造前置条件');
    const name=(await card.locator('p[data-slot="tooltip-trigger"]').first().innerText()).trim();
    if(!name)throw new Blocked('无法唯一识别本轮安装样本，未修改既有技能');
    const plus=card.getByRole('button',{name:'安装',exact:true});await plus.waitFor();
    let attempted=false;c.defer(async()=>{
      if(!attempted)return;
      await workspace(c,'技能');await click(p,/^已安装技能/);
      const more=button(p,`打开${name}更多操作`);await more.waitFor({timeout:5000}).catch(()=>{});
      if(await more.isVisible())await uninstallAddedSkill(p,name);
    });
    attempted=true;
    const sample=await measure(c,()=>plus.click(),'q.ready(q.main())','点击安装后的技能卡片/状态区域渲染',{timeoutMs:15000,allowAlreadySatisfied:true,region:'main'});
    sample.targetRelation='direct';
    sample.scope+='；仅观察点击后的卡片、加载/空态或错误区域渲染；不以安装成功、数量变化、配置重载或指定技能名称作为通过条件';
    attempted=false;
    note(c,'点击市场样本后的技能卡片及状态区域已渲染；不核验安装成功、数量或指定技能名称');
    c.limitations.push('本项只覆盖安装操作触发后的可见渲染，不代表下载传输、安装持久化或运行时重载成功。');return;
  }
  if(row===31){
    await fixture(c);await workspace(c,'专家');
    const candidate=p.getByRole('button').filter({visible:true,hasText:/召唤|使用|添加|选择|启用/}).first();
    if(!await candidate.isVisible()){await waitSurface(p,'main');note(c,'当前专家列表为空态或没有可操作样本；专家区域渲染完成，未伪造强前置');partial(c,'没有可用专家样本时只覆盖列表/空态渲染，不执行召唤动作。');return;}
    await candidate.click();
    const action=p.getByRole('button').filter({visible:true,hasText:/召唤|使用|添加|选择|启用/}).last();
    c.stage='当前专家操作';
    const sample=await timed(c,()=>action.isVisible().then(v=>v?action.click():undefined),'q.ready(q.main()) || q.ready(q.popup())','当前专家操作后的页面/弹层渲染',{supporting:true,timeout:15000,allowAlreadySatisfied:true,region:'main'});
    sample.label='当前专家操作后的渲染完成';sample.targetRelation='direct';sample.scope='当前可见专家卡片操作后的 DOM、弹层、空态或错误提示渲染；不核对专家名称、绑定结果或业务调用';
    note(c,'使用当前可见专家样本完成操作触发；只判断页面、弹层或提示区域渲染，不验证专家名称与绑定');partial(c,'未发送专家任务；账户级专家调用及业务结果另行验收');return;
  }
  if(row===40){await home(c);await timed(c,()=>click(p,/案例库:/),`q.visible(document.querySelector('main input[placeholder="请输入关键词查询"]')) && q.ready(q.main())`,'进入案例库至首屏卡片封面解码就绪',{region:'main'});note(c,'案例库首屏或正常空态已渲染，不校验指定卡片及数量');return;}
  if(row===41){await cases(c);const card=p.locator('.mw-case-card').filter({visible:true}).first();if(!await card.isVisible())throw new Blocked('案例列表正常空态，缺少可打开详情的样本');await timed(c,()=>card.click(),`q.ready(q.popup())`,'打开案例预览至详情及可视资源就绪',{region:'[role="dialog"]'});note(c,'当前可用案例详情已渲染；不核验介绍字段和正文');return;}
  if(row===42){await preview(c);const tab=button(p,'案例回放');await renderSelection(c,tab,'切换案例回放至只读消息首屏就绪','[role="dialog"]');note(c,'案例回放区域渲染完成；不比对提示文案、消息正文或轨迹内容');return;}
  if(row===43){await fixture(c);c.stage='打开案例预览';await preview(c);c.stage='执行案例做同款';await timed(c,()=>click(p,'做同款'),`/^#\\\\/workspace\\\\/[^/]+\\\\/session$/.test(location.hash) && q.editor()?.isContentEditable && q.ready(q.main())`,'做同款至新任务输入区渲染完成',{region:'main'});assert(await p.evaluate(()=>location.hash)===c.fixtureHash,'做同款未回到本轮独立空间');note(c,'做同款回到独立新任务，未发送或核验预填正文；收尾仅清理本轮草稿');return;}
  if(row===45){await cases(c);await renderCategory(c,'案例分类切换至列表渲染完成');return;}
  if(row===46){await home(c);await timed(c,()=>click(p,/自动化:/),`/automation/.test(location.hash) && q.ready(q.main()) && (q.main().querySelector('[data-testid="automation-job-list"],[data-testid="automation-run-list"]') || q.state(q.main()).state==='empty')`,'进入自动化页至列表及操作入口就绪',{region:'main'});note(c,'自动化列表或正常空态已渲染；不要求已安排任务、成功记录或固定数量');return;}
  throw new Blocked('没有本轮适配实现');
}

async function historyPopup(c,supporting=false) {
  const p=c.page;
  await timed(c,()=>click(p,'历史提问'),`Array.from(document.querySelectorAll('div.fixed')).some(e=>q.visible(e)&&e.textContent.includes('历史提问')&&(e.textContent.includes('暂无历史提问')||e.querySelectorAll('button').length>1)&&q.ready(e))`,'打开历史提问至浮层记录或明确空态就绪',{supporting});
  if(await p.getByText('暂无历史提问',{exact:true}).isVisible()){note(c,'历史提问浮层已渲染，当前为空记录状态');partial(c,'已验证弹窗渲染与空态；有记录时的条目和跳转未覆盖');}else note(c,'历史提问浮层包含可选择记录');
}
