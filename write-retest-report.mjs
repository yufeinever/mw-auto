import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=async p=>JSON.parse((await fs.readFile(path.join(root,p),'utf8')).replace(/^\uFEFF/,''));
const plan=await read('data/retest-plan.json'),baseline=await read(plan.baseline),run=await read(`runs/${plan.runId}.json`);
if(run.status!=='completed'||run.results.length!==run.selected.length)throw new Error('统一复测尚未完成');
const followUps=[];
for(const id of plan.followUpRunIds||[]){const r=await read(`runs/${id}.json`);if(r.status!=='completed'||r.results.length!==r.selected.length)throw new Error('后续恢复核查尚未完成');followUps.push(r);}
const latest=new Map(run.results.map(r=>[r.id,r]));for(const batch of followUps)for(const r of batch.results)latest.set(r.id,r);
run.results=run.selected.map(id=>latest.get(id));
const before=Object.fromEntries(baseline.results.map(c=>[c.id,c.result]));
const counts={};for(const r of run.results)counts[r.functional]=(counts[r.functional]||0)+1;
const measured=run.results.filter(r=>r.measurements?.length).length;
const originalGaps=run.results.filter(r=>r.originalScenario);
const clean=s=>String(s??'').replaceAll('|','／').replace(/\r?\n/g,' ');
const names={pass:'通过',partial:'部分验证',blocked:'阻塞',failed:'执行失败',interrupted:'中断'};
let md=`# v${plan.version} 阻塞与未计时项目复测\n\n统一批次：\`runs/${run.id}.json\`\n\n${followUps.length?'后续恢复加固复测：'+followUps.map(r=>'`runs/'+r.id+'.json`').join('、')+'；相同用例以下采用该批次的更新结果。\n\n':''}本轮 ${run.results.length} 个唯一项目全部实际执行；${Object.entries(counts).map(([s,n])=>`${names[s]} ${n}`).join('，')}；${measured} 项有计时样本（包含补充场景）。状态恢复 ${run.results.filter(r=>r.restored).length}/${run.results.length}。\n\n原场景仍有版本入口差异 ${originalGaps.length} 项，以下保留原场景限制。补充场景计时不参与原表阈值比较；功能部分验证、首屏热态、全量数据加载、冷启动及目标操作系统验收分别记录。\n\n|编号|功能|原结果|复测结果|计时样本 ms|实际验证与剩余缺口|\n|---|---|---|---|---|---|\n`;
for(const r of run.results){md+=`|${r.id}|${clean(r.name)}|${names[before[r.id]?.functional]||'无结果'}|${names[r.functional]}|${r.measurements?.map(m=>clean(m.label)+'：'+m.durationMs+(m.targetRelation==='supporting'?'（补充）':'')).join('；')||'未计时'}|${clean([r.reason,...r.assertions,...r.limitations,r.originalScenario?.reason].filter(Boolean).join('；'))}|\n`;}
md+='\n## 证据与清理\n\n- 每项记录包含执行时间、脚本 SHA256、客户端版本、断言、计时起止口径、限制和恢复结果，完整证据见上述批次 JSON。\n- 首页“精选案例”若当前版本没有入口，继续标记阻塞。新任务空白页搜索/历史提问与案例按时间分支若无入口，保留 originalScenario 限制，不能用其他场景通过替代。\n- 专家召唤、技能安装和做同款通过产品 UI 操作。临时空间在清空草稿、退出专家绑定并切回原空间后删除注册；仅卸载本轮新增技能，不卸载既有个人技能。\n- 保留初轮选择器、状态恢复失败与后续修正记录，不删除历史失败。`restored` 表示脚本的清理步骤和原路由核查完成；最终现场另有客户端状态核查。\n- `探测结果-v0.0.1.md` 和 `data/baseline-v0.0.1.json` 保留前版快照。\n';
await fs.writeFile(path.join(root,'复测结果-v0.0.2.md'),md);
console.log(JSON.stringify({count:counts,measured,originalGaps:originalGaps.map(r=>r.id),restored:run.results.filter(r=>r.restored).length}));
