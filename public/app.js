import {metricRows,compareMetric,shortLabel,formatMs} from './metric-view.js';
const $=id=>document.getElementById(id);
const names={pass:'通过',partial:'部分验证',blocked:'阻塞',failed:'失败',interrupted:'中断',running:'运行中',paused:'已暂停',stopping:'停止中',stopped:'已停止',completed:'已完成',waiting_for_cold:'等待退出托盘'};
let state,selected=new Set(),module='全部',chosen=null,chosenMode='warm',viewRun=null,historyId=null,busy=false,coldTargets=['MW-STARTUP-HOME'];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=s=>`<span class="pill ${esc(s)}">${esc(names[s]||'未执行')}</span>`;
const date=s=>s?new Date(s).toLocaleString('zh-CN',{hour12:false}):'—';
const byId=r=>Object.fromEntries((r?.results||[]).map(x=>[x.id,x]));
const results=()=>historyId?(viewRun?.mode==='cold'?{}:byId(viewRun)):({...state?.latestResults,...(state?.active?.mode!=='cold'?byId(state?.active):{})});
const coldResults=()=>historyId?(viewRun?.mode==='cold'?byId(viewRun):{}):({...state?.latestColdResults,...(state?.active?.mode==='cold'?byId(state?.active):{})});
const newest=(warm,cold)=>!warm?cold:!cold?warm:(cold.startedAt||'')>(warm.startedAt||'')?cold:warm;
const hint=(text,label='说明')=>`<span class="help" tabindex="0" role="note" aria-label="${esc(label)}" title="${esc(text)}">ⓘ</span>`;
const targetText=ms=>ms===null?'目标 —':'目标 ≤ '+formatMs(ms)+' ms';
const renderMetrics=(c,r,mode='warm')=>{
  const rows=metricRows(r,mode);
  if(!rows.length){const comparison=compareMetric(c,r,null,mode);return `<div class="muted">未测</div><div class="metric-meta">${targetText(comparison.targetMs)}${comparison.text!=='未测'?hint(comparison.note):''}</div>`;}
  return rows.map(row=>{
    const comparison=compareMetric(c,r,row,mode);
    const note=[row.label,row.note,comparison.note,row.history?'历史记录，未按当前规则重测。':'',c.currentMapping||''].filter(Boolean).join('\n');
    return `<div class="timing-item"><div class="timing-heading"><span class="timing-label" title="${esc(row.label)}">${esc(shortLabel(row.label))}</span>${hint(note,row.history?'历史计时说明':'计时说明')}</div><div class="timing-value">${mode==='cold'?`<button class="time-link" data-cold-detail="${esc(r.id)}">${formatMs(row.durationMs)} <small>ms</small></button>`:`<span class="metric-value">${formatMs(row.durationMs)}</span> <small>ms</small>`}</div><div class="metric-meta"><span>${targetText(comparison.targetMs)}</span><span class="comparison ${comparison.tone}" title="${esc(comparison.note)}">${esc(comparison.text)}</span></div></div>`;
  }).join('');
};
const metric=(c,r)=>renderMetrics(c,r);
const coldMetric=(c,r)=>renderMetrics(c,r,'cold');
async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json','X-MW-CSRF':state.csrf},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw new Error(j.error||'请求失败');return j;}
async function messageTask(fn){try{$('message').textContent='';await fn();}catch(e){$('message').textContent=e.message;}}
const filtered=()=>state.catalog.filter(c=>module==='全部'||c.module===module);
function render(){
  document.querySelector('.version').textContent='v'+state.version;
  const all=results(),colds=coldResults(),rr=state.catalog.map(c=>newest(all[c.id],colds[c.id])).filter(Boolean);
  $('total').textContent=state.catalog.length;$('passed').textContent=rr.filter(r=>r.functional==='pass').length;$('partial').textContent=rr.filter(r=>r.functional==='partial').length;$('issues').textContent=rr.filter(r=>['blocked','failed','interrupted'].includes(r.functional)).length;
  $('modules').innerHTML=['全部',...new Set(state.catalog.map(c=>c.module))].map(x=>`<button data-module="${esc(x)}" class="${module===x?'active':''}">${esc(x)}</button>`).join('');
  $('selection').textContent=`已选 ${selected.size} 项 · 当前显示 ${filtered().length} 项`;
  $('cases').innerHTML=filtered().map(c=>{const r=all[c.id],cold=colds[c.id],latest=newest(r,cold);return `<tr><td><input type="checkbox" data-id="${c.id}" aria-label="选择 ${esc(c.name)}" ${selected.has(c.id)?'checked':''}></td><td><div class="case-id">${c.id} · ${esc(c.module)}</div><button class="case-name" title="${esc(c.currentMapping||c.target||c.name)}" data-detail="${c.id}">${esc(c.name)}</button></td><td>${state.active?.current===c.id?badge('running'):badge(latest?.functional)}</td><td>${metric(c,r)}</td><td>${coldMetric(c,cold)}</td><td><div class="row-actions"><button data-cold="${c.id}" ${state.active?'disabled':''}>冷启动</button><button data-run="${c.id}" ${state.active?'disabled':''}>热启动</button></div></td></tr>`;}).join('');
  $('run').disabled=!!state.active||!selected.size;$('run-cold').disabled=!!state.active||!selected.size;$('cold-home').disabled=!!state.active;$('all').checked=filtered().every(c=>selected.has(c.id));
  const r=historyId?viewRun:(state.active||viewRun||state.latest);
  $('run-status').textContent=names[r?.status]||'空闲';$('run-status').className=`pill ${r?.status||''}`;$('current').textContent=r?.current?`正在执行 ${r.current} · ${r.mode==='cold'?'冷启动':'热启动'}`:r?`批次 ${r.id.split('-')[0]}`:'等待执行';$('progress').max=r?.selected.length||44;$('progress').value=r?.results.length||0;$('counter').textContent=`${r?.results.length||0} / ${r?.selected.length||0}`;
  const waiting=state.active?.status==='waiting_for_cold';
  if(r?.status==='waiting_for_cold')$('current').textContent=`已完成 ${r.results.length}/${r.selected.length} 项，等待退出托盘后执行 ${r.pendingColdId}`;
  $('next-cold').hidden=true;$('stop').textContent=waiting?'停止批次':'当前项后停止';
  $('pause').disabled=!state.active||waiting||state.active.pauseRequested||state.active.stopRequested;$('stop').disabled=!state.active||state.active.stopRequested;$('resume').disabled=state.active?.status!=='paused';$('download').disabled=!r;
  $('logs').textContent=r?.logs.map(l=>`${new Date(l.time).toLocaleTimeString('zh-CN',{hour12:false})}  ${l.text}`).join('\n')||'暂无运行记录';
  $('history').innerHTML=state.runs.slice(0,8).map(r=>`<button data-history="${r.id}">${esc(date(r.startedAt))} · ${r.mode==='cold'?'冷启动':'热态'}<br>${esc(names[r.status]||r.status)} · ${r.count}/${r.total} 项</button>`).join('')||'<p class="muted">暂无记录</p>';
  const coldRun=historyId?(viewRun?.mode==='cold'?viewRun:null):(state.active?.mode==='cold'?state.active:state.latestCold),cr=coldRun?.results?.find(r=>r.id===coldRun.coldStartCaseId)||coldRun?.results?.[0],cs=coldRun?.coldStart||cr?.coldStart;
  $('cold-result').textContent=coldRun?`${date(cs?.launchAt||coldRun.startedAt)} · ${names[coldRun.status]||coldRun.status}${cs?' · 应用启动至首页就绪 '+cs.durationMs+' ms':' · 未取得应用启动计时'} · 已记录 ${coldRun.results.length}/${coldRun.selected.length} 项；各项操作耗时见下表冷批次列${!cs&&cr?.reason?' · '+cr.reason:''}`:'暂无冷启动结果；点击“冷启动首页”或任一用例的“冷启动”开始。';
  if(chosen)details(chosen,chosenMode);
}
function details(id,mode){
  mode ||= newest(results()[id],coldResults()[id])===coldResults()[id]&&coldResults()[id]?'cold':'warm';
  chosen=id;chosenMode=mode;const c=state.catalog.find(x=>x.id===id),r=(mode==='cold'?coldResults():results())[id];
  $('detail-title').textContent=`${c.id} · ${c.name} · ${mode==='cold'?'冷启动':'热态'}`;$('detail-status').innerHTML=badge(r?.functional);
  const list=items=>items?.length?`<ul>${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<p class="muted">暂无记录</p>';
  const sampleLines=(r?.measurements||[]).map(m=>`${m.iteration?'第 '+m.iteration+' 轮 · ':''}${m.label}：${m.durationMs} ms；${m.scope}`);
  const averages=(r?.statistics||[]).map(s=>r.repetition?.planned===2?`${s.label}：第2次正式执行 ${s.durationMs??'—'} ms（${s.sampleCount}/1 个有效样本，首次预热不计时）`:`${s.label}：历史第 2、3 轮均值 ${s.meanMs??'—'} ms（${s.sampleCount}/2 个有效样本）`);
  const shared=r?.batchStartup&&!r.coldStart?`<p>本批共享的应用启动至首页就绪：<strong>${esc(r.batchStartup.durationMs)} ms</strong>（${esc(r.batchStartup.caseId)}）</p><p class="muted">本项没有重启，下面单独列出本项操作耗时。</p>`:'';
  $('details').innerHTML=`<div><h3>原表与测试范围</h3>${c.currentMapping?`<p>当前映射：${esc(c.currentMapping)}</p>`:""}<p>${esc(c.target||'原表未填写详细终态。')}</p><p class="muted">${esc(c.sourceSheet)} · 第 ${c.row} 行 · ${esc(c.script)}<br>冷态目标 ${c.coldSeconds??'—'} s / 热态目标 ${c.hotSeconds??'—'} s</p>${r?.assessment?`<p>当前验收：${esc(r.assessment.scope)}。</p>${r.sourceFunctional==='partial'?'<p class="muted">按加载展示口径复核通过；原记录为部分验证，原始记录保留。</p>':''}`:''}</div><div><h3>本次执行</h3><p>${r?esc(date(r.startedAt)):'尚未执行'}</p><p>状态恢复：${r?r.restored?'已完成':'未确认':'—'}</p>${r?.batchStartupRef&&!r.startupPerformed?`<p>复用本批已启动的 MW，启动证据：${esc(r.batchStartupRef.caseId)}；本项不重新启动。</p>`:''}${r?.repetition?`<p>热启动完成 ${r.repetition.completed}/${r.repetition.planned} 次；第 1 次预热，不计入正式耗时。${r.repetition.planned===2?'以第 2 次执行为准，不取均值。':'历史批次保留原执行规则。'}</p>`:''}${r?.reason?`<p>${esc(r.reason)}</p>`:''}</div><div><h3>已验证断言</h3>${list(r?.assertions)}</div><div><h3>验收范围与补充说明</h3>${r?.originalScenario?`<p class="muted">原场景：${esc(r.originalScenario.reason)}；补充操作的计时不代表原场景通过。</p>`:''}${list([...(r?.limitations||[]),...(r?.cleanupIssues||[])])}</div><div class="full"><h3>性能记录</h3>${shared}${r?.coldStart?`<p>应用冷启动至首页首屏就绪：<strong>${r.coldStart.durationMs} ms</strong></p><p class="muted">${esc(r.coldStart.scope)}</p><p>以下为启动后的用例操作耗时，不能直接当作该操作的冷加载指标：</p>`:''}${list([...sampleLines,...averages])}<p class="muted">页面操作计时：渲染进程输入事件至状态连续两帧稳定。应用启动另行计时；Windows 结果不代表统信/麒麟验收。</p></div>`;
  if(r?.diagnostics?.length||r?.failure){
    const kinds={precondition:'前置条件未满足',automation:'自动化操作异常',assertion:'断言未满足',recovery:'状态恢复异常'};
    const diagnosticLines=[...(r.warmup?.diagnostics||[]).map(d=>`预热 · ${d.stage}`),...(r.diagnostics||[]).map(d=>`${r.repetition?.completed===2?'正式':'本轮'} · ${d.stage}`)];
    $('details').insertAdjacentHTML('beforeend',`<div class="full"><details><summary>执行诊断${r.failure?' · '+esc(kinds[r.failure.kind]||r.failure.kind):''}</summary>${r.failure?`<p>异常阶段：${esc(r.failure.stage)}</p>`:''}${list(diagnosticLines)}</details></div>`);
  }
}
async function refresh(){if(busy)return;busy=true;try{state=await api('/api/state');render();}catch(e){$('message').textContent=e.message;}finally{busy=false;}}
async function readiness(){const r=await api('/api/readiness');$('ready').textContent=r.ready?'客户端可连接':'客户端未就绪';$('ready').className=`pill ${r.ready?'pass':'blocked'}`;$('ready').title=r.note;}
async function start(ids){historyId=null;viewRun=null;await api('/api/run',{ids});await refresh();}
async function prepareCold(ids){
  coldTargets=Array.isArray(ids)?[...ids]:[ids];
  if(!coldTargets.length)throw new Error('请先勾选要执行的用例');
  const first=coldTargets[0],name=state.catalog.find(c=>c.id===first)?.name;
  $('cold-title').textContent='准备冷启动';
  $('cold-target').textContent=first==='MW-STARTUP-HOME'?'仅测应用启动至首页首屏就绪':`${coldTargets.length>1?'已选择 '+coldTargets.length+' 项，首先执行':'冷启动后执行'}：${first} · ${name}`;
  $('cold-wait-note').hidden=true;$('cold-cancel').textContent='取消';
  $('cold-message').textContent='请从系统托盘退出 MobileWork。';if(!$('cold-dialog').open)$('cold-dialog').showModal();
  try{const r=await api('/api/cold-readiness');$('cold-message').textContent=r.runningCount?`检测到 ${r.runningCount} 个 MW 进程，请先从托盘退出。`:'旧进程已退出，可以点击下方按钮开始。';}catch(e){$('cold-message').textContent=e.message;}
}
$('cold-home').onclick=()=>messageTask(()=>prepareCold('MW-STARTUP-HOME'));
$('cold-cancel').onclick=()=>$('cold-dialog').close();
$('cold-confirm').onclick=async()=>{const button=$('cold-confirm');button.disabled=true;try{await api('/api/cold-start',{confirmed:true,ids:coldTargets});historyId=null;viewRun=null;$('cold-dialog').close();await refresh();}catch(e){$('cold-message').textContent=e.message;}finally{button.disabled=false;}};
$('modules').onclick=e=>{const b=e.target.closest('[data-module]');if(b){module=b.dataset.module;render();}};
$('cases').onchange=e=>{const id=e.target.dataset.id;if(id){e.target.checked?selected.add(id):selected.delete(id);render();}};
$('cases').onclick=e=>{const b=e.target.closest('[data-run],[data-cold],[data-detail],[data-cold-detail]');if(b?.dataset.run)messageTask(()=>start([b.dataset.run]));if(b?.dataset.cold)messageTask(()=>prepareCold(b.dataset.cold));if(b?.dataset.detail)details(b.dataset.detail);if(b?.dataset.coldDetail)details(b.dataset.coldDetail,'cold');};
const select=()=>{filtered().forEach(c=>selected.add(c.id));render();};$('select').onclick=select;$('all').onchange=e=>{filtered().forEach(c=>e.target.checked?selected.add(c.id):selected.delete(c.id));render();};$('clear').onclick=()=>{selected.clear();render();};$('run').onclick=()=>messageTask(()=>start([...selected]));
$('run-cold').onclick=()=>messageTask(()=>prepareCold([...selected]));
for(const action of ['pause','resume','stop'])$(action).onclick=()=>messageTask(async()=>{await api('/api/control',{action});await refresh();});
$('check').onclick=()=>messageTask(readiness);
$('latest-view').onclick=()=>{historyId=null;viewRun=null;render();};
$('history').onclick=e=>{const b=e.target.closest('[data-history]');if(b)messageTask(async()=>{viewRun=await api('/api/runs/'+b.dataset.history);historyId=b.dataset.history;render();});};
$('download').onclick=()=>{const r=state.active||viewRun||state.latest;if(!r)return;const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`mobilework-${r.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
await refresh();await messageTask(readiness);setInterval(refresh,1500);
