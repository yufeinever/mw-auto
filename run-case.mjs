import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { attach, dismiss, stage } from './lib/runtime.mjs';
import { captureView, restoreView } from './lib/state.mjs';
import { runColdStartup } from './lib/cold-start.mjs';
import { assessResult } from './lib/assessment.mjs';
import { viewFingerprint } from './lib/handoff.mjs';
import { reportProgress } from './lib/worker.mjs';
import { startResponseObserver } from './lib/response-observer.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const catalog=JSON.parse(await fs.readFile(path.join(root,'data/cases.json'),'utf8'));
const spec=catalog.find(x=>x.id===process.argv[2]);
if(!spec)throw new Error('Unknown allowlisted case');
const result={id:spec.id,row:spec.row,name:spec.name,module:spec.module,startedAt:new Date().toISOString(),platform:process.platform,os:os.release(),functional:'blocked',testability:'blocked',assertions:[],limitations:[],measurements:[],restored:false,performance:{status:'not_measured',cold:'not_measured',note:'Windows 当前进程探测；非统信/麒麟验收。总执行耗时不是页面响应时间。'}};
result.script=spec.script;
if(spec.currentMapping)result.currentMapping=spec.currentMapping;
result.consoleVersion=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
result.scriptSha256=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).update(await fs.readFile(path.join(root,'lib/assessment.mjs'))).update(await fs.readFile(path.join(root,'lib/actions.mjs'))).update(await fs.readFile(path.join(root,'lib/retry-actions.mjs'))).update(await fs.readFile(path.join(root,'lib/case-gallery.mjs'))).update(await fs.readFile(path.join(root,'lib/skill-readiness.mjs'))).update(await fs.readFile(path.join(root,'lib/runtime.mjs'))).update(await fs.readFile(path.join(root,'lib/cold-start.mjs'))).update(await fs.readFile(path.join(root,spec.script))).digest('hex');
try {const build=JSON.parse(await fs.readFile(path.join(os.homedir(),'AppData/Local/Programs/MobileWork/resources/build-info.json'),'utf8'));result.installedBuild={version:build.version,productVersion:build.productVersion,gitSha:build.gitSha};}catch{}
let browser,page,originalView,lock,ctx,observer;
const cleanups=[];
const launchCold=process.argv.includes('--cold'),manualRestart=process.argv.includes('--manual-restart'),isCold=launchCold||manualRestart||process.argv.includes('--after-cold-start');result.mode=isCold?'cold':'warm';
const lockPath=path.join(root,'data/client.lock');
try {
  try {lock=await fs.open(lockPath,'wx');await lock.writeFile(String(process.pid));}
  catch(e){if(e.code==='EEXIST'){let alive=true;try{process.kill(Number(await fs.readFile(lockPath,'utf8')),0);}catch{alive=false;}if(!alive){await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx');await lock.writeFile(String(process.pid));}else throw Object.assign(new Error('另一个脚本正在控制 MobileWork，请等候完成'),{name:'Blocked'});}else throw e;}
  observer=await startResponseObserver({maxRequests:600,maxEvents:300,onSnapshot:observation=>reportProgress({observation})});
  if(launchCold||manualRestart){reportProgress({stage:manualRestart?'等待手动重启后的首页就绪':'启动 MW 并等待首页就绪'});result.coldStart=await runColdStartup({alreadyRestarted:manualRestart,onConnected:p=>observer.attach(p),onDisconnect:()=>observer.flush()});result.performance.cold=manualRestart?'user_confirmed_restart':'startup_measured';result.limitations.push(result.coldStart.scope,'冷态启动耗时与启动后用例操作耗时分开记录；脚本准备可能预热目标模块，后者不代表原表目标操作的严格冷加载');}
  else if(isCold){result.performance.cold='shared_batch_startup';result.limitations.push('复用本批冷启动后的同一 MW 进程；本项没有重新启动，操作耗时不代表独立冷加载。应用启动证据见 batchStartupRef。');}
  ({browser,page}=await attach());await observer.attach(page);await observer.setPhase('execution');originalView=await captureView(page);
  result.checkpoint={fingerprint:viewFingerprint(originalView),cleanupComplete:false};
  reportProgress({checkpoint:result.checkpoint});
  ctx={page,assertions:result.assertions,limitations:result.limitations,measurements:result.measurements,diagnostics:[],coverage:'partial',evaluation:'render',renderOnly:false,defer:fn=>cleanups.push(fn),log:()=>{}};
  stage(ctx,'准备用例');
  const {default:run}=await import(`./cases/${spec.id}.mjs`);
  await run(ctx);
  if(ctx.originalScenario)result.originalScenario=ctx.originalScenario;
  result.functional=ctx.coverage==='verified'?'pass':'partial';result.testability=ctx.coverage==='verified'?'automatable':'partial';
} catch(e) {
  if(e.coldDiagnostic)result.coldDiagnostic=e.coldDiagnostic;
  result.functional=e.name==='Blocked'?'blocked':'failed';result.testability=e.name==='Blocked'?'blocked':'needs_review';
  result.failure={kind:e.failureKind||(e.name==='Blocked'?'precondition':'automation'),stage:ctx?.stage||'连接客户端',errorType:e.name||'Error'};
  // Locator errors can contain private page text. Persist only the concise first line.
  result.reason=(ctx?.stage?ctx.stage+'：':'')+String(e.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]').slice(0,250);
} finally {
  if(observer)await observer.setPhase('cleanup');
  if(page){
    const issues=[];
    reportProgress({stage:'清理本轮修改与恢复原页面'});
    await page.evaluate(()=>window.__mwLocalMeasurement?.cancel?.()).catch(()=>{});
    for(const cleanup of cleanups.reverse()){try{await cleanup();}catch(e){issues.push((ctx?.stage||'原交互状态恢复')+'失败：'+String(e.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]').slice(0,160));}}
    if(result.checkpoint){result.checkpoint.cleanupComplete=issues.length===0;reportProgress({checkpoint:result.checkpoint});}
    try {await restoreView(page,originalView);result.restored=issues.length===0;result.recovery={policy:'view-and-draft-v1',verified:result.restored};}catch{issues.push('原页面、搜索条件或草稿恢复核验失败');}
    if(issues.length){result.cleanupIssues=issues;result.testability='needs_review';result.recoveryFailure={kind:'recovery',stage:'清理与恢复核验'};result.reason??=issues[0];result.restored=false;}
  }
  if(observer)result.observation=await observer.stop();
  if(browser)await browser.close().catch(()=>{});
  if(lock){await lock.close();await fs.unlink(lockPath).catch(()=>{});}
}
result.diagnostics=ctx?.diagnostics||[];
// Include helpers in the evidence fingerprint without storing runtime state.
result.scriptSha256=createHash('sha256').update(result.scriptSha256).update(await fs.readFile(path.join(root,'lib/state.mjs'))).update(await fs.readFile(path.join(root,'lib/market.mjs'))).update(await fs.readFile(path.join(root,'lib/handoff.mjs'))).update(await fs.readFile(path.join(root,'lib/worker.mjs'))).digest('hex');
if(result.measurements.length){const comparable=result.measurements.filter(x=>x.targetRelation!=='supporting');result.performance.status='windows_reference';result.performance.hotThresholdMs=spec.hotSeconds===null?null:spec.hotSeconds*1000;result.performance.comparison=!comparable.length?'supporting_only':spec.hotSeconds===null?'no_hot_target':comparable.every(x=>x.durationMs<=spec.hotSeconds*1000)?'within_reference':'exceeds_reference';}
if(isCold){result.performance.comparison='after_cold_start_reference';for(const sample of result.measurements)sample.temperature='after_cold_start';}
result.endedAt=new Date().toISOString();result.totalExecutionMs=Date.parse(result.endedAt)-Date.parse(result.startedAt);
result.scriptSha256=createHash('sha256').update(result.scriptSha256).update(await fs.readFile(path.join(root,'lib/skill-selection.mjs'))).update(await fs.readFile(path.join(root,'lib/response-observer.mjs'))).digest('hex');
console.log(JSON.stringify(assessResult(result)));
if(process.connected)process.disconnect();
