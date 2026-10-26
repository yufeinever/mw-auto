import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'data/interface-audit-20261026');
const ids=['1793019769981-96e1fc81-0bb9-4231-b68b-65a9bbe66d39','1793021070101-06a6209b-d78c-4d2f-9188-0dcbcd430b5a'];
const reports=await Promise.all(ids.map(id=>fs.readFile(path.join(dir,id+'.json'),'utf8').then(JSON.parse)));
const ipcs=await Promise.all(ids.map(id=>fs.readFile(path.join(dir,id+'-ipc.json'),'utf8').then(JSON.parse)));
if(reports.some(r=>r.status!=='completed')||ipcs.some(i=>!i.complete))throw Error('Wait for execution and collection to complete');
const events=ipcs.flatMap(i=>i.events.filter(e=>Date.parse(e.at)>=Date.parse(i.readyAt||i.startedAt)).map(e=>({...e,runId:i.runId})));
const unique=a=>[...new Set(a)],clean=s=>String(s??'').replace(/\|/g,'／').replace(/[\r\n]+/g,' ');
const primary=reports[0],supplement=reports[1];
const counts=events.reduce((out,e)=>(out[e.kind]=(out[e.kind]||0)+1,out),{});
const rows=primary.rows.map(r=>{
  const second=supplement.rows.find(s=>s.id===r.id&&s.status!=='not_run');
  const evidence=[r,...(second?[second]:[])];
  const ipc=events.filter(e=>e.caseId===r.id&&e.kind!=='assets:result');
  return {id:r.id,name:r.name,status:r.status,supplement:second?.status,
    ipcCovered:evidence.some(e=>e.ipcCoverage==='captured'),
    localRoutes:unique(evidence.flatMap(e=>e.localRoutes.filter(x=>!x.key.startsWith('OPTIONS ')).map(x=>x.key))),
    ipcRoutes:unique(ipc.map(e=>`${e.kind} ${e.method||''} ${e.route||''}${e.assetType?' [type='+e.assetType+']':''}`)),
    limitations:unique(evidence.map(e=>e.reason).filter(Boolean))};
});
const cleanup=await fs.readFile(path.join(dir,'fixture-cleanup.json'),'utf8').then(JSON.parse).catch(()=>null);
const tcp=await fs.readFile(path.join(dir,'tcp-snapshot.json'),'utf8').then(JSON.parse);
const summary={generatedAt:new Date().toISOString(),primaryRun:ids[0],supplementRun:ids[1],primaryOutcomes:primary.outcomes,supplementOutcomes:supplement.outcomes,
  observedCases:rows.filter(r=>r.ipcCovered).length,ipcEventCounts:counts,
  assetResults:{total:counts['assets:result']||0,failed:events.filter(e=>e.kind==='assets:result'&&!e.ok).length},
  businessRouteGroups:unique(reports.flatMap(r=>r.businessRouteGroups.map(g=>g.key))),
  dropped:reports.reduce((n,r)=>n+r.rows.reduce((n,x)=>n+x.dropped,0),0),logGaps:reports.reduce((n,r)=>n+r.rows.reduce((n,x)=>n+x.logGaps,0),0),
  cleanup,tcp,rows};
