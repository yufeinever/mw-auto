import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION } from './version.mjs';
import { COLD_ID, runningMobileWork } from './cold-start.mjs';
import { executeWorker } from './worker.mjs';
import { executionPlan } from '../public/batch-view.js';

export function aggregateWarm(id, attempts, planned=2) {
  const bad=attempts.find(r=>!['pass','partial'].includes(r.functional)||r.cleanupIssues?.length||r.restored===false);
  const last=bad||attempts.at(-1);
  const measurements=attempts.slice(1).flatMap((r,i)=>(r.measurements||[]).map(m=>({...m,iteration:i+2,temperature:'hot'})));
  const statistics=[...new Set(measurements.map(m=>m.label))].map(label=>{
    const values=measurements.filter(m=>m.label===label).map(m=>m.durationMs);
    return {label,sampleCount:values.length,valuesMs:values,...(planned===2?{durationMs:values.length===1?values[0]:null}:{meanMs:values.length===planned-1?+(values.reduce((a,b)=>a+b,0)/values.length).toFixed(2):null})};
  });
  const comparable=measurements.filter(m=>m.targetRelation!=='supporting');
  const performance={...last.performance,status:measurements.length?'windows_reference':'not_measured',cold:'not_measured',comparison:!measurements.length?'not_measured':!comparable.length?'supporting_only':last.performance?.hotThresholdMs==null?'no_hot_target':comparable.every(m=>m.durationMs<=last.performance.hotThresholdMs)?'within_reference':'exceeds_reference'};
  return {...last,id,mode:'warm',startedAt:attempts[0].startedAt||last.startedAt,
    functional:bad&&!['pass','partial'].includes(bad.functional)?bad.functional:attempts.length<planned?'partial':last.functional,
    limitations:[...(last.limitations||[]),...(attempts.length<planned?['未完成预热及正式执行，尚无完整热态结果']:[])],
    restored:attempts.every(r=>r.restored!==false),measurements,statistics,performance,
    repetition:{planned,completed:attempts.length,warmupDiscarded:true,recordedIterations:attempts.slice(1).map((_,i)=>i+2)},
    warmup:{functional:attempts[0].functional,restored:attempts[0].restored,reason:attempts[0].reason,failure:attempts[0].failure,diagnostics:attempts[0].diagnostics,recovery:attempts[0].recovery},
    repeats:attempts.slice(1).map((r,i)=>({iteration:i+2,functional:r.functional,restored:r.restored,reason:r.reason,measurements:r.measurements||[]}))};
}

