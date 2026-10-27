import {loadPlaywright} from './dependencies.mjs';
import {isMainWindowUrl} from './main-window.mjs';
import {endpoint,methodOf,sanitizeTrace} from './probe-data.mjs';

export async function connectProbe() {
  const browser=await loadPlaywright().chromium.connectOverCDP('http://127.0.0.1:9223',{timeout:7000});
  if(!browser.contexts().flatMap(c=>c.pages()).some(p=>isMainWindowUrl(p.url()))){await browser.close();throw Error('未识别到 MobileWork 窗口');}
  return browser;
}
export async function startPageCapture(browser,emit,status) {
  const sessions=new Map(),tasks=new Set(),listeners=[],rows=[];let closed=false,seq=0;
  async function attach(page) {
    if(closed||sessions.has(page))return;
    let s;try{s=await page.context().newCDPSession(page);}catch{status.gaps++;return;}
    if(closed){await s.detach().catch(()=>{});return;}
    const pending=new Map();sessions.set(page,{s,pending});
    const done=(r,end,outcome)=>{r.endMs=end;r.durationMs=Math.max(0,end-r.startMs);r.outcome=outcome;emit('application',{kind:'request_end',...r});};
    s.on('Network.requestWillBeSent',e=>{
      const previous=pending.get(e.requestId);
      if(previous){if(e.redirectResponse){previous.status=e.redirectResponse.status;done(previous,e.timestamp*1000,'redirected');}else done(previous,e.timestamp*1000,'incomplete');pending.delete(e.requestId);}
      const ep=endpoint(e.request.url);if(!ep)return;
      if(rows.length>=50000){status.dropped++;return;}
      const row={key:++seq,...ep,method:methodOf(e.request.method),startedAt:new Date(e.wallTime*1000).toISOString(),startMs:e.timestamp*1000,outcome:'pending',resourceType:e.type};
      rows.push(row);pending.set(e.requestId,row);emit('application',{kind:'request_start',...row});
    });
    s.on('Network.responseReceived',e=>{
      const r=pending.get(e.requestId);if(!r)return;r.status=e.response.status;
      const t=e.response.timing;
      // Event dispatch time may be later than loadingFinished. Use network timing only.
      if(Number.isFinite(t?.requestTime)&&Number.isFinite(t?.receiveHeadersEnd)&&t.receiveHeadersEnd>=0){
        const duration=t.requestTime*1000+t.receiveHeadersEnd-r.startMs;
        if(duration>=0){r.headersMs=duration;r.headersTimingSource='resourceTiming';}
      }
      r.stream=e.response.mimeType==='text/event-stream';r.fromCache=!!(e.response.fromDiskCache||e.response.fromServiceWorker||e.response.fromPrefetchCache);emit('application',{kind:'response_headers',...r});
    });
    s.on('Network.loadingFinished',e=>{const r=pending.get(e.requestId);if(!r)return;r.bytes=e.encodedDataLength;done(r,e.timestamp*1000,'finished');pending.delete(e.requestId);});
    s.on('Network.loadingFailed',e=>{const r=pending.get(e.requestId);if(!r)return;r.error=/^net::ERR_[A-Z0-9_]+$/.test(e.errorText)?e.errorText:'network_failure';done(r,e.timestamp*1000,'failed');pending.delete(e.requestId);});
    page.once('close',()=>{for(const r of pending.values()){r.outcome='incomplete';emit('application',{kind:'request_end',...r});}pending.clear();sessions.delete(page);status.targets=sessions.size;});
    try{await s.send('Network.enable');status.targets=sessions.size;status.attachedTargets=(status.attachedTargets||0)+1;}
    catch{sessions.delete(page);await s.detach().catch(()=>{});status.gaps++;}
  }
  for(const context of browser.contexts()){
    const onPage=p=>{const task=attach(p).catch(()=>status.gaps++).finally(()=>tasks.delete(task));tasks.add(task);};
    context.on('page',onPage);listeners.push([context,onPage]);
    for(const p of context.pages())await attach(p);
  }
  status.state=sessions.size?'recording':'unavailable';status.note='当前 Electron 可附加页面的 HTTP；不含主进程 Node.js HTTP。';
  return {rows,async stop(){closed=true;for(const [c,fn]of listeners)c.off('page',fn);await Promise.allSettled([...tasks]);for(const {s,pending}of sessions.values()){for(const r of pending.values()){r.outcome='incomplete';emit('application',{kind:'request_end',...r});}await s.detach().catch(()=>{});}if(status.state==='recording')status.state=status.gaps||status.dropped?'partial':'stopped';}};
}

export async function startNetworkCapture(browser,emit,status) {
  const s=await browser.newBrowserCDPSession(),events=[];let owned=false,completeResolve;
  const complete=new Promise(resolve=>completeResolve=resolve);
  s.on('Tracing.dataCollected',({value})=>{for(const e of value){const row=sanitizeTrace(e);if(!row)continue;if(events.length>=250000){status.dropped++;continue;}events.push(row);emit('network',row);}});
  s.on('Tracing.bufferUsage',e=>{status.bufferPercent=Math.round((e.percentFull||0)*100);if(e.percentFull>=.99)status.bufferFull=true;});
  s.on('Tracing.tracingComplete',e=>{status.dataLoss=!!e.dataLossOccurred;completeResolve();});
  try{
    const {categories}=await s.send('Tracing.getCategories');if(!categories.includes('netlog'))throw Error('netlog unavailable');
    await s.send('Tracing.start',{transferMode:'ReportEvents',bufferUsageReportingInterval:1000,traceConfig:{recordMode:'recordAsMuchAsPossible',traceBufferSizeInKb:32768,includedCategories:['netlog'],excludedCategories:['*']}});owned=true;
    status.state='recording';status.note='Chromium NetLog；停止后汇总。包括 Chromium 网络栈，不能覆盖 Node.js 原生 HTTP。';
  }catch{await s.detach().catch(()=>{});throw Error('网络追踪未开启：可能已有追踪占用或当前版本不支持');}
  return {events,async stop(){
    if(!owned)return;owned=false;
    try{await s.send('Tracing.end');let timer;await Promise.race([complete,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),12000);})]).finally(()=>clearTimeout(timer));status.state=status.dataLoss||status.dropped||status.bufferFull?'partial':'stopped';}
    catch{status.state='partial';status.note='追踪停止或数据回收超时，已收到的数据保留；不能声称完整。';}
    finally{await s.detach().catch(()=>{});}
  }};
}
