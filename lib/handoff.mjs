import { createHash } from 'node:crypto';
import { attach } from './runtime.mjs';
import { captureView } from './state.mjs';

// Original text stays in the worker. The coordinator stores only its digest.
export const viewFingerprint = view => createHash('sha256').update(JSON.stringify(view)).digest('hex');
export async function inspectHandoff(checkpoint, connect=attach) {
  if(checkpoint?.workerPid){
    try{process.kill(checkpoint.workerPid,0);return {ready:false,reason:'原执行进程仍存在；等待它退出后再核验交接'};}
    catch(e){if(e.code!=='ESRCH')return {ready:false,reason:'无法确认原执行进程已退出，继续等待'};}
  }
  if(!checkpoint?.cleanupComplete||!checkpoint?.fingerprint)
    return {ready:false,reason:'脚本未证明专属清理全部完成；保留队列，需要检查原用例的恢复状态'};
  let browser;
  try {
    const connection=await connect();browser=connection.browser;const p=connection.page;
    const overlays=await p.locator('[role="menu"],[role="dialog"],[data-slot="popover-content"]').filter({visible:true}).count();
    if(overlays)return {ready:false,reason:'客户端仍有弹层；只读复查不会关闭未知弹层'};
    if(viewFingerprint(await captureView(p))!==checkpoint.fingerprint)
      return {ready:false,reason:'原页面、筛选或草稿尚未恢复；只读复查不会覆盖用户输入'};
    return {ready:true,reason:'专属清理已完成，原页面、筛选、草稿及弹层只读核验通过'};
  } catch {return {ready:false,reason:'暂时无法核验唯一客户端主窗口，继续等待恢复'};}
  finally {await browser?.close().catch(()=>{});}
}
