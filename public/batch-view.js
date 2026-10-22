export const modeLabel=mode=>mode==='combined'?'冷启动 → 热启动':mode==='cold'?'冷启动':'热启动';
export function executionPlan(run){
  return run.plan||run.selected.map(id=>({id,mode:run.mode==='cold'?'cold':'warm'}));
}
export const resultMode=(run,result)=>result.mode||(run.mode==='cold'?'cold':'warm');
export const displayStatus=result=>result&&['pass','partial'].includes(result.functional)&&(result.restored===false||result.cleanupIssues?.length)?'recovery_failed':result?.functional;
export const resultsFor=(run,mode)=>Object.fromEntries((run?.results||[]).filter(r=>resultMode(run,r)===mode).map(r=>[r.id,r]));
export function visibleResults(state,run,mode,history=false){
  if(history)return resultsFor(run,mode);
  const values={...(mode==='cold'?state.latestColdResults:state.latestResults)};
  if(run)for(const step of executionPlan(run))if(step.mode===mode)delete values[step.id];
  return {...values,...resultsFor(run,mode)};
}
export function casePhase(run,id,mode,fallback){
  if(!run||!executionPlan(run).some(s=>s.id===id&&s.mode===mode))return {result:fallback,status:displayStatus(fallback),startedAt:fallback?.startedAt,endedAt:fallback?.endedAt};
  const result=resultsFor(run,mode)[id],active=run.current===id&&(run.currentMode||run.mode)===mode;
  const waitingRecovery=displayStatus(result)==='recovery_failed';
  return {result,status:active?'running':result?displayStatus(result):['stopped','interrupted'].includes(run.status)?'cancelled':'queued',
    waitingRecovery,startedAt:result?.startedAt||(active?run.currentStartedAt:null),endedAt:result?.endedAt};
}
