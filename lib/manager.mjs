import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { VERSION } from './version.mjs';
import { COLD_ID, runningMobileWork } from './cold-start.mjs';

export function aggregateWarm(id, attempts) {
  const bad=attempts.find(r=>!['pass','partial'].includes(r.functional)||r.cleanupIssues?.length);
  const last=bad||attempts.at(-1);
  const measurements=attempts.slice(1).flatMap((r,i)=>(r.measurements||[]).map(m=>({...m,iteration:i+2,temperature:'hot'})));
  const statistics=[...new Set(measurements.map(m=>m.label))].map(label=>{
    const values=measurements.filter(m=>m.label===label).map(m=>m.durationMs);
    return {label,sampleCount:values.length,valuesMs:values,meanMs:values.length===2?+(values.reduce((a,b)=>a+b,0)/2).toFixed(2):null};
  });
  const comparable=measurements.filter(m=>m.targetRelation!=='supporting');
  const performance={...last.performance,status:measurements.length?'windows_reference':'not_measured',cold:'not_measured',comparison:!measurements.length?'not_measured':!comparable.length?'supporting_only':last.performance?.hotThresholdMs==null?'no_hot_target':comparable.every(m=>m.durationMs<=last.performance.hotThresholdMs)?'within_reference':'exceeds_reference'};
  return {...last,id,mode:'warm',startedAt:attempts[0].startedAt||last.startedAt,
    functional:bad?bad.functional:attempts.length<3||attempts.some(r=>r.functional==='partial')?'partial':'pass',
    limitations:[...new Set(attempts.flatMap(r=>r.limitations||[])),...(attempts.length<3?['未完成预热加两轮计时，不能给出完整热态统计']:[])],
    restored:attempts.every(r=>r.restored!==false),measurements,statistics,performance,
    repetition:{planned:3,completed:attempts.length,warmupDiscarded:true,recordedIterations:attempts.slice(1).map((_,i)=>i+2)},
    warmup:{functional:attempts[0].functional,restored:attempts[0].restored,reason:attempts[0].reason},
    repeats:attempts.slice(1).map((r,i)=>({iteration:i+2,functional:r.functional,restored:r.restored,reason:r.reason,measurements:r.measurements||[]}))};
}

