import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {summarizeRequests,summarizeTrace,summarizeChannels,summarizeTransports} from './probe-data.mjs';
import {recordProcessSample} from './probe-process-data.mjs';
import {linkTraceRequests,summarizeEgress,egressFromSummary} from './probe-egress.mjs';
import {connectProbe,startPageCapture,startNetworkCapture} from './probe-collectors.mjs';

const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const status=()=>({state:'disabled',dropped:0,gaps:0,note:''});
const now=()=>new Date().toISOString();
const validId=id=>/^probe-\d{13}-[0-9a-f-]{36}$/.test(id);
const meta=s=>({id:s.id,startedAt:s.startedAt,endedAt:s.endedAt,status:s.status,scenario:s.scenario,monitoring:s.monitoring,requests:s.application?.requests||0,remoteRequests:s.network?.remoteRequests||0});

export class ProbeManager {
  constructor(root,options={}) {this.dir=path.join(root,'data','probes');this.active=null;this.history=[];this.closed=false;this.options=options;}
  async init(){
    await fs.mkdir(this.dir,{recursive:true});
    for(const name of await fs.readdir(this.dir)){
      if(!validId(name))continue;
      try{let s=JSON.parse(await fs.readFile(path.join(this.dir,name,'summary.json'),'utf8'));if(s.schema!==2)continue;
        if(['starting','recording','stopping'].includes(s.status)){s={...s,status:'interrupted',endedAt:s.observedAt,note:'控制台重启，上一批未完成；保留最后快照，不自动续采。'};for(const v of Object.values(s.layers))if(v.state==='recording')v.state='interrupted';await fs.writeFile(path.join(this.dir,name,'summary.json'),JSON.stringify(s,null,2));}
        this.history.push(meta(s));
      }catch{}
    }
    this.history.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  }
  async state(){return {active:this.active?this.snapshot():null,history:this.history.slice(0,50),capabilities:{application:'页面HTTP / WebSocket / SSE（部分覆盖）',network:'Chromium NetLog含UDP / QUIC事件（运行时检查）',process:process.platform==='win32'?'Windows TCP / UDP本地端点采样':'仅支持 Windows'},coverage:'未接入 session.webRequest；Chromium 之外的 Node.js/子进程 HTTP 路径未覆盖。TCP连接及UDP本地端点样本不等于请求次数，客户端 RPS 不等于后端容量。'};}
  async read(id){if(!validId(id))throw Error('无效探测编号');const view=JSON.parse(await fs.readFile(path.join(this.dir,id,'summary.json'),'utf8'));return view.egress?view:{...view,egress:egressFromSummary(view)};}
  snapshot(){
    const a=this.active;if(!a)return null;const ended=a.endedAt||now();const seconds=Math.max(.001,(Date.parse(ended)-Date.parse(a.startedAt))/1000);
    const interfaces=summarizeRequests(a.page?.rows||[],seconds),trace=a.traceSummary||{requests:[],phases:[],unmatchedSpans:0};
    const networkInterfaces=summarizeRequests(trace.requests,seconds);
    const connections=[...a.connections.values()].map(({tuples,...r})=>({...r,observedTuples:tuples.size}));
    return {schema:2,collectorRevision:3,id:a.id,startedAt:a.startedAt,endedAt:a.endedAt,observedAt:ended,durationSeconds:+seconds.toFixed(2),requestedSeconds:a.requestedSeconds,status:a.state,scenario:a.scenario,enabled:a.enabled,layers:a.layers,markers:a.markers,monitoring:a.monitoring,stopReason:a.stopReason,
      egress:summarizeEgress({pageRows:a.page?.rows||[],networkRows:trace.requests,connections,events:a.traceSummary?a.network?.events||[]:[],seconds}),
      application:{requests:interfaces.reduce((n,r)=>n+r.count,0),uniqueEndpoints:interfaces.length,interfaces,channels:summarizeChannels(a.page?.channels||[],a.page?.rows||[],seconds)},
      network:{events:a.network?.events.length||0,interfaces:networkInterfaces,remoteRequests:networkInterfaces.filter(r=>r.addressType!=='local').reduce((n,r)=>n+r.count,0),phases:trace.phases,unmatchedSpans:trace.unmatchedSpans,transports:a.transportSummary||[],note:'与页面层分开计数；缓存、重试及重定向可能影响远端负载。网络阶段及UDP/QUIC事件未强行关联至具体接口，QUIC事件不等同HTTP/3请求。'},
      process:{sampleCount:a.sampleCount,connections:connections.sort((a,b)=>b.samples-a.samples),udpEndpoints:[...a.udpEndpoints.values()],note:'约每秒采样（实际可能更慢）；TCP样本不是请求数，UDP只列本地绑定、无法获知其远端及数据报数；短连接/端点可能漏采。'},
      privacy:'仅允许的元数据落盘；不保存请求头、正文、查询参数；未知路径段以 :id 隐去。',
      coverage:'页面HTTP / WS帧 / SSE元数据 + Chromium NetLog含UDP/QUIC + 进程树TCP及UDP本地端点；独立worker、Node.js原生HTTP、IPC消息仍有缺口。不能衡量后端CPU/容量。'};
  }
  async save(){const a=this.active;if(!a)return;const data=JSON.stringify(this.snapshot(),null,2);a.writes=(a.writes||Promise.resolve()).then(()=>fs.writeFile(path.join(a.dir,'summary.json'),data));return a.writes;}
  async start(enabled,options={}){
    if(this.active||this.closed||(this.continuous&&options.continuation!==this.continuous))throw Error('已有探测批次或服务正在关闭');
    if(!enabled||typeof enabled!=='object'||Object.keys(enabled).some(k=>!['application','network','process'].includes(k))||Object.values(enabled).some(v=>typeof v!=='boolean')||!Object.values(enabled).some(Boolean))throw Error('请选择至少一种有效记录方式');
    const scenario=['idle','operation'].includes(options.scenario)?options.scenario:'operation';
    const seconds=options.seconds??300;if(!Number.isInteger(seconds)||(seconds!==0&&(seconds<5||seconds>900)))throw Error('记录时长应为 5～900 秒，或静置持续监测');
    if(seconds===0&&scenario!=='idle')throw Error('持续监测仅用于静置场景');
    const id=`probe-${Date.now()}-${randomUUID()}`;
    const a={id,dir:path.join(this.dir,id),startedAt:now(),requestedSeconds:seconds,enabled:{application:false,network:false,process:false,...enabled},scenario,state:'starting',layers:{application:status(),network:status(),process:status()},connections:new Map(),udpEndpoints:new Map(),sampleCount:0,markers:[],streams:{},bytes:0};
    if(seconds===0){
      const c=options.continuation||{id,startedAt:a.startedAt,index:0};this.continuous=c;c.index++;
      a.monitoring={mode:'continuous',id:c.id,startedAt:c.startedAt,segment:c.index,previousId:c.previousId,gapMs:c.endedAt?Math.max(0,Date.parse(a.startedAt)-Date.parse(c.endedAt)):0,note:'手动停止；每5分钟或接近容量上限自动保存并续采，各段独立统计。gapMs为前段停止至本段就绪的间隔上界；重新附加及跨段长请求/连接有缺口，不补造完整耗时。'};
    }
    this.active=a; // Reserve before any await: concurrent starts cannot leak collectors.
    try{
      await fs.mkdir(a.dir,{recursive:true});
      const emit=(source,row)=>{
        const line=JSON.stringify(row)+'\n';
        if(a.bytes+Buffer.byteLength(line)>64*1024*1024){a.layers[source].dropped++;a.capacityReached=true;return;}
        let stream=a.streams[source];if(!stream){stream=createWriteStream(path.join(a.dir,source+'-events.jsonl'),{flags:'a'});a.streams[source]=stream;stream.on('error',()=>{a.layers[source].state='failed';a.layers[source].note='记录文件写入失败';a.limitReached=true;});}
        if(stream.writableLength>4*1024*1024){a.layers[source].dropped++;return;}
        a.bytes+=Buffer.byteLength(line);stream.write(line);
      };
      if(enabled.application||enabled.network){
        try{a.browser=await (this.options.connect||connectProbe)();a.browser.on('disconnected',()=>{if(a.state==='recording'){for(const k of ['application','network'])if(a.enabled[k]){a.layers[k].state='interrupted';a.layers[k].note='客户端 CDP 已断开，本批不自动补齐';}void this.stop().catch(()=>{});}});}
        catch{for(const k of ['application','network'])if(enabled[k]){a.layers[k].state='unavailable';a.layers[k].note='未连接到 MobileWork CDP，请确认客户端及 9223 调试端口';}}
      }
      if(a.browser)for(const [name,start]of [['application',startPageCapture],['network',startNetworkCapture]])if(enabled[name]){
        try{const collector=await start(a.browser,emit,a.layers[name]);a[name==='application'?'page':'network']=collector;}
        catch{a.layers[name].state='unavailable';a.layers[name].note=name==='network'?'NetLog 未开启：已有追踪占用或版本不支持':'页面网络订阅失败';}
      }
      if(enabled.process)await this.startProcess(a,emit);
      a.state=Object.values(a.layers).some(s=>s.state==='recording')?'recording':'failed';
      if(a.monitoring){a.monitoring.readyAt=now();if(this.continuous.endedAt){a.monitoring.gapMs=Math.max(0,Date.parse(a.monitoring.readyAt)-Date.parse(this.continuous.endedAt));for(const layer of Object.values(a.layers))if(layer.state==='recording'){layer.gaps++;layer.note+=' 持续监测切段重新附加，跨段有缺口。';}}}
      await this.save();
      if(a.state==='failed'){a.endedAt=now();await this.finish();this.continuous=null;return await this.read(id);}
      if(this.closed){await this.stop();return await this.read(id);}
      a.timer=setInterval(()=>{
        if(a.limitReached){a.stopReason='记录容量或文件写入异常';void this.stop().catch(()=>{});return;}
        if(a.monitoring&&(a.capacityReached||a.bytes>48*1024*1024||a.page?.rows.length>=40000||a.page?.channels.length>=40000||a.network?.events.length>=200000)){void this.rotate(a,'容量分段');return;}
        if(a.capacityReached){a.stopReason='记录容量上限';void this.stop().catch(()=>{});return;}
        void this.save().catch(()=>{a.limitReached=true;});
      },this.options.maintenanceMs??3000);a.timer.unref();
      a.deadline=setTimeout(()=>{if(a.monitoring)void this.rotate(a,'定期分段');else void this.stop().catch(()=>{});},seconds===0?(this.options.continuousSegmentMs??300000):seconds*1000);a.deadline.unref();return this.snapshot();
    }catch(e){a.state='recording';await this.stop().catch(()=>{});throw e;}
  }
  async startProcess(a,emit){
    const s=a.layers.process;s.note='进程树TCP和UDP本地端点采样；UDP远端未知，采样数不等于请求数。';
    if(process.platform!=='win32'){s.state='unavailable';return;}
    const stopFile=path.join(a.dir,'stop-process');a.stopFile=stopFile;
    const child=spawn('pwsh',['-NoProfile','-NonInteractive','-File',path.join(scripts,'probe-process-recorder.ps1'),'-ParentId',String(process.pid),'-StopFile',stopFile,'-Seconds',String(a.monitoring?0:a.requestedSeconds+30)],{windowsHide:true,stdio:['ignore','pipe','ignore']});a.child=child;
    let readyResolve;const ready=new Promise(r=>readyResolve=r);let carry='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      carry+=chunk;if(carry.length>4*1024*1024){carry='';s.gaps++;return;}
      const lines=carry.split('\n');carry=lines.pop();for(const line of lines){let data;try{data=JSON.parse(line);}catch{s.gaps++;continue;}
        if(data.kind==='error'){s.state='unavailable';readyResolve();continue;}
        if(data.kind!=='sample')continue;
        s.state=data.tcpStatus==='failed'&&data.udpStatus==='failed'?'unavailable':'recording';recordProcessSample(a,data,emit);readyResolve();
      }
    });
    child.once('error',()=>{s.state='unavailable';readyResolve();});child.once('exit',()=>{if(a.state==='recording'){s.state='interrupted';s.note='进程采样提前退出';}readyResolve();});
    let timer;await Promise.race([ready,new Promise(r=>{timer=setTimeout(r,10000);})]).finally(()=>clearTimeout(timer));if(s.state!=='recording'){s.state='unavailable';s.note='无法在 10 秒内取得进程样本';child.kill();}
  }
  mark(kind){if(this.active?.state!=='recording')throw Error('请先开始记录');if(!['idle','operation'].includes(kind))throw Error('无效阶段');this.active.markers.push({at:now(),kind});return this.snapshot();}
  async rotate(a,reason){
    if(this.active!==a||a.stopping||a.rotating)return;
    const c=this.continuous;if(!c||c.cancelled)return;
    a.rotating=true;a.stopReason=reason;
    try{
      const ended=await this.stop({rotation:true});c.previousId=ended.id;c.endedAt=ended.endedAt;
      if(c.cancelled||this.closed){this.continuous=null;return;}
      await this.start(a.enabled,{seconds:0,scenario:'idle',continuation:c});
    }catch{c.cancelled=true;this.continuous=null;}
  }
  async stop({rotation=false}={}){
    if(this.active?.state==='starting')throw Error('记录器正在启动，请稍后停止');
    const c=this.continuous;if(!rotation&&c)c.cancelled=true;
    const a=this.active;if(!a){if(c?.lastSummary){this.continuous=null;return c.lastSummary;}throw Error('当前没有探测批次');}if(a.stopping)return a.stopping;
    a.stopping=(async()=>{
      a.state='stopping';a.endedAt=now();clearInterval(a.timer);clearTimeout(a.deadline);
      if(a.stopFile)await fs.writeFile(a.stopFile,'stop');
      await Promise.allSettled([a.page?.stop(),a.network?.stop()]);
      if(a.child&&a.child.exitCode===null){let timer;await Promise.race([new Promise(r=>a.child.once('exit',r)),new Promise(r=>{timer=setTimeout(()=>{a.child.kill();r();},5000);})]).finally(()=>clearTimeout(timer));}
      if(a.layers.process.state==='recording')a.layers.process.state='stopped';
      if(a.network){a.traceSummary=summarizeTrace(a.network.events);a.traceSummary.requests=linkTraceRequests(a.traceSummary.requests,a.network.events);a.transportSummary=summarizeTransports(a.network.events);}
      await a.browser?.close().catch(()=>{});
      a.state=Object.values(a.layers).some(s=>['partial','failed','interrupted','unavailable','starting'].includes(s.state)||s.gaps||s.dropped)?'partial':'completed';
      await this.finish();if(!rotation)this.continuous=null;return await this.read(a.id);
    })();return a.stopping;
  }
  async finish(){const a=this.active;for(const stream of Object.values(a.streams))await new Promise(r=>{if(stream.destroyed)return r();stream.end(r);});await this.save();const summary=this.snapshot();this.history.unshift(meta(summary));if(this.continuous)this.continuous.lastSummary=summary;this.active=null;}
  async close(){this.closed=true;if(this.continuous)this.continuous.cancelled=true;if(this.active){if(this.active.state==='starting')return;await this.stop();}}
}
