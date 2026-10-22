import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Manager } from './lib/manager.mjs';
import { VERSION } from './lib/version.mjs';
import { assessRun } from './lib/assessment.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function createConsole({port=17866,projectRoot=root,managerOptions={}}={}) {
  const catalog=JSON.parse(await fs.readFile(path.join(projectRoot,'data/cases.json'),'utf8'));
  const manager=new Manager(projectRoot,catalog,managerOptions);await manager.init();
  const csrf=randomBytes(24).toString('hex');
  const server=http.createServer(async(req,res)=>{
    const actualPort=server.address().port;const host=`127.0.0.1:${actualPort}`,origin=`http://${host}`;
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
    const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
    if(req.headers.host!==host)return send(403,{error:'仅允许本机 127.0.0.1 访问'});
    if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'不允许跨站调用'});
    const url=new URL(req.url,origin);
    try {
      if(req.method==='GET') {
        if(url.pathname==='/api/state'){const runs=(await manager.list()).map(assessRun);const latestResults={},latestColdResults={};for(const r of runs)for(const item of r.results){const target=r.mode==='cold'?latestColdResults:latestResults;target[item.id]??={...item,runId:r.id};}return send(200,{version:VERSION,csrf,catalog,latestResults,latestColdResults,latestCold:runs.find(r=>r.mode==='cold')||null,active:assessRun(manager.active),runs:runs.map(r=>({id:r.id,mode:r.mode||'warm',startedAt:r.startedAt,endedAt:r.endedAt,status:r.status,count:r.results.length,total:r.selected.length})),latest:runs[0]||null});}
        if(url.pathname==='/api/cold-readiness'){const processes=await manager.listProcesses();return send(200,{runningCount:processes.length,canStart:!processes.length&&!manager.active&&!manager.preparingCold});}
        if(url.pathname==='/api/readiness') {
          let ready=false;try{const r=await fetch('http://127.0.0.1:9223/json/list',{signal:AbortSignal.timeout(3000)});const list=await r.json();ready=list.some(t=>t.type==='page'&&t.webSocketDebuggerUrl&&/MobileWork\/resources\/app-dist\/index\.html/i.test(t.url));}catch{}
          return send(200,{ready,endpoint:'127.0.0.1:9223',note:ready?'MobileWork 主窗口 target 已发现；实际脚本还会验证 UI':'未找到主窗口，请启动 MobileWork 并开启 CDP'});
        }
        if(url.pathname.startsWith('/api/runs/')){try{const run=await manager.read(url.pathname.slice(10));return send(200,url.searchParams.get('raw')==='1'?run:assessRun(run));}catch{return send(404,{error:'记录不存在'});}}
        const files={'/':'index.html','/app.js':'app.js','/metric-view.js':'metric-view.js','/style.css':'style.css'};const f=files[url.pathname];if(!f)return send(404,{error:'Not found'});
        return send(200,await fs.readFile(path.join(projectRoot,'public',f)),f.endsWith('.html')?'text/html; charset=utf-8':f.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
      }
      if(req.method!=='POST')return send(405,{error:'不支持的方法'});
      const supplied=String(req.headers['x-mw-csrf']||'');if(supplied.length!==csrf.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(csrf)))return send(403,{error:'缺少本机会话校验'});
      let text='';for await(const b of req){text+=b;if(text.length>8192)return send(413,{error:'请求过大'});}
      let body;try{body=JSON.parse(text||'{}');}catch{return send(400,{error:'JSON 格式错误'});}
      if(url.pathname==='/api/run')return send(202,await manager.start(body.ids));
      if(url.pathname==='/api/cold-start')return send(202,await manager.startCold(body.confirmed,body.ids));
      if(url.pathname==='/api/cold-resume')return send(202,await manager.resumeColdBatch(body.runId));
      if(url.pathname==='/api/control')return send(200,await manager.control(body.action));
      return send(404,{error:'Not found'});
    } catch(e){return send(409,{error:String(e.message).slice(0,200)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,manager,port:server.address().port};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createConsole();console.log(`MobileWork 本地控制台 v${VERSION} http://127.0.0.1:${app.port}`);
}
