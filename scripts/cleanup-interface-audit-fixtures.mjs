// Scoped cleanup for the 2026-10-26 interface audit; never removes workspace files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {attach} from '../lib/runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ids=['1793019769981-96e1fc81-0bb9-4231-b68b-65a9bbe66d39','1793021070101-06a6209b-d78c-4d2f-9188-0dcbcd430b5a'];
const runs=await Promise.all(ids.map(id=>fs.readFile(path.join(root,'runs',id+'.json'),'utf8').then(JSON.parse)));
if(runs.some(r=>r.status!=='completed'))throw Error('Wait for both audit batches to complete');
const active=(await fetch('http://127.0.0.1:17866/api/state').then(r=>r.json())).active;
if(active&&!['completed','stopped','interrupted'].includes(active.status))throw Error('Console still active');
const tokenData=JSON.parse(await fs.readFile('C:/Users/86150/.mobilework/electron/openwork-server-tokens.json','utf8'));
const token=Object.values(tokenData.workspaces).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
const headers={Authorization:`Bearer ${token.ownerToken}`,...(token.hostToken?{'X-OpenWork-Host-Token':token.hostToken}:{})};
async function request(route,method='GET'){
  const r=await fetch('http://127.0.0.1:5774'+route,{method,headers,signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(`${method} ${route}: ${r.status}`);return r.json();
}
const before=await request('/workspaces');
const candidates=before.items.filter(w=>{
  const m=w.name?.match(/^MW-QA-v002-(\d+)$/);if(!m)return false;
  const created=Number(m[1]);return runs.some(run=>run.results.some(r=>['MW-UI-012','MW-UI-031','MW-UI-043'].includes(r.id)&&created>=Date.parse(r.startedAt)&&created<=Date.parse(r.endedAt)));
});
const records=[];
for(const w of candidates){
  const data=await request(`/workspace/${w.id}/sessions?limit=10000`),sessions=Array.isArray(data)?data:data.items;
  if(!Array.isArray(sessions))throw Error('Unknown session inventory');
  records.push({id:w.id,name:w.name,path:w.path,sessions:sessions.length,eligible:sessions.length===0});
}
console.log(JSON.stringify({mode:process.argv[2]||'inspect',total:before.items.length,activeId:before.activeId,candidates:records}));
if(process.argv[2]!=='execute')process.exit(0);
const out=path.join(root,'data/interface-audit-20261026/fixture-cleanup.json');
const audit={startedAt:new Date().toISOString(),beforeIds:before.items.map(w=>w.id),candidates:records,removed:[],skipped:records.filter(w=>!w.eligible),directoriesPreserved:true};
await fs.writeFile(out,JSON.stringify(audit,null,2));
const targets=records.filter(w=>w.eligible),fallback=before.items.find(w=>w.isDefault);
if(!fallback)throw Error('Default workspace not found');
let browser;
try{
  const attached=await attach();browser=attached.browser;const p=attached.page;
  const state=await p.evaluate(()=>({hash:location.hash,draft:[...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(e=>e.getClientRects().length).some(e=>e.textContent.trim()),dialogs:[...document.querySelectorAll('[role="dialog"]')].some(e=>e.getClientRects().length)}));
  if(state.draft||state.dialogs)throw Error('Draft or dialog present; preserve for review');
  if(targets.some(w=>w.id===before.activeId)||targets.some(w=>state.hash.includes(w.id))){
    const picker=p.locator('main button[data-slot="popover-trigger"]:not([aria-label])').filter({visible:true});
    if(await picker.count()!==1)throw Error('Cannot identify workspace selector safely');
    await picker.click();await p.locator('[data-slot="popover-content"]').getByRole('button',{name:fallback.name,exact:true}).click();
    await p.waitForFunction(id=>location.hash.includes(id),fallback.id,{timeout:20000});
  }
  for(const target of targets){
    const live=await request('/workspaces');if(live.activeId===target.id)throw Error('Target is still active');
    const sessions=await request(`/workspace/${target.id}/sessions?limit=10000`);
    if((Array.isArray(sessions)?sessions:sessions.items)?.length!==0)throw Error('Target gained sessions');
    const removed=await request(`/workspaces/${target.id}`,'DELETE');
    if(removed.deleted!==true||removed.persisted!==true)throw Error('Removal unconfirmed');
    audit.removed.push(target.id);await fs.writeFile(out,JSON.stringify(audit,null,2));
  }
  const after=await request('/workspaces');
  audit.afterIds=after.items.map(w=>w.id);audit.activeId=after.activeId;
  audit.retainedIdsUnchanged=before.items.filter(w=>!audit.removed.includes(w.id)).every(w=>audit.afterIds.includes(w.id));
  audit.directoriesPreserved=(await Promise.all(records.map(w=>fs.stat(w.path).then(s=>s.isDirectory()).catch(()=>false)))).every(Boolean);
  audit.endedAt=new Date().toISOString();await fs.writeFile(out,JSON.stringify(audit,null,2));
  console.log(JSON.stringify({removed:audit.removed,remaining:after.items.length,retainedIdsUnchanged:audit.retainedIdsUnchanged,directoriesPreserved:audit.directoriesPreserved}));
}finally{await browser?.close();}
