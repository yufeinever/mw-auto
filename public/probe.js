import {protocolCoverage} from './probe-coverage.js';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={recording:'记录中',starting:'启动中',stopping:'正在汇总',stopped:'已停止',completed:'已结束',disabled:'未启用',partial:'部分采集',interrupted:'已中断',unavailable:'不可用',failed:'失败'};
const types={local:'本地',private:'内网',public:'公网',domain:'域名（未判定）'};
const date=s=>s?new Date(s).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—';
const ms=v=>Number.isFinite(v)?Number(v.toFixed(2)).toLocaleString('zh-CN')+' ms':'—';
let state={},view=null,selected=null,working=false,loading=false;
async function api(url,body){const res=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json','X-MW-CSRF':state.csrf},body:JSON.stringify(body)}:{});const j=await res.json();if(!res.ok)throw Error(j.error||'请求失败');return j;}
async function load(){if(loading)return;loading=true;try{state=await api('/api/probe/state');if(!selected){if(state.active)view=state.active;else if(state.history?.[0]&&(view?.id!==state.history[0].id||['starting','recording','stopping'].includes(view?.status)))view=await api('/api/probe/'+state.history[0].id);}if(document.getSelection()?.isCollapsed!==false)render();}finally{loading=false;}}
function render(){
  $('version').textContent='v'+state.version;const a=state.active;
  $('start').disabled=!!a||working;$('stop').disabled=!a||working||a.status==='starting'||a.status==='stopping';
  for(const k of ['application','network','process','scenario','duration'])$(k).disabled=!!a||working;
  if(a){for(const k of ['application','network','process'])$(k).checked=!!a.enabled[k];$('scenario').value=a.scenario;if(a.requestedSeconds)$('duration').value=String(a.requestedSeconds);}
  for(const k of ['mark-idle','mark-operation'])$(k).disabled=working||a?.status!=='recording';
  $('run-state').innerHTML=`<span class="dot"></span><strong>${esc(a?names[a.status]:'未记录')}</strong><small>${a?'可继续在客户端操作':'点击开始记录新批次'}</small>`;
  $('live').classList.toggle('hidden',!a);if(a){$('live-meta').textContent=`${a.id} · ${date(a.startedAt)} · 页面请求 ${a.application.requests}`;$('live-elapsed').textContent=Math.floor(a.durationSeconds/60)+':'+String(Math.floor(a.durationSeconds)%60).padStart(2,'0');}
  for(const k of ['application','network','process']){const s=(a||view)?.layers?.[k];$(k+'-status').textContent=s?`${names[s.state]||s.state}${s.dropped?' · 丢弃 '+s.dropped:''}${s.gaps?' · 缺口 '+s.gaps:''}${s.bufferPercent!==undefined?' · 缓冲 '+s.bufferPercent+'%':''}`:'待启动';$(k+'-status').title=s?.note||'';}
  $('summary').classList.toggle('hidden',!view);
  if(view){$('summary-meta').textContent=`${names[view.status]||view.status} · ${date(view.startedAt)} → ${date(view.endedAt)} · ${view.durationSeconds||0}s · ${view.scenario==='idle'?'静置基线':'功能遍历'}`;
    const observed=k=>view.enabled[k]&&!['unavailable','failed','disabled'].includes(view.layers[k].state);
    $('endpoint-count').textContent=observed('application')?view.application.uniqueEndpoints:'—';$('request-count').textContent=observed('application')?view.application.requests:'—';$('remote-count').textContent=!observed('network')?'未采集':view.endedAt?view.network.remoteRequests:'停止后汇总';$('connection-count').textContent=observed('process')?new Set(view.process.connections.map(r=>r.remote)).size:'—';
    renderInterfaces();
    $('coverage-rows').innerHTML=protocolCoverage(view).map(r=>`<tr><td>${esc(r.type)}</td><td>${esc(r.state)}</td><td class="boundary">${esc(r.boundary)}</td></tr>`).join('');
    const inventory=view.layers.application.targetTypes;
    $('target-inventory').textContent=inventory?`启动时发现的目标：${Object.entries(inventory).map(([k,n])=>k+' ×'+n).join('、')}；实际附加过 ${view.layers.application.attachedTargets||0} 个页面。`:'本批没有可用的CDP目标清单。';
    $('channels').innerHTML=(view.application.channels||[]).map(r=>`<tr><td>${esc(r.kind)}</td><td class="endpoint"><code>${esc(r.endpoint||'URL未获取（采集前已存在或事件缺失）')}</code></td><td>${r.connections}${r.preexisting?`<br><small>握手未观测 ${r.preexisting}</small>`:''}</td><td>${r.kind==='WebSocket'?`${r.sentFrames} / ${r.receivedFrames}`:'—'}</td><td>${r.kind==='WebSocket'?`${r.sentFramesPerMinute} / ${r.receivedFramesPerMinute}`:'—'}</td><td>${r.kind==='SSE'?`${r.receivedEvents} / ${r.receivedChunks}`:'—'}</td><td>${r.sentBytes} / ${r.receivedBytes}</td><td>${ms(r.handshake.medianMs)} / ${ms(r.handshake.p95Ms)}</td><td>${r.closed} / ${r.incomplete} / ${r.errors}</td></tr>`).join('')||`<tr><td colspan="9" class="empty">${view.collectorRevision>=2?'本批暂无可见页面的WebSocket / SSE样本；不表示整个客户端没有使用。':'旧批次未统计帧和流事件，请重新记录。'}</td></tr>`;
    $('transports').innerHTML=(view.network.transports||[]).map(r=>`<tr><td>${esc(r.protocol)}</td><td>${r.events}</td><td>${r.sources}</td><td>${r.sentEvents} / ${r.receivedEvents}</td><td>${r.sentBytes} / ${r.receivedBytes}</td><td class="endpoint">${r.peers.map(esc).join('、')||'未获取'}</td><td>${r.failedEvents}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">停止后汇总可见事件；旧批次未做协议分类，未观察到不等于未使用。</td></tr>';
    $('phases').innerHTML=view.network.phases.map(r=>`<tr><td>${esc(({TCP_CONNECT:'TCP 建连',SSL_CONNECT:'TLS 握手',HOST_RESOLVER_MANAGER_REQUEST:'域名解析',PROXY_RESOLUTION_SERVICE:'代理解析'})[r.name]||r.name)}</td><td>${r.samples}</td><td>${ms(r.medianMs)}</td><td>${ms(r.p95Ms)}</td><td>${ms(r.maxMs)}</td><td>${r.failed}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">未采到配对事件；可能复用连接、尚未停止或该层未启用</td></tr>';
    $('connections').innerHTML=view.process.connections.map(r=>`<tr><td>TCP</td><td>${r.pid} / ${esc(r.role)}</td><td><code>${esc(r.remote)}</code></td><td>${types[r.addressType]}</td><td>${r.samples} / ${view.layers.process.tcpSamples??view.process.sampleCount}</td><td>${r.peakConnections}</td><td>${Object.entries(r.states).map(([k,v])=>`${esc(k)} ×${v}`).join('、')}</td><td>${esc(date(r.firstSeen))}<br>${esc(date(r.lastSeen))}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">当前窗口没有远端TCP连接样本（不表示没有请求）</td></tr>';
    $('udp-endpoints').innerHTML=(view.process.udpEndpoints||[]).map(r=>`<tr><td>UDP</td><td>${r.pid} / ${esc(r.role)}</td><td><code>${esc(r.local)}</code></td><td>未知</td><td>${r.samples} / ${view.layers.process.udpSamples??view.process.sampleCount}</td><td>${esc(date(r.firstSeen))}<br>${esc(date(r.lastSeen))}</td></tr>`).join('')||`<tr><td colspan="6" class="empty">${view.collectorRevision>=2?'本批未观察到UDP本地端点；短时端点可能漏采。':'旧批次未采集UDP，请重新记录。'}</td></tr>`;
    $('coverage').textContent=view.coverage;$('layer-notes').textContent=Object.entries(view.layers).map(([k,s])=>`${k}: ${names[s.state]}；${s.note}；丢弃 ${s.dropped}，缺口 ${s.gaps}${s.segments?`，分段 ${s.segments}，分段间隔 ${s.rollovers||0} 次 / ${s.segmentGapMs||0} ms`:''}${s.dataLoss?'，追踪数据丢失':''}${s.bufferFull?'，缓冲已满':''}`).join('\n');
    $('markers').textContent=(view.markers||[]).map(m=>`${date(m.at)} ${m.kind==='idle'?'静置开始':'功能操作开始'}`).join(' · ');
  }
  $('history-list').innerHTML=(state.history||[]).map(r=>`<button class="history-item" data-id="${esc(r.id)}"><span>${esc(date(r.startedAt))} · ${names[r.status]||r.status}</span><strong>${esc(r.id)}</strong><small>页面请求 ${r.requests} · 网络层远端请求 ${r.remoteRequests}</small></button>`).join('')||'<p class="muted">暂无已结束批次</p>';
}
function renderInterfaces(){if(!view)return;const source=$('source').value,scope=$('scope').value;
  const rows=(source==='network'?view.network.interfaces:view.application.interfaces).filter(r=>scope==='all'||(scope==='local'?r.addressType==='local':r.addressType!=='local'));
  $('interface-note').textContent=source==='network'?'NetLog 独立观测；停止后统计。不能覆盖 Node.js 原生 HTTP，也不与页面层相加。':'页面请求可能只到本地网关；不能据此认定请求已发送到远端后端。';
  $('interfaces').innerHTML=rows.map(r=>`<tr><td class="endpoint"><code>${esc(r.method)}</code> ${esc(r.endpoint)}<br><small>协议 ${esc(Object.keys(r.protocols||{}).join(' / ')||'未获取')} · 连接对端 ${esc((r.peers||[]).join('、')||'未获取')}</small>${r.hints.length?`<br><small class="bad">${esc(r.hints.join('；'))}</small>`:''}</td><td>${types[r.addressType]}</td><td>${r.count}</td><td>${r.rpm} · ${r.peakSecondRequests}</td><td>${Object.entries(r.status).map(([k,v])=>`${k} ×${v}`).join('、')||'—'}</td><td>${r.httpErrors} / ${r.failed}</td><td>${ms(r.headers.medianMs)} / ${ms(r.headers.p95Ms)}</td><td>${ms(r.duration.medianMs)} / ${ms(r.duration.p95Ms)}<br><small>${r.duration.samples} 个完整样本</small></td><td>${ms(r.intervalMedianMs)}<br><small>${r.intervalSamples} 个间隔</small></td><td>${r.pending}</td></tr>`).join('')||'<tr><td colspan="10" class="empty">此筛选下暂无接口样本；可切换来源或选择“全部”</td></tr>';
}
async function task(fn){working=true;render();$('message').textContent='';try{await fn();}catch(e){$('message').textContent=e.message;}finally{working=false;await load().catch(e=>$('message').textContent=e.message);}}
$('start').onclick=()=>task(async()=>{$('message').textContent='正在连接记录器…';const enabled=Object.fromEntries(['application','network','process'].map(k=>[k,$(k).checked]));selected=null;view=await api('/api/probe/start',{enabled,seconds:Number($('duration').value),scenario:$('scenario').value});$('message').textContent=view.status==='failed'?'本批未成功开启任何记录器，查看各层原因。':'记录已开启；每层实际状态见上方。';});
$('stop').onclick=()=>task(async()=>{$('message').textContent='正在停止并汇总网络事件…';selected=null;view=await api('/api/probe/stop',{});$('message').textContent='记录已停止，汇总已保存。';});
for(const kind of ['idle','operation'])$('mark-'+kind).onclick=()=>task(()=>api('/api/probe/mark',{kind}));
$('source').onchange=renderInterfaces;$('scope').onchange=renderInterfaces;
$('history-list').onclick=e=>{const b=e.target.closest('[data-id]');if(b)task(async()=>{view=await api('/api/probe/'+b.dataset.id);selected=b.dataset.id;});};
$('latest').onclick=()=>task(async()=>{selected=null;view=null;});
$('download').onclick=()=>{if(!view)return;const url=URL.createObjectURL(new Blob([JSON.stringify(view,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=view.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
await load().catch(e=>$('message').textContent=e.message);setInterval(()=>{if(!working)load().catch(e=>$('message').textContent=e.message);},3000);
