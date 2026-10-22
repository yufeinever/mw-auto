import { Blocked, assert, button, dismiss, measure, paint } from './runtime.mjs';
import { home, history, expandTasks, workspace, cases, preview, search } from './actions.mjs';
import { gallerySnapshot, galleryComplete } from './case-gallery.mjs';
import { marketInstallReady } from './skill-readiness.mjs';

export const rows = [4,5,6,7,9,11,12,13,18,19,25,26,27,28,29,31,32,33,34,36,38,40,41,42,43,45,46];
const ed = p => p.locator('[contenteditable="true"][role="textbox"]').filter({visible:true}).first();
const taskRows = p => p.getByTestId('recent-tasks-scroll').locator('button[data-slot="context-menu-trigger"]');
const note = (c,s) => {c.assertions.push(s);c.log(s);};
function partial(c,s) {c.coverage='partial';c.limitations.push(s);}
async function click(p,name) {await button(p,name).click();}

// Readiness is evaluated in the same renderer as the input-event clock. No page
// text, input values, response bodies, URLs or credentials are persisted here.
async function instrumentation(p) {
  await p.evaluate(() => {
    const visible = e => {
      if(!e||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden')return false;
      const r=e.getBoundingClientRect();
      if(r.width<=0||r.height<=0)return false;
      for(let a=e.parentElement;a;a=a.parentElement){const s=getComputedStyle(a);if(/hidden|clip|auto|scroll/.test(s.overflowY)){const ar=a.getBoundingClientRect();if(r.bottom<=ar.top||r.top>=ar.bottom)return false;}}
      return true;
    };
    const btn = name => Array.from(document.querySelectorAll('button')).find(e=>visible(e)&&(e.getAttribute('aria-label')===name||e.textContent.trim()===name));
    const text = name => Array.from(document.querySelectorAll('h1,h2,h3,p,span,button,div')).find(e=>visible(e)&&e.textContent.trim()===name);
    const ready = root => {
      if(!visible(root)||document.fonts.status!=='loaded')return false;
      if(Array.from(root.querySelectorAll('[aria-busy="true"]')).some(visible))return false;
      if(Array.from(root.querySelectorAll('p,span,div')).some(e=>visible(e)&&/^正在加载|^加载中[.…]|^正在下载/.test(e.textContent.trim())&&e.textContent.trim().length<70))return false;
      if(Array.from(root.querySelectorAll('img')).some(e=>visible(e)&&(!e.complete||e.naturalWidth===0)))return false;
      if(root.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;
      return true;
    };
    window.__mwQA={visible,btn,text,ready,main:()=>Array.from(document.querySelectorAll('main')).find(visible),editor:()=>Array.from(document.querySelectorAll('[role="textbox"]')).find(visible)};
  });
}
const terminal = expr => `() => {const q=window.__mwQA;return !!q && (${expr});}`;
async function timed(c,action,expr,label,{supporting=false,timeout=10000}={}) {
  const sample=await measure(c,action,terminal(expr),label,{timeoutMs:timeout});
  sample.targetRelation=supporting?'supporting':'direct';
  sample.scope+='；'+(supporting?'补充场景，不与原表该项阈值比较':'本标签声明的可见 DOM、字体、已进入可视区域图片及有限动画就绪');
  return sample;
}
async function idle(p,expr) {await p.waitForFunction(terminal(expr),null,{timeout:15000});}
async function freshHome(c,label) {
  await cases(c);
  await timed(c,()=>click(c.page,'新建任务'),'q.text("Mobile熠动，Work智简") && q.editor()?.isContentEditable && q.ready(q.main())',label);
}
async function openHistory(c,{content=false,supporting=false}={}) {
  await home(c);await expandTasks(c);const p=c.page;
  assert(await taskRows(p).count()>0,'没有可读取的历史任务');
  await timed(c,()=>taskRows(p).first().click(),`/\\/session\\/[^/]+$/.test(location.hash) && q.btn('历史提问') && q.editor() ${content?"&& q.btn('复制消息')":''} && q.ready(q.main())`,content?'点击历史任务至首屏消息及界面就绪':'点击历史任务至详情和输入区就绪',{supporting});
}
async function loadMarket(c,type) {
  const p=c.page;
  if(type==='技能')await home(c);else {await workspace(c,'技能');await click(p,'更多');await p.getByRole('menuitem',{name:type,exact:true}).waitFor();}
  const marker={专家:'精选专家/专家团',技能:'技能市场',工具:'工具市场'}[type];
  await timed(c,()=>type==='技能'?click(p,/专家工作区:/):p.getByRole('menuitem',{name:type,exact:true}).click(),`q.text(${JSON.stringify(marker)}) && document.querySelector('input[placeholder="请输入关键词查询"]') && q.ready(q.main())`,`${type}市场进入至首屏内容就绪`);
  note(c,`${type}市场标题、搜索框、可视区图片和首屏内容就绪`);
  partial(c,'当前进程热态首屏；未滚动穷尽服务端分页数据，不代表冷启动或离屏元素全部加载');
}
async function fixture(c) {
  const p=c.page,name=`MW-QA-v002-${Date.now()}`;let createdHash;
  c.stage='准备独立测试空间';await home(c);const baseHash=await p.evaluate(()=>location.hash);
  if((await ed(p).innerText()).trim())throw new Blocked('当前新任务有未发送草稿，未覆盖或创建测试空间');
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
    const header=p.getByTestId('workspace-scroll').locator('[data-workspace-row-header]').filter({has:p.getByRole('button',{name,exact:true})});
    if(!await header.count())return;
    // Leave the fixture before deleting it so the active runtime never points
    // at a workspace that has just been removed.
    c.stage='通过界面恢复原活动工作空间';
    await picker().click();
    await p.locator('[data-slot="popover-content"]').getByRole('button',{name:baseName,exact:true}).click();
    // Selecting a workspace may resume its last historical session. Requiring
    // the empty-draft route would incorrectly reject this valid UI behavior.
    await p.waitForFunction(id=>location.hash.split('/')[2]===id&&Array.from(document.querySelectorAll('[role="textbox"]')).some(e=>e.getClientRects().length),baseHash.split('/')[2],{timeout:15000});
    await home(c);
    const returned=(await ed(p).innerText()).trim();
    if(returned){
      const generated=c.fixtureGeneratedText||'';
      assert((generated&&(generated.startsWith(returned)||returned.startsWith(generated)))||/^帮我用文档生成专家处理这个任/.test(returned),'原空白草稿出现未知内容，未覆盖');
      await ed(p).fill('');
    }
    await paint(p);
    await header.hover();await header.locator('[aria-haspopup="menu"]').click();
    await p.getByRole('menuitem',{name:'删除工作空间',exact:true}).click();
    await p.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();
    await p.getByTestId('workspace-scroll').getByRole('button',{name,exact:true}).waitFor({state:'detached'});
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
  c.stage='等待测试空间注册';await p.getByTestId('workspace-scroll').getByRole('button',{name,exact:true}).waitFor({state:'attached',timeout:15000});
  const header=p.getByTestId('workspace-scroll').locator('[data-workspace-row-header]').filter({has:p.getByRole('button',{name,exact:true})});
  c.stage='从测试空间新建空白任务';await header.hover();await header.locator('[data-workspace-actions] button').first().click();
  await p.waitForFunction(()=>/^#\/workspace\/[^/]+\/session$/.test(location.hash));
  createdHash=await p.evaluate(()=>location.hash);assert(createdHash.split('/')[2]!==baseHash.split('/')[2],'没有切换到独立测试空间');
  assert(!(await ed(p).innerText()).trim(),'独立测试空间初始草稿非空');
  c.defer(async()=>{
    c.stage='清空测试空间草稿及专家绑定';await dismiss(p);
    await header.hover();await header.locator('[data-workspace-actions] button').first().click();
    await p.waitForFunction(hash=>location.hash===hash,createdHash,{timeout:15000});
    const input=ed(p);await input.waitFor({timeout:15000});
    await p.waitForFunction(()=>{const e=Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]')).find(e=>e.getClientRects().length);if(!e)return false;const text=e.textContent,now=performance.now();const w=window.__mwDraftSettle;if(!w||w.text!==text){window.__mwDraftSettle={text,at:now};return false;}return now-w.at>=300;},null,{timeout:10000});
    c.fixtureGeneratedText=(await input.innerText()).trim();await input.fill('');
    const bar=p.locator('[data-composer-toolbar-item="expert"]').filter({visible:true}).first();
    if(await bar.count()){await bar.hover();const exit=bar.getByRole('button',{name:/^退出「/});if(await exit.isVisible())await exit.click();}
  });
  c.stage='测试空间已就绪';
  note(c,'通过产品 UI 创建本轮独立工作空间；结束清空测试草稿并删除空间注册');
  return name;
}
async function uninstallAddedSkill(p) {
  await dismiss(p);await workspace({page:p},'技能');
  await click(p,/^已安装技能/);
  const more=button(p,'打开Office办公助手更多操作');
  await more.waitFor({timeout:10000});await more.click();
  await p.getByRole('menuitem',{name:'卸载',exact:true}).click();
  await p.getByRole('dialog').getByRole('button',{name:'卸载',exact:true}).click();
  await more.waitFor({state:'hidden',timeout:15000});
}
async function settleSkillRuntime(p) {
  const pending=p.getByText('需要重新加载',{exact:true});
  if(!await pending.isVisible().catch(()=>false))return;
  assert(await p.locator('[title="执行中"],[title="待确认"]').count()===0,'技能数量已恢复，但存在执行中/待确认任务，未重载运行时');
  const draft=ed(p);if(await draft.isVisible())assert(!(await draft.innerText()).trim(),'存在未发送草稿，未重载运行时');
  await click(p,'立即重新加载');await pending.waitFor({state:'hidden',timeout:30000});
}

export async function executeRetry(row,c) {
  const p=c.page;c.coverage='verified';await instrumentation(p);
  if(row===4){
    await home(c);const heading=p.locator('#recent-tasks-heading');
    const wasCollapsed=await heading.getByRole('button',{name:'展开',exact:true}).count()>0;
    if(wasCollapsed){await heading.getByRole('button',{name:'展开',exact:true}).click();await paint(p);}
    c.defer(async()=>{const area=p.getByTestId('recent-tasks-scroll');const collapse=area.getByRole('button',{name:'收起',exact:true}),more=area.getByRole('button',{name:/查看更多/});if(!originallyExpanded&&await collapse.isVisible())await collapse.click();if(originallyExpanded&&await more.isVisible())await more.click();if(wasCollapsed&&await heading.getByRole('button',{name:'收起',exact:true}).isVisible())await heading.getByRole('button',{name:'收起',exact:true}).click();});
    const collapse=p.getByTestId('recent-tasks-scroll').getByRole('button',{name:'收起',exact:true});const originallyExpanded=await collapse.isVisible();
    if(originallyExpanded)await collapse.click();
    const total=Number((await heading.innerText()).match(/[（(](\d+)/)?.[1]);
    const more=p.getByTestId('recent-tasks-scroll').getByRole('button',{name:/查看更多/});
    if(await more.isVisible())await timed(c,()=>more.click(),`document.querySelectorAll('[data-testid="recent-tasks-scroll"] button[data-slot="context-menu-trigger"]').length===${total}`,'工作任务区查看更多至全部记录挂载',{supporting:true});
    const count=await taskRows(p).count();assert(count===total,`任务列表数量与标题不符：${count}/${total}`);
    const states=await taskRows(p).evaluateAll(es=>({nonempty:es.filter(e=>e.textContent.trim()).length,labeled:es.filter(e=>e.querySelector('[title="已完成未查看"],[title="报错"],[title="执行中"],[title="待确认"]')).length}));
    assert(states.nonempty===total,'部分任务未显示标题');note(c,`全部 ${total} 条任务已挂载，${states.labeled} 条有显式状态标记，其余沿用已查看/无标记展示`);
    await openHistory(c,{supporting:true});note(c,'首条任务可打开对应历史会话');
    c.limitations.push('本项按已约定的加载展示口径通过：列表数量与页面总数一致、标题已展示；业务状态未与后端逐条核对。列表展开和历史会话打开属于补充计时，不代表应用进入时全量数据加载。');return;
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
    if(row===12){assert(!(await ed(p).innerText()).trim(),'有未发送草稿，未覆盖');c.defer(()=>ed(p).fill(''));await ed(p).fill('__MW_QA_INPUT_ONLY__');assert((await ed(p).innerText()).includes('__MW_QA'),'测试输入未回显');
      for(const name of ['模式','技能','专家','工具','权限']){await click(p,name);await paint(p);await dismiss(p);}note(c,'测试文字可回显，模式/技能/专家/工具/权限入口逐一打开；结束清空测试文字');partial(c,'未发送任务；上传文件、知识库及数智员工等入口未逐一完成操作');}
    else {note(c,'右侧标题、输入区、字体及可视区域图片均就绪，有限动画完成');partial(c,'仅 Windows 热态可见 DOM 完成；未做像素逐帧对比，也没有冷启动');}return;
  }
  if(row===7){
    await home(c);
    const heading=p.locator('#recent-tasks-heading'),expand=heading.getByRole('button',{name:'展开',exact:true}),collapsed=await expand.isVisible();
    if(collapsed)await expand.click();
    c.defer(async()=>{if(collapsed&&await heading.getByRole('button',{name:'收起',exact:true}).isVisible())await heading.getByRole('button',{name:'收起',exact:true}).click();});
    await p.evaluate(()=>{window.__mwQA.beforeTasks=document.querySelector('[data-testid="recent-tasks-scroll"]').textContent;});
    await click(p,'筛选');
    const selected=p.getByRole('menuitemradio').filter({hasText:'全部状态'});if(await selected.getAttribute('aria-checked')!=='true')throw new Blocked('存在用户状态筛选，未覆盖');
    c.defer(async()=>{await dismiss(p);await click(p,'筛选');await p.getByRole('menuitemradio',{name:'全部状态',exact:true}).click();await dismiss(p);});
    await timed(c,()=>p.getByRole('menuitemradio',{name:'执行成功',exact:true}).click(),`document.querySelector('[data-testid="recent-tasks-scroll"]').textContent!==q.beforeTasks && q.ready(document.querySelector('[data-testid="recent-tasks-scroll"]'))`,'筛选执行成功至任务列表更新就绪');
    await dismiss(p);const more=p.getByTestId('recent-tasks-scroll').getByRole('button',{name:/查看更多/});if(await more.isVisible())await more.click();
    const wrong=await taskRows(p).evaluateAll(es=>es.filter(e=>e.querySelector('[title="报错"],[title="执行中"],[title="待确认"]')).length);assert(wrong===0,'执行成功筛选中出现其他明确状态');note(c,'执行成功条件选中，全部已挂载结果中未出现报错/执行中/待确认标记');partial(c,'已查看任务不总显示状态图标；尚未与业务存储逐条对账');c.defer(async()=>{const b=p.getByTestId('recent-tasks-scroll').getByRole('button',{name:'收起',exact:true});if(await b.isVisible())await b.click();});return;
  }
  if(row===9){
    await home(c);const office=p.getByRole('button',{name:'日常办公',exact:true}).filter({visible:true}).first();const code=p.getByRole('button',{name:'代码开发',exact:true}).filter({visible:true}).first();
    const original=await code.getAttribute('class');c.defer(()=>office.click());
    await timed(c,()=>code.click(),`q.btn('代码开发')?.getAttribute('class')!==${JSON.stringify(original)} && q.ready(q.main())`,'快捷入口切换至代码开发并渲染场景内容');note(c,'日常办公切换至代码开发，样式及场景区域就绪；结束恢复日常办公');return;
  }
  if(row===11){
    // The user explicitly maps the source-sheet “精选案例” to the case library.
    // Retain filters/scroll in renderer memory only; source-sheet text stays intact.
    const capture=()=>p.evaluate(()=>{
      const root=document.querySelector('main'),input=root.querySelector('input[placeholder="请输入关键词查询"]');
      if(!input||![...root.querySelectorAll('button')].some(e=>e.textContent.trim()==='我的收藏'))return null;
      const active=[...root.querySelectorAll('button')].find(e=>e.className.includes('rounded-full')&&e.className.includes('border-[var(--mw-brand)]'));
      const scroller=[...root.querySelectorAll('div')].find(e=>getComputedStyle(e).overflowY==='auto'&&e.scrollHeight>e.clientHeight);
      return {category:active?.textContent.trim(),search:input?.value||'',top:scroller?.scrollTop||0};
    });
    let original=await capture();
    const restore=async()=>{
      await cases(c);
      await p.getByPlaceholder('请输入关键词查询').fill(original.search);
      if(original.category)await p.locator('main').getByRole('button',{name:original.category,exact:true}).click();
      await paint(p);
      await p.evaluate(top=>{const root=document.querySelector('main');const el=[...root.querySelectorAll('div')].find(e=>getComputedStyle(e).overflowY==='auto'&&e.scrollHeight>e.clientHeight);if(el)el.scrollTop=top;},original.top);
    };
    if(!original){await dismiss(p);await click(p,/案例库:/);await p.getByPlaceholder('请输入关键词查询').waitFor();original=await capture();}
    assert(original,'案例库筛选状态未就绪');c.defer(restore);
    await p.getByPlaceholder('请输入关键词查询').fill('');
    await p.locator('main').getByRole('button',{name:'全部',exact:true}).click();
    await home(c);
    await timed(c,()=>click(p,/案例库:/),`document.querySelectorAll('.mw-case-card').length>0 && q.ready(q.main())`,'进入案例库至首屏卡片封面就绪');
    await p.getByPlaceholder('请输入关键词查询').fill('');
    await p.locator('main').getByRole('button',{name:'全部',exact:true}).click();
    await idle(p,`document.querySelectorAll('.mw-case-card').length>0 && q.ready(q.main())`);
    const initial=await p.evaluate(gallerySnapshot);
    if(initial.continuation)throw new Blocked('案例库出现分页/加载更多，需适配后才可确认全部展示');
    const cards=p.locator('main .mw-case-card');
    for(let i=0;i<initial.count;i++){
      await cards.nth(i).scrollIntoViewIfNeeded();
      await cards.nth(i).evaluate(async e=>{await Promise.all([...e.querySelectorAll('img')].map(i=>i.decode().catch(()=>{})));});
      await idle(p,'q.ready(q.main())');
    }
    await paint(p);
    const final=await p.evaluate(gallerySnapshot);
    assert(final.count===initial.count,'滚动后案例数量变化，未确认全量范围');
    assert(galleryComplete(final),'全部案例展示未完成：'+JSON.stringify(final));
    note(c,`按用户确认映射：精选案例 → 案例库·全部案例；${final.count} 张卡片标题及 ${final.images} 张封面加载完成，逐卡滚动检查通过，无分页/加载更多入口`);
    c.limitations.push('全部指当前案例库“全部”分类返回并展示的列表；未核对后台未发布/无权限案例。记录的毫秒值仅为进入首屏耗时，全量滚动检查不混入该计时；详情、回放、做同款由041/042/043独立验证。');
    return;
  }
  if(row===13){
    await home(c);await expandTasks(c);await search(c,'tasks');
    note(c,'按用户截图确认映射：新任务页左侧工作任务区放大镜“搜索”，打开搜索任务弹窗；按任务名称查询，空结果及已有任务命中均已验证');
    c.limitations.push('当前映射与008为同一任务名称搜索入口；不代表会话正文搜索，正文搜索由020单独覆盖。');
    return;
  }
  if(row===18){
    await home(c);const missing=!await button(p,'历史提问').isVisible();
    if(missing){c.originalScenario={status:'blocked',reason:'空白新任务页未提供该入口'};partial(c,'原表新任务空白场景无入口；以下为进入已有会话的补充验证，不能视为原场景通过');}
    await openHistory(c,{supporting:true});
    await historyPopup(c,missing);
    return;
  }
  if(row===19||row===26){await openHistory(c,{content:row===26});assert(await ed(p).isEditable(),'历史会话输入区不可编辑');note(c,row===26?'首屏消息复制控件、字体、可见图片及会话界面就绪':'历史详情、可编辑输入区、工具栏和可见资源就绪');partial(c,'单条已有会话首屏热态样本；不代表全部历史消息或冷启动加载');return;}
  if(row===25){await history(c);await historyPopup(c);return;}
  if([27,32,38].includes(row)){await loadMarket(c,{27:'专家',32:'技能',38:'工具'}[row]);return;}
  if(row===28){
    await workspace(c,'专家');await timed(c,()=>click(p,'专家团'),`Array.from(document.querySelectorAll('main button,main [role="button"]')).some(e=>e.getClientRects().length&&e.textContent.includes('专业文档生成团队')) && q.ready(q.main())`,'专家列表切换至专家团内容就绪');
    await timed(c,()=>p.getByRole('button',{name:'专家',exact:true}).last().click(),`Array.from(document.querySelectorAll('main button,main [role="button"]')).some(e=>e.getClientRects().length&&e.textContent.includes('文档生成专家')) && q.ready(q.main())`,'专家团切回专家内容就绪');note(c,'专家和专家团双向切换，基准卡片就绪');return;
  }
  if(row===29||row===34){
    const expert=row===29,category=expert?'党建':'办公',reset=expert?'全部岗位':'全部';await workspace(c,expert?'专家':'技能');
    const b=button(p,category);const before=await b.getAttribute('class');c.defer(()=>click(p,reset));
    await timed(c,()=>b.click(),`q.btn(${JSON.stringify(category)})?.getAttribute('class')!==${JSON.stringify(before)} && q.ready(q.main())`,'分类切换至'+category+'结果就绪');
    const labels=await p.locator('main [aria-label^="业务类型 "]').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>e.getAttribute('aria-label').slice(5)));
    const matching=labels.filter(x=>x===category).length;
    note(c,`已切换${category}分类；当前页 ${labels.length} 个已挂载业务类型标签，其中 ${matching} 个匹配`);
    if(!labels.length||matching!==labels.length)partial(c,'页面同时包含固定精选栏；未将全页卡片混同分类结果，分类全量业务归属仍待单独数据核对');return;
  }
  if(row===33){
    await workspace(c,'技能');await timed(c,()=>click(p,/^已安装技能/),`!!q.btn('打开Office办公助手更多操作') || (q.btn('技能市场') && Array.from(document.querySelectorAll('main [role="switch"]')).length>0 && q.ready(q.main()))`,'技能市场切换至已安装列表');
    await timed(c,()=>click(p,'技能市场'),`Array.from(document.querySelectorAll('main button,main [role="button"]')).some(e=>e.textContent.includes('Office办公助手')) && !Array.from(document.querySelectorAll('main button[aria-label]')).some(e=>e.getAttribute('aria-label').startsWith('打开Office办公助手更多操作')) && q.ready(q.main())`,'已安装列表返回技能市场');note(c,'技能市场和已安装列表双向切换完成');return;
  }
  if(row===36){
    await workspace(c,'技能');await click(p,/^已安装技能/);
    const hadReloadPrompt=await p.getByText('需要重新加载',{exact:true}).isVisible().catch(()=>false);
    const baselineCount=Number((await button(p,/^已安装技能/).innerText()).match(/\d+/)?.[0]);
    const initiallyInstalled=await button(p,'打开Office办公助手更多操作').isVisible();
    if(initiallyInstalled)throw new Blocked('基准 Office办公助手已预先安装；不卸载个人既有技能，需另一未安装夹具');
    await click(p,'技能市场');const card=p.locator('main [role="button"]').filter({has:p.getByText('Office办公助手',{exact:true})}).first();
    const plus=card.getByRole('button',{name:'安装',exact:true});await plus.waitFor();
    let attempted=false,runtimeTouched=false;c.defer(async()=>{
      if(!attempted){if(runtimeTouched&&!hadReloadPrompt)await settleSkillRuntime(p);return;}
      // Allow a delayed install to settle before checking/removing our own sample.
      const settled=await p.waitForFunction(`(${marketInstallReady.toString()})`,null,{timeout:60000}).then(()=>true,()=>false);
      await workspace(c,'技能');await click(p,/^已安装技能/);
      const more=button(p,'打开Office办公助手更多操作');await more.waitFor({timeout:5000}).catch(()=>{});
      if(await more.isVisible())await uninstallAddedSkill(p);
      const count=Number((await button(p,/^已安装技能/).innerText()).match(/\d+/)?.[0]);
      assert(count===baselineCount,'下载测试后已安装数量未恢复；请核查新增样本');
      assert(settled,'下载终态未确认；即使数量暂时恢复也需人工核查，停止后续用例');
      if(!hadReloadPrompt)await settleSkillRuntime(p);
    });
    attempted=true;runtimeTouched=true;
    const sample=await measure(c,()=>plus.click(),`(${marketInstallReady.toString()})`,'市场＋下载至技能安装完成',{timeoutMs:60000});
    sample.targetRelation='supporting';
    sample.scope+='；补充下载/安装记录，不代表首sheet界面响应，不与2秒目标比较；不包含进入市场或卸载清理；可能命中磁盘下载缓存';
    await click(p,/^已安装技能/);await button(p,'打开Office办公助手更多操作').waitFor({timeout:12000});
    const before=await p.getByRole('button',{name:/^已安装技能/}).innerText();await uninstallAddedSkill(p);attempted=false;
    assert(!await button(p,'打开Office办公助手更多操作').isVisible(),'卸载后技能仍在列表');note(c,`Office办公助手从未安装到已安装列表可见（${before.match(/\d+/)?.[0]} 项），再经 UI 卸载确认移除`);
    const after=Number((await button(p,/^已安装技能/).innerText()).match(/\d+/)?.[0]);assert(after===baselineCount,'已安装数量未恢复');
    if(!hadReloadPrompt)await settleSkillRuntime(p);
    else c.limitations.push('执行前已有“需要重新加载”提示，保留原提示，不代替用户应用此前待生效配置。');
    runtimeTouched=false;
    note(c,'从市场卡片＋实际下载，已安装列表可见；仅卸载本轮新增样本，数量恢复基线');
    c.limitations.push('下载与安装按账户管理，不代表纯网络传输耗时；未清除下载缓存、未验证重启持久性或实际调用。');
    partial(c,'原表安装技能界面响应的计时终点待确认，完整下载/安装仅作补充，不代表原项验收通过');return;
  }
  if(row===31){
    await fixture(c);await workspace(c,'专家');
    const later=button(p,'稍后');if(await later.isVisible()){await later.click();await p.getByText('需要重新加载',{exact:true}).waitFor({state:'hidden',timeout:10000});}
    await p.getByRole('button').filter({hasText:'文档生成专家'}).first().click();
    await button(p,'召唤 文档生成专家').waitFor();
    c.stage='实际召唤专家';
    const sample=await timed(c,()=>click(p,'召唤 文档生成专家'),`(/^#\\/workspace\\/[^/]+\\/session$/.test(location.hash) && document.querySelector('[data-composer-toolbar-item="expert"] button[aria-label="文档生成专家"]') && q.ready(q.main())) || Array.from(document.querySelectorAll('[data-sonner-toast],[role="alert"]')).some(e=>q.visible(e)&&/需要重新加载|召唤失败|未安装|重新召唤/.test(e.textContent))`,'召唤专家至会话回跳或明确前置提示',{supporting:true,timeout:45000});
    const pending=await p.getByText('需要重新加载',{exact:true}).isVisible().catch(()=>false);
    if(pending)throw new Blocked('已实际点击召唤；客户端提示“需要重新加载／待启用的技能尚未安装”，运行时配置前置未满足，未强制重新加载个人引擎');
    const route=await p.evaluate(()=>location.hash);if(!/^#\/workspace\/[^/]+\/session$/.test(route))throw new Blocked('召唤操作未进入新任务；请检查客户端召唤错误提示及安装阶段状态');
    c.stage='核对专家绑定';const trigger=p.locator('[data-composer-toolbar-item="expert"] button[aria-label="文档生成专家"]');await trigger.waitFor();await trigger.click();const bound=await p.getByText('文档生成专家',{exact:true}).filter({visible:true}).count();assert(bound>0,'召唤后未回显目标专家');
    sample.label='召唤专家至新任务及目标专家绑定就绪';sample.targetRelation='direct';sample.scope='Windows 热态专家召唤回跳及绑定终态；未发送专家任务';
    note(c,'实际召唤后进入新任务，专家选择器回显目标专家；结束退出本轮专家绑定');partial(c,'仅验证专家绑定回跳，未发送专家任务；账户级专家包实际调用另行验收');return;
  }
  if(row===40){await home(c);await timed(c,()=>click(p,/案例库:/),`document.querySelectorAll('.mw-case-card').length>0 && q.ready(q.main())`,'进入案例库至首屏卡片封面解码就绪');note(c,`当前挂载 ${await p.locator('.mw-case-card').count()} 张案例卡片，首屏图片已解码`);partial(c,'首屏可见封面已完成；离屏懒加载封面及后续分页未计入');return;}
  if(row===41){await cases(c);await timed(c,()=>p.locator('.mw-case-card').filter({hasText:'供应链降本'}).first().click(),`q.btn('效果预览') && q.text('详细介绍') && q.ready(document.querySelector('[role="dialog"]'))`,'打开案例预览至详情及可视资源就绪');note(c,'案例预览弹窗、介绍和可见资源就绪');partial(c,'内嵌文件完整内容及离屏资源未逐一下载校验');return;}
  if(row===42){await preview(c);await timed(c,()=>click(p,'案例回放'),`Array.from(document.querySelectorAll('p')).some(e=>q.visible(e)&&e.textContent.includes('现在是案例回放，输入框无法输入内容')) && q.ready(document.querySelector('[role="dialog"]'))`,'切换案例回放至只读消息首屏就绪');note(c,'案例回放只读提示及首屏内容就绪');partial(c,'未逐阶段检查完整回放轨迹和文件内容');return;}
  if(row===43){await fixture(c);c.stage='打开案例预览';await preview(c);c.stage='执行案例做同款';await timed(c,()=>click(p,'做同款'),`/^#\\/workspace\\/[^/]+\\/session$/.test(location.hash) && q.editor()?.isContentEditable && q.editor().textContent.trim().length>0 && q.ready(q.main())`,'做同款至新任务和案例指令预填就绪');const chars=(await ed(p).innerText()).trim().length;assert(chars>0,'案例指令没有回显');note(c,`做同款回到独立空间的新任务，预填指令 ${chars} 字符；未发送，结束清空草稿`);return;}
  if(row===45){await cases(c);const time=button(p,/按时间/);const missing=!await time.isVisible();
    if(missing){c.originalScenario={status:'blocked',reason:'当前版本无按时间入口'};partial(c,'原表按时间分支无入口；仅补测当前版本分类切换，不代表时间筛选通过');}
    const target=button(p,'经营管理'),before=await target.getAttribute('class');c.defer(()=>click(p,'全部'));
    await timed(c,()=>target.click(),`q.btn('经营管理')?.getAttribute('class')!==${JSON.stringify(before)} && document.querySelectorAll('.mw-case-card').length>0 && q.ready(q.main())`,'案例分类切换至经营管理卡片就绪',{supporting:missing});note(c,`经营管理分类切换后挂载 ${await p.locator('.mw-case-card').count()} 个案例，结束恢复全部`);return;}
  if(row===46){await home(c);await timed(c,()=>click(p,/自动化:/),`q.text('已安排') && q.btn('从模板添加') && q.ready(q.main())`,'进入自动化页至列表及操作入口就绪');note(c,'已安排、已完成区及模板入口完成首屏加载；未修改或运行调度任务');partial(c,'仅当前已有任务数量的热态首屏样本，不代表大数据量或冷启动');return;}
  throw new Blocked('没有本轮适配实现');
}

async function historyPopup(c,supporting=false) {
  const p=c.page;
  await timed(c,()=>click(p,'历史提问'),`Array.from(document.querySelectorAll('div.fixed')).some(e=>q.visible(e)&&e.textContent.includes('历史提问')&&(e.textContent.includes('暂无历史提问')||e.querySelectorAll('button').length>1)&&q.ready(e))`,'打开历史提问至浮层记录或明确空态就绪',{supporting});
  if(await p.getByText('暂无历史提问',{exact:true}).isVisible()){note(c,'历史提问浮层已渲染，当前为空记录状态');partial(c,'已验证弹窗渲染与空态；有记录时的条目和跳转未覆盖');}else note(c,'历史提问浮层包含可选择记录');
}