const lines=['# MobileWork 热启动实跑：接口调用去向','',
  `实测日期：2026-10-26。完整批次44项；补测前14项以补齐主进程采集起始缺口。原始批次保留，补测不覆盖历史。`,
  `完整批次结果：${Object.entries(primary.outcomes).map(([s,n])=>`${s} ${n}项`).join('，')}。补测：${Object.entries(supplement.outcomes).map(([s,n])=>`${s} ${n}项`).join('，')}。`,'',
  '**全部44项均实际尝试执行，但失败/阻塞项没有走完后续业务路径，不能称为44项功能全部通过或接口全覆盖。** 两批次合计有从用例起点开始的页面及IPC观察覆盖 '+summary.observedCases+'/44 项。','',
  '## 请求打到哪里','',
  '| 通道 | 地址/路径 | 本次证据 |','| --- | --- | --- |',
  `| 页面→本地业务服务 | http://127.0.0.1:5774 | 完整批次${primary.local.requests}次HTTP请求；${primary.preflightRequests}次OPTIONS预检；其余${primary.businessRequests}次，${primary.businessRouteGroups.length}个脱敏方法/路由组 |`,
  `| 页面→主进程→资产服务 | http://172.16.251.159:9070/mw2yunxi/… | 资产IPC实际发起${counts['assets:fetch']||0}次；目标地址依据当前安装配置及主进程映射，IPC调用本身不证明HTTP已出网 |`,
  `| 主进程身份探活 | /mw2yunxi/rbacmgr/api/gm/user/mw/info | 完整批次同期${primary.authProbes.length}条探活完成日志，unknown ${primary.authProbes.filter(p=>p.state==='unknown').length}条；无用例因果关联，unknown不唯一代表超时 |`,
  `| 本地自动化IPC | automation:list、automation:runs（以逐项实录为准） | 直接IPC调用，不计为HTTP接口 |`,
  `| 同期模型代理 | 配置目标 http://172.16.251.159:9070/llm/v1/chat/completions | 完整批次同期${primary.proxy.failures}条失败记录；未归属于当前UI用例，不是本次主动发送模型任务 |`,'',
  `完整批次页面直接远端HTTP记录${primary.remotePage.requests}条；这不代表没有远端调用。资产完成日志${primary.assets.events}条，不能据此计算远端平均/P95或成功率。补测观察到资产IPC返回${summary.assetResults.total}次，其中失败标记${summary.assetResults.failed}次；返回没有状态码时不捏造HTTP错误码。`,
  `系统TCP快照（${tcp.at}）：MobileWork到172.16.251.159:9070的7条连接处于SYN_SENT，证明存在实际连接尝试，快照时尚未建立TCP连接；无法由此识别HTTP路径、关联具体用例或断定VPN/路由/服务端哪一环故障。证据：[tcp-snapshot.json](tcp-snapshot.json)。`,
  '资产列表共用 /asset/api/v1/platform/assets，expert/group/skill/connector 为业务分类，并非四个独立接口。案例包、详情、安装等后续路径只按下面的实际记录计入；代码里存在但未走到的不算实测覆盖。','',
  `完整批次本地记录：HTTP≥400为${primary.local.httpErrors}；取消${primary.local.canceled}次（ERR_ABORTED）；排除取消后的网络失败${primary.transportFailuresExcludingCanceled}；观察结束未完成${primary.unfinishedRequests}次。两批次记录丢弃${summary.dropped}，日志读取缺口${summary.logGaps}。`,'',
  '## 44项实际观察','',
  '“本地路由组”包含准备、后台轮询和清理。IPC按时间窗归属，轮询映射可能滞后约2.5秒；尤其请求返回可能属于前一用例发起，不据此断言某一次点击导致调用。未观察到调用不等于该功能永远纯本地。','',
  '| 用例 | 功能 | 整轮结果 | 补测 | 本地路由组 | 资产/自动化IPC实际记录 |','| --- | --- | --- | --- | ---: | --- |',
  ...rows.map(r=>`| ${r.id} | ${clean(r.name)} | ${r.status} | ${r.supplement||'—'} | ${r.localRoutes.length} | ${clean(r.ipcRoutes.join('；')||'本窗口未观察到')} |`),'',
  '## 逐项路由和未完成边界',''];
for(const row of rows)lines.push(`### ${row.id} ${row.name}`,'',`本地HTTP：${row.localRoutes.map(x=>'`'+x+'`').join('、')||'未观察到'}。`,'',`IPC：${row.ipcRoutes.map(x=>'`'+x+'`').join('、')||'未观察到'}。`,'',`限制：${row.limitations.map(clean).join('；')||'按现有脚本通过；不代表产品该功能的全部路径均覆盖。'}`,'');
lines.push('## 复现与证据','',
  ...ids.map((id,i)=>`- ${i?'补测':'整轮'}逐项原始观测：[${id}.md](${id}.md)，结构化数据：[JSON](${id}.json)。`),
  '- 临时CDP日志点不暂停执行，采集结束已移除；可能影响耗时，本次属于诊断遍历，不能作为严格性能基准。',
  '- 路由模板抹除了ID及未列入白名单的片段，可能合并多个路径；路由组数不是产品全量接口数。',
  '- 本轮未发送模型任务，不覆盖模型推理、工具业务执行、登录、云同步等完整链路。',
  cleanup?`- 测试清理：注销本轮空测试空间${cleanup.removed.length}个，保留目录；原有空间ID保持：${cleanup.retainedIdsUnchanged}；跳过有会话空间${cleanup.skipped.length}个。`:'- 测试空间清理尚未核验。','');
await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
await fs.writeFile(path.join(dir,'接口调用去向-实跑汇总.md'),lines.join('\n'));
console.log(JSON.stringify({out: path.join(dir,'接口调用去向-实跑汇总.md'),primary:summary.primaryOutcomes,supplement:summary.supplementOutcomes,covered:summary.observedCases,ipc:counts}));
