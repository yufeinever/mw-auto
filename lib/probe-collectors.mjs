import {loadPlaywright} from './dependencies.mjs';
import {isMainWindowUrl} from './main-window.mjs';
import {endpoint,methodOf,protocolOf,ipEndpoint,sanitizeTrace} from './probe-data.mjs';

export async function connectProbe() {
  const browser=await loadPlaywright().chromium.connectOverCDP('http://127.0.0.1:9223',{timeout:7000});
  if(!browser.contexts().flatMap(c=>c.pages()).some(p=>isMainWindowUrl(p.url()))){await browser.close();throw Error('未识别到 MobileWork 窗口');}
  return browser;
}
export async function startPageCapture(browser,emit,status) {
  const sessions=new Map(),tasks=new Set(),listeners=[],rows=[],channels=[];let closed=false,seq=0;
  try{const inventory=await browser.newBrowserCDPSession();try{const {targetInfos}=await inventory.send('Target.getTargets');status.targetTypes={};for(const t of targetInfos){const type=['page','webview','iframe','worker','service_worker','shared_worker','browser'].includes(t.type)?t.type:'other';status.targetTypes[type]=(status.targetTypes[type]||0)+1;}}finally{await inventory.detach();}}catch{status.targetInventoryUnavailable=true;}
  async function attach(page) {
    if(closed||sessions.has(page))return;
    let s;try{s=await page.context().newCDPSession(page);}catch{status.gaps++;return;}
    if(closed){await s.detach().catch(()=>{});return;}
    const pending=new Map(),sockets=new Map();sessions.set(page,{s,pending,sockets});
    const done=(r,end,outcome)=>{r.endMs=end;r.durationMs=Math.max(0,end-r.startMs);r.outcome=outcome;emit('application',{kind:'request_end',...r});};
    s.on('Network.requestWillBeSent',e=>{
      const previous=pending.get(e.requestId);
      if(previous){if(e.redirectResponse){previous.status=e.redirectResponse.status;done(previous,e.timestamp*1000,'redirected');}else done(previous,e.timestamp*1000,'incomplete');pending.delete(e.requestId);}
      const ep=endpoint(e.request.url);if(!ep||ep.endpoint.startsWith('ws:')||ep.endpoint.startsWith('wss:'))return;
      if(rows.length>=50000){status.dropped++;return;}
      const row={key:++seq,...ep,method:methodOf(e.request.method),startedAt:new Date(e.wallTime*1000).toISOString(),startMs:e.timestamp*1000,outcome:'pending',resourceType:e.type};
      rows.push(row);pending.set(e.requestId,row);emit('application',{kind:'request_start',...row});
    });
    s.on('Network.responseReceived',e=>{
      const r=pending.get(e.requestId);if(!r)return;r.status=e.response.status;
      const protocol=protocolOf(e.response.protocol);if(protocol)r.protocol=protocol;
      const peer=ipEndpoint(e.response.remoteIPAddress,e.response.remotePort);if(peer)r.peer=peer;
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
    s.on('Network.dataReceived',e=>{const r=pending.get(e.requestId);if(!r?.stream)return;r.receivedChunks=(r.receivedChunks||0)+1;r.receivedBytes=(r.receivedBytes||0)+Math.max(0,Number(e.dataLength)||0);emit('application',{kind:'sse_chunk',key:r.key,bytes:Math.max(0,Number(e.dataLength)||0)});});
    s.on('Network.eventSourceMessageReceived',e=>{const r=pending.get(e.requestId);if(!r)return;r.stream=true;r.sseMessages=(r.sseMessages||0)+1;emit('application',{kind:'sse_event',key:r.key,timeMs:e.timestamp*1000});});
    const socket=(id,extra={})=>{let r=sockets.get(id);if(!r){if(channels.length>=50000){status.dropped++;return null;}r={key:++seq,kind:'WebSocket',endpoint:null,preexisting:true,outcome:'pending',sentFrames:0,receivedFrames:0,sentBytes:0,receivedBytes:0,errors:0,...extra};channels.push(r);sockets.set(id,r);}return r;};
    s.on('Network.webSocketCreated',e=>{const ep=endpoint(e.url);if(!ep)return;const r=socket(e.requestId,{...ep,preexisting:false});if(r)emit('application',{kind:'ws_created',...r});});
    s.on('Network.webSocketWillSendHandshakeRequest',e=>{const r=socket(e.requestId);if(r)r.startMs=e.timestamp*1000;});
    s.on('Network.webSocketHandshakeResponseReceived',e=>{const r=socket(e.requestId);if(!r)return;r.status=e.response.status;r.outcome=e.response.status===101||e.response.status===200?'open':'failed';if(Number.isFinite(r.startMs))r.headersMs=Math.max(0,e.timestamp*1000-r.startMs);emit('application',{kind:'ws_handshake',...r});});
    for(const [event,direction]of [['Network.webSocketFrameSent','sent'],['Network.webSocketFrameReceived','received']])s.on(event,e=>{
      const r=socket(e.requestId);if(!r)return;const frame=e.response;
      const bytes=typeof frame?.payloadData==='string'?Buffer.byteLength(frame.payloadData,frame.opcode===1?'utf8':'base64'):0;
      r[direction+'Frames']++;r[direction+'Bytes']+=bytes;
      emit('application',{kind:'ws_frame',key:r.key,direction,bytes,timeMs:e.timestamp*1000});
    });
    s.on('Network.webSocketFrameError',e=>{const r=socket(e.requestId);if(r){r.errors++;emit('application',{kind:'ws_error',key:r.key,timeMs:e.timestamp*1000});}});
    s.on('Network.webSocketClosed',e=>{const r=sockets.get(e.requestId);if(r){r.outcome='closed';emit('application',{kind:'ws_closed',key:r.key,timeMs:e.timestamp*1000});sockets.delete(e.requestId);}});
    const closePending=()=>{for(const r of pending.values()){r.outcome='incomplete';emit('application',{kind:'request_end',...r});}pending.clear();for(const r of sockets.values())r.outcome='incomplete';sockets.clear();};
    const onClose=()=>{closePending();sessions.delete(page);status.targets=sessions.size;};
    sessions.get(page).onClose=onClose;sessions.get(page).closePending=closePending;page.once('close',onClose);
    try{await s.send('Network.enable');status.targets=sessions.size;status.attachedTargets=(status.attachedTargets||0)+1;}
    catch{page.off('close',onClose);sessions.delete(page);await s.detach().catch(()=>{});status.gaps++;}
  }
  for(const context of browser.contexts()){
    const onPage=p=>{const task=attach(p).catch(()=>status.gaps++).finally(()=>tasks.delete(task));tasks.add(task);};
    context.on('page',onPage);listeners.push([context,onPage]);
    for(const p of context.pages())await attach(p);
  }
  status.state=sessions.size?'recording':'unavailable';status.note='可附加页面 HTTP、WebSocket帧与SSE元数据；不含主进程 Node.js HTTP和独立worker订阅。';
  return {rows,channels,async stop(){closed=true;for(const [c,fn]of listeners)c.off('page',fn);await Promise.allSettled([...tasks]);for(const [page,{s,onClose,closePending}]of sessions){page.off('close',onClose);closePending();await s.detach().catch(()=>{});}sessions.clear();status.targets=0;if(status.state==='recording')status.state=status.gaps||status.dropped?'partial':'stopped';}};
}

export async function startNetworkCapture(browser,emit,status,{segmentMs=60000,stopTimeoutMs=12000}={}) {
  const s=await browser.newBrowserCDPSession(),events=[];let owned=false,stopping=false,completeResolve,complete,timer,rotating=Promise.resolve();
  s.on('Tracing.dataCollected',({value})=>{for(const e of value){const row=sanitizeTrace(e);if(!row)continue;if(events.length>=250000){status.dropped++;continue;}events.push(row);emit('network',row);}});
  s.on('Tracing.bufferUsage',e=>{status.bufferPercent=Math.round((e.percentFull||0)*100);if(e.percentFull>=.99)status.bufferFull=true;});
  s.on('Tracing.tracingComplete',e=>{status.dataLoss=!!(status.dataLoss||e.dataLossOccurred);completeResolve?.();});
  async function begin(){
    complete=new Promise(resolve=>completeResolve=resolve);
    await s.send('Tracing.start',{transferMode:'ReportEvents',bufferUsageReportingInterval:1000,traceConfig:{recordMode:'recordAsMuchAsPossible',traceBufferSizeInKb:32768,includedCategories:['netlog'],excludedCategories:['*']}});owned=true;status.segments=(status.segments||0)+1;status.bufferPercent=0;
  }
  async function drain(){
    if(!owned)return;owned=false;
    await s.send('Tracing.end');let timeout;
    try{await Promise.race([complete,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('timeout')),stopTimeoutMs);})]);}
    finally{clearTimeout(timeout);}
  }
  function schedule(){timer=setTimeout(()=>{
    rotating=(async()=>{
      const at=new Date().toISOString(),before=performance.now();
      try{await drain();if(stopping)return;await begin();
        status.gaps++;status.rollovers=(status.rollovers||0)+1;status.segmentGapMs=(status.segmentGapMs||0)+Math.round(performance.now()-before);
        emit('network',{kind:'trace_boundary',at,gapMs:Math.round(performance.now()-before)});schedule();
      }catch{status.state='partial';status.note='网络分段回收失败，本批保留已收数据；请停止后重新记录。';status.gaps++;}
    })();
  },segmentMs);timer.unref();}
  try{
    const {categories}=await s.send('Tracing.getCategories');if(!categories.includes('netlog'))throw Error('netlog unavailable');
    await begin();schedule();
    status.state='recording';status.note='Chromium NetLog，每60秒分段回收；分段间隔显式记录。不能覆盖Node.js原生HTTP。';
  }catch{await s.detach().catch(()=>{});throw Error('网络追踪未开启：可能已有追踪占用或当前版本不支持');}
  return {events,async stop(){
    if(stopping)return;stopping=true;clearTimeout(timer);
    try{await rotating;await drain();status.state=status.dataLoss||status.dropped||status.bufferFull||status.gaps?'partial':'stopped';}
    catch{status.state='partial';status.note='追踪停止或数据回收超时，已收到的数据保留；不能声称完整。';}
    finally{await s.detach().catch(()=>{});}
  }};
}
