const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sources={application:'页面CDP',network:'NetLog'};
const evidence={socket_bound:'NetLog绑定',cdp_peer:'页面响应对端',url_target:'URL目标候选',cache:'缓存响应',tcp_sample:'TCP连接记录',udp_event:'UDP事件'};
const types={local:'本地',private:'内网',public:'公网',domain:'域名（IP未知）'};
const ms=n=>Number.isFinite(n)?Number(n.toFixed(2)).toLocaleString('zh-CN')+' ms':'—';
let current=null,selected=null;
const sum=(routes,source)=>{const rows=routes.filter(r=>r.source===source);return rows.length?rows.reduce((n,r)=>n+r.count,0):null;};
const count=n=>n===null?'未获取':n.toLocaleString('zh-CN');
const unique=routes=>new Set(routes.map(r=>[r.source,r.method,r.endpoint].join('|'))).size;

export function renderEgress(view) {
  current=view;const report=view.egress,all=report?.entries||[],query=$('egress-search').value.trim().toLowerCase(),scope=$('egress-scope').value;
  const entries=all.filter(e=>(scope==='all'||(scope==='local'?e.addressType==='local':e.addressType!=='local'))&&(!query||JSON.stringify([e.address,e.processes.map(p=>[p.pid,p.role]),e.routes.map(r=>[r.endpoint,r.method])]).toLowerCase().includes(query)));
  $('egress-note').textContent=report?(report.derivedFromSummary?'历史汇总候选 · ':'')+(view.endedAt?'':'NetLog接口停止后关联 · ')+`${entries.length} / ${all.length} 个地址 · 请求按来源分开计数`:'旧批次未生成出口关联，请重新记录。';
  $('egress-rows').innerHTML=entries.map(e=>`<tr><td class="endpoint"><code>${esc(e.address)}</code><br><small>${types[e.addressType]||'未知'} · ${esc(e.protocols.join(' / ')||'协议未获取')}</small></td><td class="boundary">${e.observations.map(k=>esc(evidence[k]||k)).join('、')}</td><td>${e.processes.map(p=>`${p.pid} / ${esc(p.role)}`).join('<br>')||'进程采样未匹配'}${e.tracePids.length?`<br><small>NetLog PID ${e.tracePids.join('、')}</small>`:''}</td><td>${count(sum(e.routes,'application'))} / ${count(sum(e.routes,'network'))}</td><td>${unique(e.routes)}</td><td><button class="secondary" data-egress-address="${esc(e.address)}" aria-label="查看 ${esc(e.address)} 的API">查看API</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">此筛选下暂无出口或URL目标记录</td></tr>';
  $('egress-boundary').textContent=report?.note||'';
  if($('egress-dialog').open)renderDetail();
}

function renderDetail(){
  const e=current?.egress?.entries.find(e=>e.address===selected);if(!e){$('egress-dialog').close();selected=null;return;}
  $('egress-title').textContent=e.address+' · API请求';
  $('egress-detail-note').textContent=(current.egress.derivedFromSummary?'历史汇总，仅列目标候选。':'')+'NetLog绑定确认请求与成功连接对端；网络栈PID不等于最初发起业务的进程。URL目标候选未确认实际连接；相同地址不证明进程归属。';
  const source=$('egress-detail-source').value,query=$('egress-api-search').value.trim().toLowerCase();
  const routes=e.routes.filter(r=>(source==='all'||r.source===source)&&(!query||(r.method+' '+r.endpoint).toLowerCase().includes(query)));
  $('egress-detail-rows').innerHTML=routes.map(r=>`<tr><td>${sources[r.source]}</td><td class="endpoint"><code>${esc(r.method)}</code> ${esc(r.endpoint)}</td><td>${esc(evidence[r.evidence])}${r.networkPid?`<br><small>网络栈PID ${r.networkPid}</small>`:''}</td><td>${r.count}</td><td>${r.rpm??'—'} / ${r.peakSecondRequests??'—'}</td><td>${ms(r.headers?.medianMs)} / ${ms(r.headers?.p95Ms)}</td><td>${ms(r.duration?.medianMs)} / ${ms(r.duration?.p95Ms)}</td><td>${Object.entries(r.status||{}).map(([k,v])=>`${esc(k)} ×${v}`).join('、')||'—'}</td><td>${r.httpErrors??0} / ${r.failed??0} / ${r.pending??0}</td></tr>`).join('')||`<tr><td colspan="9" class="empty">${e.routes.length?'此筛选下暂无API记录。':'仅观察到连接或UDP事件，具体API未获取；不能由连接数推算请求量。'}</td></tr>`;
}

export function processApiLink(view,c){
  const e=view.egress?.entries.find(e=>e.address===c.remote);if(!e)return '未获取';
  const confirmed=e.routes.filter(r=>r.evidence==='socket_bound'&&r.networkPid===c.pid),candidate=e.routes.filter(r=>r.evidence!=='cache'&&!r.networkPid);
  const label=confirmed.length?`网络栈绑定 ${unique(confirmed)} 项`:candidate.length?`同地址候选 ${unique(candidate)} 项`:'未获取';
  return label==='未获取'?label:`<button class="link-button" data-egress-address="${esc(c.remote)}" title="查看该地址全部API及依据；同地址候选不证明此PID发起了请求">${label}</button>`;
}

export function initEgress(){
  for(const id of ['egress-search','egress-scope'])$(id).addEventListener(id==='egress-search'?'input':'change',()=>{if(current)renderEgress(current);});
  for(const id of ['egress-detail-source','egress-api-search'])$(id).addEventListener(id==='egress-api-search'?'input':'change',renderDetail);
  document.addEventListener('click',event=>{const b=event.target.closest('[data-egress-address]');if(!b)return;selected=b.dataset.egressAddress;$('egress-detail-source').value='all';$('egress-api-search').value='';renderDetail();if(selected&&!$('egress-dialog').open)$('egress-dialog').showModal();});
  $('egress-close').onclick=()=>$('egress-dialog').close();
  $('download-egress').onclick=()=>{if(!current?.egress)return;const data={id:current.id,startedAt:current.startedAt,endedAt:current.endedAt,status:current.status,durationSeconds:current.durationSeconds,layers:current.layers,egress:current.egress,privacy:current.privacy};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=current.id+'-egress.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
}
