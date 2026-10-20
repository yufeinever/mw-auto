import fs from 'node:fs/promises';
import path from 'node:path';
import {VERSION} from './lib/version.mjs';
import {assessRun} from './lib/assessment.mjs';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const catalog=JSON.parse(await fs.readFile(path.join(root,'data/cases.json'),'utf8'));
const runs=[];for(const f of await fs.readdir(path.join(root,'runs'))){if(f.endsWith('.json'))runs.push(assessRun(JSON.parse(await fs.readFile(path.join(root,'runs',f),'utf8'))));}
runs.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));const latest={},coldLatest={};for(const run of runs)for(const r of run.results){const target=run.mode==='cold'?coldLatest:latest;target[r.id]??={...r,runId:run.id};}
const results=catalog.map(c=>({...c,result:latest[c.id]||null}));
if(results.some(c=>!c.result))throw new Error('还有功能未实际运行，不能生成完整探测记录');
const count={};for(const {result:r} of results)count[r.functional]=(count[r.functional]||0)+1;
const names={pass:'通过',partial:'部分验证',blocked:'阻塞',failed:'执行失败，需复核',interrupted:'中断'};
const clean=s=>String(s??'').replaceAll('|','／').replace(/\r?\n/g,' ');
let md=`# Windows 功能探测记录\n\n生成时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）\n\n控制台 v${VERSION}；MobileWork 2026.1.10-31 / Electron 35.7.5；Windows 10.0.19045。共 ${results.length} 项最近热态结果（包含历史单次）：${Object.entries(count).map(([k,v])=>`${names[k]} ${v}`).join('，')}。\n\n这些数字表示脚本覆盖断言，不等于原性能表整项验收通过。v0.0.3 起每项热态预热 1 轮、记录后 2 轮；此前记录仍为历史单次。冷启动单独归档，统信/麒麟测试未执行。\n\n|原表行|编号|模块 / 功能|结果|交互计时 ms|实际范围 / 阻塞原因|\n|---|---|---|---|---|---|\n`;
for(const c of results){const r=c.result;md+=`|${c.row}|${c.id}|${clean(c.module+' / '+c.name)}|${names[r.functional]}|${r.measurements?.map(m=>(m.iteration?'第'+m.iteration+'轮 ':'')+m.label+'：'+m.durationMs+(m.targetRelation==='supporting'?'（补充场景）':'')).join('；')||'未计时'}${r.statistics?.length?'；'+r.statistics.map(s=>s.label+' 均值：'+(s.meanMs??'样本不足')).join('；'):''}|${clean([r.reason,r.originalScenario?'原场景受限：'+r.originalScenario.reason:null,...(r.assertions||[]),...(r.limitations||[])].filter(Boolean).join('；'))}|\n`;}
md+='\n## 冷启动独立记录\n\n';
md+='当前按已确认的加载展示/当前交互完成口径复核；明确空态算完成。原场景缺失及未完成操作仍保留，原始 runs 记录不改写。应用启动与本批后续操作分别计时。\n\n';
md+=Object.values(coldLatest).length?Object.values(coldLatest).map(r=>`- ${r.id}：${names[r.functional]}${r.sourceFunctional==='partial'&&r.functional==='pass'?'（按加载展示口径复核；原部分验证记录保留）':''}；${r.coldStart?'本项应用启动 '+r.coldStart.durationMs+' ms':r.batchStartup?'共享应用启动 '+r.batchStartup.durationMs+' ms，来源 '+r.batchStartup.caseId:'未取得启动计时'}；用例操作：${r.measurements?.map(m=>clean(m.label)+' '+m.durationMs+' ms'+(m.targetRelation==='supporting'?'（补充操作）':'')).join('；')||'未取得用例计时'}；批次 runs/${r.runId}.json。`).join('\n'):'尚未执行真实冷启动；需要用户从托盘退出 MW 后点击冷启动确认。';
md+='\n## 计时与证据\n\n测量从渲染进程输入事件至指定 DOM 状态连续两帧稳定；不代表整页像素渲染完成。执行总耗时不能当作响应时间。没有热态阈值的项目不套用冷态阈值。标记 supporting 的样本属于补充场景，不与原场景阈值比较；功能结果中的部分验证不能解释为整项业务验收通过。\n\n每项完整证据保存在 `data/latest-results.json`，包含来源行、批次、断言、限制、时间和状态恢复记录；历史原始批次仍在 `runs/`，首轮适配失败不会被删除。\n\n';
md+=`本快照涉及批次：\n\n${[...new Set(results.map(x=>x.result.runId))].map(id=>'- `runs/'+id+'.json`').join('\n')}\n`;
await fs.writeFile(path.join(root,'探测结果.md'),md);await fs.writeFile(path.join(root,'data/latest-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),count,results,coldResults:coldLatest},null,2));
console.log(JSON.stringify(count));
