const num=n=>Number.isFinite(n)?`${n} ms`:'未采集';
export function observationLines(o){
  if(!o)return ['此历史记录未采集网络及模型代理信息。'];
  const n=o.network||{},p=o.proxy||{},requests=n.requests||[],events=p.events||[];
  const bad=requests.filter(r=>r.status>=400||r.outcome==='failed'),upstream=events.filter(e=>e.event==='upstream_response'&&e.status>=400);
  const lines=[`页面网络：${n.status==='observing'?'已采集':n.status==='not_attached'?'未连接':'采集不可用'}；请求 ${n.counts?.started||0}，异常样本 ${bad.length}。`,
    `模型代理日志：${p.status==='observing'?'已读取本轮新增记录':'不可用'}；记录 ${events.length}，上游错误响应 ${upstream.length}（同期未归属，不能断定属于本用例）。`,
    '首字时间：未采集；stream_end只表示流结束，不能当作回答成功。'];
  if(!o.complete)lines.push('采集未正常结束，以下仅为退出前最近保存的观察快照。');
  if(n.dropped||p.dropped||p.gaps||p.rotationCount)lines.push(`采集边界：网络截断 ${n.dropped||0}；日志截断 ${p.dropped||0}；读取缺口 ${p.gaps||0}；日志轮转 ${p.rotationCount||0}。`);
  const phase={startup:'启动',execution:'执行',cleanup:'收尾'};
  for(const r of requests.slice(-160))lines.push(`网络 · ${phase[r.phase]||r.phase} · ${r.method} ${r.route} · ${r.local?'本机':'外部'} · HTTP ${r.status??'未收到'} · 响应头 ${num(r.headersMs)} · 请求结束 ${num(r.durationMs)} · ${r.outcome}${r.errorCode?' · '+r.errorCode:''}`);
  for(const e of events.slice(-80))lines.push(`同期日志（未归属） · ${phase[e.phase]||e.phase} · ${e.event}${e.status?' · HTTP '+e.status:''}${Number.isFinite(e.reportedDurationMs)?' · 日志耗时 '+num(e.reportedDurationMs):''}${e.callKey?' · 调用 '+e.callKey:''}${e.requestedModel?' · '+e.requestedModel+' → '+(e.effectiveModel||'未采集'):''}${e.reason?' · '+e.reason:''}`);
  return lines;
}
export function resultObservationGroups(result){
  if(!result)return [];
  if(result.observationAttempts?.length)return result.observationAttempts.map(a=>({label:a.iteration===1?'第1次预热（不计成绩）':`第${a.iteration}次执行`,observation:a.observation}));
  return [{label:'本轮',observation:result.observation}];
}
export function observationMarkdown(results){
  const clean=s=>String(s).replace(/[<>]/g,'').replace(/\r?\n/g,' ');
  return '\n## 网络与模型响应诊断\n\n请求与日志耗时不替代页面操作延迟；同期日志不证明用例归属，历史结果不重判。\n\n'+results.map(r=>`### ${clean(r.id)} · ${clean(r.mode||'warm')}\n\n`+resultObservationGroups(r).map(g=>`**${g.label}**\n\n`+observationLines(g.observation).map(l=>'- '+clean(l)).join('\n')).join('\n\n')).join('\n\n')+'\n';
}
