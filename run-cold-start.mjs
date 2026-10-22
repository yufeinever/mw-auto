import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runColdStartup, COLD_ID } from './lib/cold-start.mjs';
import { VERSION } from './lib/version.mjs';
import { reportProgress } from './lib/worker.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)), lockPath=path.join(root,'data/client.lock');
const result={id:COLD_ID,name:'应用冷启动 · 首页首屏',mode:'cold',consoleVersion:VERSION,startedAt:new Date().toISOString(),platform:process.platform,os:os.release(),functional:'blocked',testability:'blocked',assertions:[],limitations:['保留登录态、磁盘缓存和系统文件缓存；不是首次安装或清空全部缓存后的启动','只测首页首次展示的内容，不包含查看更多、逐条任务状态核对和后续模块交互','计时包含 CDP 连接及观察开销，不直接套用原表单个区域的阈值'],measurements:[],restored:false,performance:{status:'not_measured',cold:'not_measured',comparison:'not_compared'}};
let lock;
try {
  try { lock=await fs.open(lockPath,'wx'); }
  catch(e) {
    if(e.code!=='EEXIST')throw e;
    let alive=true;try{process.kill(Number(await fs.readFile(lockPath,'utf8')),0);}catch{alive=false;}
    if(alive)throw new Error('另一个脚本正在使用 MobileWork，请等候完成');
    await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx');
  }
  await lock.writeFile(String(process.pid));
  result.scriptSha256=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).update(await fs.readFile(path.join(root,'lib/cold-start.mjs'))).digest('hex');
  reportProgress({stage:'冷启动：等待应用首页首屏就绪'});
  const sample=await runColdStartup();
  result.coldStart=sample;
  result.launchAt=sample.launchAt;result.observations=sample.observations;
  result.measurements.push({label:'启动 MobileWork 至首页首屏加载完成',durationMs:sample.durationMs,method:sample.method,scope:sample.scope,targetRelation:'startup'});
  result.functional='pass';result.testability='automatable';result.restored=true;
  result.assertions.push('启动前已确认 MobileWork 进程全部退出；计时从启动命令前开始','首页标题、任务首屏、工作空间、可编辑输入区、字体及可视图片就绪，连续两次观察通过');
  result.performance={status:'windows_reference',cold:'measured',comparison:'startup_only',note:sample.scope};
} catch(e) {
  if(e.coldDiagnostic)result.coldDiagnostic=e.coldDiagnostic;
  result.reason=e.name==='Blocked'?e.message:'冷启动未完成：'+(e.message.includes('60 秒')?e.message:'请检查程序安装、CDP、登录状态及本机执行环境');
  result.functional=e.name==='Blocked'?'blocked':'failed';result.testability=e.name==='Blocked'?'blocked':'needs_review';
} finally {
  if(lock){await lock.close();await fs.unlink(lockPath).catch(()=>{});}
}
result.endedAt=new Date().toISOString();
console.log(JSON.stringify(result));
if(process.connected)process.disconnect();