export class Manager {
  constructor(root,catalog,options={}) {this.root=root;this.catalog=catalog;this.active=null;this.preparingCold=false;this.spawnCase=options.spawnCase||this.worker.bind(this);this.listProcesses=options.listProcesses||runningMobileWork;this.warmRepetitions=options.warmRepetitions||3;}
  async init(){await fs.mkdir(path.join(this.root,'runs'),{recursive:true});for(const file of await fs.readdir(path.join(this.root,'runs'))){if(!file.endsWith('.json'))continue;try{const run=JSON.parse(await fs.readFile(path.join(this.root,'runs',file),'utf8'));if(['running','paused','stopping','waiting_for_cold'].includes(run.status)){run.status='interrupted';run.endedAt=new Date().toISOString();run.logs.push({time:run.endedAt,text:'服务重启：上次未完成运行标为 interrupted，未推断通过'});await this.save(run);}}catch{}}}
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
  async start(ids){if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');if(!Array.isArray(ids)||!ids.length||ids.length>44||ids.some(id=>!this.catalog.some(c=>c.id===id)))throw new Error('请选择清单中的脚本');return this.begin(ids,'warm');}
  async startCold(confirmed,ids=[COLD_ID]){
    if(confirmed!==true)throw new Error('请先阅读托盘退出提示，再点击“已退出，开始冷启动”');
    if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');
    if(!Array.isArray(ids)||!ids.length||ids.length>this.catalog.length||ids.some(id=>!this.catalog.some(c=>c.id===id))&&!(ids.length===1&&ids[0]===COLD_ID))throw new Error('请选择清单中的冷启动用例；首页启动测试需单独执行');
    this.preparingCold=true;
    try {
      if((await this.listProcesses()).length)throw new Error('MobileWork 仍在运行。请从系统托盘右键选择“退出”，不要手动重新打开，然后再次点击冷启动。');
      return await this.begin(ids,'cold');
    } finally {this.preparingCold=false;}
  }
  async resumeColdBatch(runId){
    if(this.active||this.preparingCold)throw new Error('已有运行占用客户端');
    this.preparingCold=true;
    try{
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
  async begin(ids,mode){const run={id:Date.now()+'-'+randomUUID(),version:VERSION,mode,coldPolicy:mode==='cold'?'once_per_batch':undefined,repetitions:mode==='warm'?this.warmRepetitions:1,startedAt:new Date().toISOString(),status:'running',selected:[...new Set(ids)],results:[],logs:[],current:null,coldReadyId:mode==='cold'?ids[0]:null,pendingColdId:null};this.active=run;try{await this.save(run);}catch(e){this.active=null;throw e;}void this.pump(run);return run;}
  async log(run,text){run.logs.push({time:new Date().toISOString(),text});await this.save(run);}
  async pump(run) {
    try {
      for(const id of run.selected) {
        if(run.results.some(r=>r.id===id))continue;
        if(run.stopRequested)break;
        if(run.pauseRequested){run.status='paused';await this.log(run,'已暂停；不会执行下一项');return;}
        const workerMode=run.mode==='cold'?(run.results.length?'after-cold-start':'cold'):'warm';
        if(workerMode==='after-cold-start'){
          const processes=await this.listProcesses();
          if(!run.coldStart||!run.coldProcessIds?.some(pid=>processes.includes(pid))){
            run.status='stopped';run.current=null;run.endedAt=new Date().toISOString();
            await this.log(run,'批次启动证据缺失或原 MW 进程已退出；停止后续用例，请创建新批次，不自动重启。');this.active=null;return;
          }
        }
        if(run.mode==='cold'){run.coldReadyId=null;run.pendingColdId=null;}
        run.current=id;run.status='running';await this.log(run,`开始 ${id}`);
        const attempts=[];
        for(let iteration=1;iteration<=(run.repetitions||1);iteration++){
          await this.log(run,run.mode==='cold'?(workerMode==='cold'?'本批唯一一次启动 MW，再执行用例':'复用本批已启动的 MW，直接执行；本项不重新启动'):`${id} 第 ${iteration}/${run.repetitions||1} 轮${iteration===1&&run.repetitions===3?'（预热，不计入结果耗时）':''}`);
          const attempt=await this.spawnCase(id,workerMode);attempts.push(attempt);
          if(!['pass','partial'].includes(attempt.functional)||attempt.cleanupIssues?.length||attempt.restored===false||run.stopRequested)break;
        }
        const result=run.mode!=='cold'&&run.repetitions===3?aggregateWarm(id,attempts):attempts.at(-1);
        if(run.mode==='cold'){
          if(workerMode==='cold'){
            run.coldStart=result.coldStart;run.coldStartCaseId=id;run.coldProcessIds=await this.listProcesses();
            if(!run.coldStart||!run.coldProcessIds.length){run.stopRequested=true;await this.log(run,'未取得有效应用启动证据，停止后续用例；不将当前进程操作记为冷启动。');}
          }
          result.mode='cold';result.coldPolicy='once_per_batch';result.startupPerformed=workerMode==='cold';
          result.batchStartupRef={runId:run.id,caseId:run.coldStartCaseId};
        }
        run.results.push(result);
        await this.log(run,`${id}：${result.functional}${result.reason?'；'+result.reason:''}`);run.current=null;
        if(result.cleanupIssues?.length||result.restored===false||result.functional==='interrupted'){
          run.stopRequested=true;await this.log(run,'恢复异常或脚本中断，已停止后续脚本，请检查客户端');
        }
      }
      run.status=run.stopRequested?'stopped':'completed';run.endedAt=new Date().toISOString();
      await this.log(run,run.stopRequested?'已停止后续脚本':'本批次执行完成');this.active=null;
    } catch {
      run.status='interrupted';run.endedAt=new Date().toISOString();
      await this.log(run,'执行器异常中断；请查看已有结果并检查客户端');this.active=null;
    }
  }
  async control(action){const r=this.active;if(!r)throw new Error('当前没有运行');if(action==='stop'){r.stopRequested=true;if(['paused','waiting_for_cold'].includes(r.status)){r.status='stopped';r.pendingColdId=null;r.coldReadyId=null;r.endedAt=new Date().toISOString();await this.log(r,'批次已停止；不会启动后续用例');this.active=null;}else{r.status='stopping';await this.log(r,'停止请求已记录：当前脚本完成清理后停止');}}else if(action==='pause'){if(r.status==='waiting_for_cold')throw new Error('当前已等待托盘退出确认，无需暂停');r.pauseRequested=true;await this.log(r,'暂停请求已记录：当前脚本结束后暂停');}else if(action==='resume'){if(r.status!=='paused')throw new Error('当前未暂停');r.pauseRequested=false;r.status='running';await this.save(r);void this.pump(r);}else throw new Error('未知控制操作');return r;}
  worker(id,mode='warm'){return new Promise(resolve=>{const proc=spawn(process.execPath,[path.join(this.root,id===COLD_ID?'run-cold-start.mjs':'run-case.mjs'),id,...(mode==='cold'?['--cold']:mode==='after-cold-start'?['--after-cold-start']:[])],{cwd:this.root,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',settled=false;const finish=r=>{if(settled)return;settled=true;clearTimeout(timer);resolve(r);};const timeoutMs=(['MW-UI-031','MW-UI-036','MW-UI-043'].includes(id)?180000:90000)+(mode==='cold'?70000:0);const timer=setTimeout(()=>{proc.kill();finish({id,functional:'interrupted',testability:'needs_review',reason:'脚本超过'+(timeoutMs/1000)+'秒，执行器已结束该进程；请检查原状态是否恢复',restored:false,assertions:[],measurements:[]});},timeoutMs);proc.stdout.on('data',b=>{if(out.length<500000)out+=b;});proc.stderr.on('data',()=>{});proc.on('error',()=>finish({id,functional:'blocked',reason:'无法启动本地 Node 执行进程'}));proc.on('close',()=>{try{finish(JSON.parse(out.trim().split('\n').at(-1)));}catch{finish({id,functional:'interrupted',reason:'脚本未产生有效结果，请检查 Node 运行时',restored:false});}});});}
}
