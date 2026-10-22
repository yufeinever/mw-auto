import { spawn } from 'node:child_process';

export function reportProgress(value) {
  if(process.connected)process.send({type:'progress',...value},()=>{});
}

// Resolve only on close: a timed-out worker must exit before the next one starts.
export function executeWorker({file,args=[],cwd,timeoutMs,onProgress=()=>{}}) {
  return new Promise(resolve=>{
    const proc=spawn(process.execPath,[file,...args],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    let out='',timedOut=false,startError=false,checkpoint,stage='启动执行进程';
    const diagnostics=[];
    const timer=setTimeout(()=>{timedOut=true;proc.kill();},timeoutMs);
    proc.on('message',message=>{
      if(message?.type!=='progress')return;
      if(typeof message.stage==='string'){
        stage=message.stage.slice(0,160);diagnostics.push({stage,at:new Date().toISOString()});
      }
      if(message.checkpoint)checkpoint={...message.checkpoint,workerPid:proc.pid};
      onProgress({stage,checkpoint,diagnostics:diagnostics.slice(-100)});
    });
    proc.stdout.on('data',b=>{if(out.length<500000)out+=b;});
    proc.stderr.on('data',()=>{});
    proc.on('error',()=>{startError=true;});
    proc.on('close',()=>{
      clearTimeout(timer);
      let result;
      if(!timedOut){try{result=JSON.parse(out.trim().split('\n').at(-1));}catch{}}
      if(!result||typeof result.functional!=='string')result={functional:startError?'blocked':'interrupted',restored:false,
        testability:'needs_review',reason:timedOut?`脚本超过 ${timeoutMs/1000} 秒，已确认执行进程退出；最后阶段：${stage}`:'脚本未产生有效结果，已确认执行进程退出',
        failure:{kind:'automation',stage},diagnostics,assertions:[],measurements:[]};
      const finalCheckpoint=result.checkpoint||checkpoint;
      resolve({...result,checkpoint:finalCheckpoint?{...finalCheckpoint,workerPid:proc.pid}:undefined,workerExited:true});
    });
  });
}
