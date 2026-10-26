import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {attach} from '../lib/runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const startNew=process.argv[2]==='--start',ids=startNew?process.argv.slice(3):[];
let runId=startNew?null:process.argv[2];
if(startNew?(!ids.length||ids.some(id=>!/^MW-UI-\d{3}$/.test(id))):!(/^[a-z0-9-]{10,80}$/.test(runId||'')))throw Error('Supply run id or --start case IDs');
const dir=path.join(root,'data','interface-audit-20261026');await fs.mkdir(dir,{recursive:true});
let output=runId?path.join(dir,runId+'-ipc.json'):null;
const result={runId,startedAt:new Date().toISOString(),complete:false,method:'temporary non-pausing CDP logpoints; IPC invocation is not proof of remote HTTP completion; diagnostic instrumentation may affect timings',events:[],coverage:[],errors:[]};
let browser,session,run,writing=Promise.resolve();const breakpoints=[];
const persist=()=>{if(!output)return writing;const data=JSON.stringify(result,null,2);writing=writing.then(()=>fs.writeFile(output+'.tmp',data)).then(()=>fs.rename(output+'.tmp',output));return writing;};
try{
  ({browser}=await attach());const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('mobilework-shell://app/'));
  session=await page.context().newCDPSession(page);const scripts=[];
  session.on('Debugger.scriptParsed',s=>{if(/\/assets\/app-[^/]+\.js$/.test(s.url))scripts.push(s);});
  session.on('Debugger.paused',()=>{void session.send('Debugger.resume');});
  session.on('Runtime.consoleAPICalled',e=>{if(e.args[0]?.value!=='MW_INTERFACE_AUDIT_20261026'||e.timestamp<Date.parse(result.startedAt))return;try{const data=JSON.parse(e.args[1]?.value);result.events.push({at:new Date(e.timestamp).toISOString(),caseId:run?.current||null,stage:run?.workerProgress?.stage||null,...data});}catch{result.errors.push('invalid_marker');}});
  await session.send('Runtime.enable');await session.send('Debugger.enable');
  if(scripts.length!==1)throw Error('Expected one application bundle');
  const script=scripts[0],{scriptSource:source}=await session.send('Debugger.getScriptSource',{scriptId:script.scriptId});
  const safeRoute="new URL(e.path,'http://placeholder').pathname.split('/').map(s=>!s?'':['asset','assets','api','v1','admin','platform','detail','install-package','cases','static-resource','resources','out','manager','client','contact','mw2yunxi'].includes(s)?s:'[id]').join('/')";
  const points=[
    {needle:'async function Mye(e){',expression:`({kind:'assets:fetch',method:['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].includes(e.method)?e.method:'GET',route:${safeRoute},assetType:(()=>{const t=new URL(e.path,'http://placeholder').searchParams.get('assetType');return ['expert','group','skill','connector','case'].includes(t)?t:undefined})(),cacheRequested:!!e.cache})`},
    {needle:'const n=await tr(t,"assets:fetch",e);',expression:`({kind:'assets:result',method:e.method||'GET',route:${safeRoute},ok:n?.ok===true,status:Number.isInteger(n?.status)?n.status:null,errorCodes:[...new Set((typeof n?.error==='string'?n.error:'').match(/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|timeout/gi)||[])]})`},
    {needle:'async function psn(e,t){',expression:"({kind:'assets:fetchCasePackage',method:'GET',route:'/cases/[id]/static-resource',cacheRequested:true})"},
    {needle:'async function Ni(e,t={}){',expression:"(['automation:list','automation:runs'].includes(e)?{kind:e}:null)"}
  ];
  for(const point of points){const index=source.indexOf(point.needle);if(index<0)throw Error('Invocation function not found');const position=index+point.needle.length,before=source.slice(0,position),lineNumber=before.split('\n').length-1,columnNumber=position-before.lastIndexOf('\n')-1;
    const condition=`(()=>{try{const v=${point.expression};if(v)console.debug('MW_INTERFACE_AUDIT_20261026',JSON.stringify(v));}catch{}return false;})()`;
    const b=await session.send('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,lineNumber,columnNumber},condition});breakpoints.push(b.breakpointId);result.coverage.push({function:point.needle,actualLocation:b.actualLocation});}
  result.readyAt=new Date().toISOString();
  if(startNew){
    const base='http://127.0.0.1:17866',state=await fetch(base+'/api/state').then(r=>r.json());
    if(state.active&&!['completed','stopped','interrupted'].includes(state.active.status))throw Error('Another batch is active');
    const response=await fetch(base+'/api/run',{method:'POST',headers:{'Content-Type':'application/json','X-MW-CSRF':state.csrf},body:JSON.stringify({ids})});
    const created=await response.json();if(!response.ok)throw Error(created.error||'Batch submission failed');
    runId=created.id;result.runId=runId;output=path.join(dir,runId+'-ipc.json');run=created;
  }
  console.log(JSON.stringify({status:'capturing',runId,breakpoints:breakpoints.length}));
  let previous='';
  for(;;){run=JSON.parse(await fs.readFile(path.join(root,'runs',runId+'.json'),'utf8'));await persist();const status=JSON.stringify({status:run.status,done:run.results.length,current:run.current,stage:run.workerProgress?.stage,ipc:result.events.length});if(status!==previous){console.log(status);previous=status;}if(['completed','stopped','interrupted'].includes(run.status))break;await new Promise(r=>setTimeout(r,2500));}
  result.complete=true;
}catch(e){result.errors.push(e.message);process.exitCode=1;console.log(JSON.stringify({error:e.message}));}
finally{for(const breakpointId of breakpoints)await session?.send('Debugger.removeBreakpoint',{breakpointId}).catch(()=>{});await session?.detach().catch(()=>{});await browser?.close().catch(()=>{});result.endedAt=new Date().toISOString();await persist();await writing;}