export class Manager {
  constructor(root,catalog,options={}) {this.root=root;this.catalog=catalog;this.active=null;this.preparingCold=false;this.spawnCase=options.spawnCase||this.worker.bind(this);this.listProcesses=options.listProcesses||runningMobileWork;this.warmRepetitions=options.warmRepetitions||2;}
  async init(){await fs.mkdir(path.join(this.root,'runs'),{recursive:true});for(const file of await fs.readdir(path.join(this.root,'runs'))){if(!file.endsWith('.json'))continue;try{const run=JSON.parse(await fs.readFile(path.join(this.root,'runs',file),'utf8'));if(run.status==='waiting_recovery'){
    run.pauseRequested=true;run.status='paused';run.schedulingHold=false;this.active=run;await this.log(run,'升级执行策略：恢复异常仅记录；保留未执行队列，点击继续后按序执行');
  }else if(['running','paused','stopping','waiting_for_cold'].includes(run.status)){
    if(run.current){run.schedulingHold=true;run.handoff={ready:false,caseId:run.current,reason:'服务重启时脚本尚未交还客户端'};run.pendingCheckpoint=run.workerProgress?.caseId===run.current?run.workerProgress.checkpoint:undefined;}
    run.status='interrupted';run.endedAt=new Date().toISOString();run.logs.push({time:run.endedAt,text:'服务重启：上次未完成运行标为 interrupted，未推断通过'});await this.save(run);}}catch{}}}
  async save(run){
    const file=path.join(this.root,'runs',run.id+'.json'),snapshot=JSON.stringify(run,null,2);
    this.writes=(this.writes||Promise.resolve()).catch(()=>{}).then(async()=>{
      await fs.writeFile(file+'.tmp',snapshot);
      // Windows can briefly hold the old file open while the UI polls results.
      // Keep the atomic replacement and retry only transient sharing failures.
      for(let attempt=0;;attempt++){
        try{await fs.rename(file+'.tmp',file);break;}
        catch(e){if(attempt>=7||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,10*(attempt+1)));}
      }
    });return this.writes;
  }
  async list(){const files=(await fs.readdir(path.join(this.root,'runs'))).filter(x=>x.endsWith('.json'));const runs=await Promise.all(files.map(async x=>{try{return JSON.parse(await fs.readFile(path.join(this.root,'runs',x),'utf8'));}catch{return null;}}));return runs.filter(Boolean).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));}
  async read(id){if(!/^[a-z0-9-]{10,80}$/.test(id))throw new Error('Invalid run ID');return JSON.parse(await fs.readFile(path.join(this.root,'runs',id+'.json'),'utf8'));}
  async checkUnresolved(){
    for(const run of (await this.list()).filter(r=>r.schedulingHold)){
      const checkpoint=run.current?run.pendingCheckpoint:run.results.at(-1)?.checkpoint;
      if(checkpoint?.workerPid){
        let alive=true;try{process.kill(checkpoint.workerPid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
        if(alive)throw new Error('原执行脚本尚未退出，请等待它结束；不会同时执行两个脚本');
      }
      // Retire only the scheduling hold. Historical results and restoration evidence stay intact.
      run.schedulingHold=false;run.holdRelease={at:new Date().toISOString(),policy:'record-issues-and-continue',reason:'用户要求单项异常仅记录，不阻止新批次'};
      await this.save(run);
    }
  }
  async start(ids){if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');if(!Array.isArray(ids)||!ids.length||ids.length>44||ids.some(id=>!this.catalog.some(c=>c.id===id)))throw new Error('请选择清单中的脚本');this.preparingCold=true;try{await this.checkUnresolved();return await this.begin(ids,'warm');}finally{this.preparingCold=false;}}
  async startCold(confirmed,ids=[COLD_ID]){
    if(confirmed!==true)throw new Error('请先阅读托盘退出提示，再点击“已退出，开始冷启动”');
    if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');
    if(!Array.isArray(ids)||!ids.length||ids.length>this.catalog.length||ids.some(id=>!this.catalog.some(c=>c.id===id))&&!(ids.length===1&&ids[0]===COLD_ID))throw new Error('请选择清单中的冷启动用例；首页启动测试需单独执行');
    this.preparingCold=true;
    try {
      await this.checkUnresolved();
      if((await this.listProcesses()).length)throw new Error('MobileWork 仍在运行。请从系统托盘右键选择“退出”，不要手动重新打开，然后再次点击冷启动。');
      return await this.begin(ids,'cold');
    } finally {this.preparingCold=false;}
  }
  async startCombined(ids,restart){
    if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');
    if(!Array.isArray(ids)||!ids.length||ids.length>this.catalog.length||ids.some(id=>!this.catalog.some(c=>c.id===id)))throw new Error('请选择清单中的脚本');
    if(!['manual','launch'].includes(restart))throw new Error('请先确认 MW 重启状态');
    this.preparingCold=true;
    try{
      await this.checkUnresolved();
      if(restart==='launch'&&(await this.listProcesses()).length)throw new Error('MW 仍在运行，请从托盘退出后再点执行；已自行重新打开时请选择“已在重启，直接执行”');
      return await this.begin(ids,'combined',{restart,plan:['cold','warm'].flatMap(mode=>[...new Set(ids)].map(id=>({id,mode}))),
        restartConfirmation:{source:restart==='manual'?'user_confirmed':'runner_launch',confirmedAt:new Date().toISOString()}});
    }finally{this.preparingCold=false;}
  }
  async resumeColdBatch(runId){
    if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');
    this.preparingCold=true;
    try{
      await this.checkUnresolved();
      const run=await this.read(runId),checkpoint=run.resumeCheckpoint;
      const previous=run.results?.at(-1);
      if(run.mode!=='cold'||!['stopped','interrupted'].includes(run.status)||run.current||!checkpoint?.processIds?.length||!previous?.coldStart||run.results.some(r=>r.restored!==true||r.cleanupIssues?.length)||run.selected.every(id=>run.results.some(r=>r.id===id)))throw new Error('没有可安全续跑的冷启动批次和进程检查点');
      if(run.selected.some(id=>!this.catalog.some(c=>c.id===id)))throw new Error('原批次包含不支持的脚本');
      const processes=await this.listProcesses();
      if(!checkpoint.processIds.some(id=>processes.includes(id)))throw new Error('原 MobileWork 进程已退出或改变，请创建新的冷启动批次');
      run.coldPolicy='once_per_batch';run.coldStart=previous.coldStart;run.coldStartCaseId=previous.id;run.coldProcessIds=checkpoint.processIds;
      run.resumeVersion=VERSION;run.stopRequested=false;run.pauseRequested=false;run.pendingColdId=null;run.coldReadyId=null;run.status='running';delete run.endedAt;
      run.resumedAt=new Date().toISOString();this.active=run;
      await this.log(run,`升级至 v${VERSION}：保留 ${run.results.length} 项历史结果，从未完成项继续；本批只重启一次，复用检查点中的 MW 进程。此前各项启动时间保留。`);
      void this.pump(run);return run;
    }finally{this.preparingCold=false;}
  }
  async begin(ids,mode,extra={}){const run={id:Date.now()+'-'+randomUUID(),version:VERSION,mode,coldPolicy:mode!=='warm'?'once_per_batch':undefined,repetitions:mode==='warm'?this.warmRepetitions:1,startedAt:new Date().toISOString(),status:'running',selected:[...new Set(ids)],results:[],logs:[],current:null,coldReadyId:mode==='cold'?ids[0]:null,pendingColdId:null,...extra};this.active=run;try{await this.save(run);}catch(e){this.active=null;throw e;}void this.pump(run);return run;}
  async log(run,text){run.logs.push({time:new Date().toISOString(),text});await this.save(run);}
  async pump(run) {
    try {
      for(const step of executionPlan(run)) {
        const {id,mode:phase}=step;
        if(run.results.some(r=>r.id===id&&(run.mode!=='combined'||r.mode===phase)))continue;
        if(run.stopRequested)break;
        if(run.pauseRequested){run.status='paused';await this.log(run,'已暂停；不会执行下一项');return;}
        const workerMode=phase==='cold'?(run.results.length?'after-cold-start':run.restart==='manual'?'manual-restart':'cold'):'warm';
        if(workerMode==='after-cold-start'||run.mode==='combined'&&phase==='warm'){
          const processes=await this.listProcesses();
          if(!run.coldStart||!run.coldProcessIds?.some(pid=>processes.includes(pid))){
            run.status='stopped';run.current=null;run.endedAt=new Date().toISOString();
            await this.log(run,'批次启动证据缺失或原 MW 进程已退出；停止后续用例，请创建新批次，不自动重启。');this.active=null;return;
          }
        }
        if(run.mode==='cold'){run.coldReadyId=null;run.pendingColdId=null;}
        run.current=id;run.currentMode=phase;run.currentStartedAt=new Date().toISOString();run.workerProgress=null;run.status='running';await this.log(run,`开始 ${id} · ${phase==='cold'?'第1轮冷启动':'热启动'}`);
        const attempts=[];
        for(let iteration=1;iteration<=(run.repetitions||1);iteration++){
          await this.log(run,run.mode==='combined'?(phase==='cold'?(workerMode==='manual-restart'?'用户确认正在/已经重启；等待首页就绪，记录第1轮冷启动结果':'第1轮冷启动执行，保留本轮结果'):'第2轮热启动执行，直接记录结果，不额外预热'):run.mode==='cold'?(workerMode==='cold'?'本批唯一一次启动 MW，再执行用例':'复用本批已启动的 MW，直接执行；本项不重新启动'):`${id} 第 ${iteration}/${run.repetitions||1} 轮${iteration===1&&run.repetitions>1?'（预热，不计入结果耗时）':run.repetitions===2?'（正式结果）':''}`);
          const attempt=await this.spawnCase(id,workerMode);attempts.push(attempt);
          if(!['pass','partial'].includes(attempt.functional)||attempt.cleanupIssues?.length||attempt.restored===false||run.stopRequested)break;
        }
        const result=run.mode!=='cold'&&run.repetitions>1?aggregateWarm(id,attempts,run.repetitions):attempts.at(-1);
        result.startedAt??=run.currentStartedAt;result.endedAt??=new Date().toISOString();
        if(run.mode==='combined'){result.mode=phase;result.round=phase==='cold'?1:2;result.sequence='cold-then-warm';}
        if(phase==='cold'){
          if(['cold','manual-restart'].includes(workerMode)){
            run.coldStart=result.coldStart;run.coldStartCaseId=id;run.coldProcessIds=await this.listProcesses();
            if(!run.coldStart||!run.coldProcessIds.length){run.stopRequested=true;await this.log(run,'未取得有效应用启动证据，停止后续用例；不将当前进程操作记为冷启动。');}
          }
          result.mode='cold';result.coldPolicy='once_per_batch';result.startupPerformed=workerMode==='cold';
          result.batchStartupRef={runId:run.id,caseId:run.coldStartCaseId};
        }
        run.results.push(result);
        run.current=null;run.currentStartedAt=null;await this.log(run,`${id} · ${phase==='cold'?'冷启动':'热启动'}：${result.functional}${result.reason?'；'+result.reason:''}`);
        if(result.restored!==true||result.cleanupIssues?.length){
          run.handoff={ready:false,caseId:id,reason:'恢复异常已记录，不阻止后续用例'};run.schedulingHold=false;
          await this.log(run,`${id} 恢复未确认：已保留异常${run.stopRequested?'；按手动停止请求结束批次':'；当前脚本已退出，继续下一条'}`);
        }else{
          run.handoff={ready:true,caseId:id,reason:'脚本完成清理与恢复核验'};run.schedulingHold=false;
        }
      }
      run.status=run.stopRequested?'stopped':'completed';run.endedAt=new Date().toISOString();
      await this.log(run,run.stopRequested?'已停止后续脚本':'本批次执行完成');this.active=null;
    } catch {
      if(run.current){run.schedulingHold=true;run.pendingCheckpoint=run.workerProgress?.caseId===run.current?run.workerProgress.checkpoint:undefined;run.handoff={ready:false,caseId:run.current,reason:'执行器异常，客户端交接未确认'};}
      run.status='interrupted';run.endedAt=new Date().toISOString();
      await this.log(run,'执行器异常中断；请查看已有结果并检查客户端');this.active=null;
    }
  }
  close(){}
  async control(action){
    const r=this.active;if(!r)throw new Error('当前没有运行');
    if(action==='recheck')throw new Error('恢复异常现仅记录，无需解除恢复锁');
    if(action==='stop'){
      r.stopRequested=true;
      if(['paused','waiting_for_cold','waiting_recovery'].includes(r.status)){
        this.close();r.status='stopped';r.pendingColdId=null;r.coldReadyId=null;r.endedAt=new Date().toISOString();
        await this.log(r,'批次已停止；不会启动后续用例，已有异常记录保留');this.active=null;
      }else{r.status='stopping';await this.log(r,'停止请求已记录：当前脚本完成清理后停止');}
    }else if(action==='pause'){
      r.pauseRequested=true;await this.log(r,'暂停请求已记录：当前脚本退出后暂停');
    }else if(action==='resume'){
      if(r.status!=='paused')throw new Error('当前未暂停');r.pauseRequested=false;r.status='running';await this.save(r);void this.pump(r);
    }else throw new Error('未知控制操作');return r;
  }
  async worker(id,mode='warm'){
    const run=this.active;
    const result=await executeWorker({file:path.join(this.root,id===COLD_ID?'run-cold-start.mjs':'run-case.mjs'),
      args:[id,...(mode==='cold'?['--cold']:mode==='manual-restart'?['--manual-restart']:mode==='after-cold-start'?['--after-cold-start']:[])],cwd:this.root,
      timeoutMs:(['MW-UI-031','MW-UI-036','MW-UI-043'].includes(id)?180000:90000)+(['cold','manual-restart'].includes(mode)?70000:0),
      onProgress:progress=>{if(run&&this.active===run){run.workerProgress={caseId:id,...progress};void this.save(run).catch(()=>{});}}
    });return {id,...result};
  }
}
