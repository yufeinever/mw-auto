import {addressType,summarizeRequests} from './probe-data.mjs';

// Only follow explicit fulfilled-job -> acquired-socket bindings. Never walk a
// generic dependency graph: shared pools, DNS and sessions join unrelated APIs.
export function linkTraceRequests(requests,events) {
  const bySource=new Map();
  for(const e of events){const a=bySource.get(e.source)||[];a.push(e);bySource.set(e.source,a);}
  for(const a of bySource.values())a.sort((a,b)=>a.timeMs-b.timeMs);
  return requests.map(r=>{
    const paths=new Map(),end=r.endMs??Infinity;
    for(const bound of bySource.get(r.source)||[]){
      if(bound.name!=='HTTP_STREAM_REQUEST_BOUND_TO_JOB'||!bound.dependency||bound.timeMs<r.startMs||bound.timeMs>end)continue;
      const sockets=(bySource.get(bound.dependency)||[]).filter(e=>e.name==='SOCKET_POOL_BOUND_TO_SOCKET'&&e.dependency&&e.timeMs>=r.startMs&&e.timeMs<=bound.timeMs);
      const acquired=sockets.at(-1);if(!acquired)continue;
      const history=(bySource.get(acquired.dependency)||[]).filter(e=>e.timeMs<=acquired.timeMs);
      const connected=history.filter(e=>e.name==='TCP_CONNECT_ATTEMPT'&&e.phase==='e').at(-1);
      if(!connected?.peer||connected.netError<0||history.some(e=>e.name==='SOCKET_CLOSED'&&e.timeMs>=connected.timeMs))continue;
      // A failed attempt/address list is not proof of the connected destination.
      const route={peer:connected.peer,networkPid:connected.pid,transport:'TCP',evidence:'socket_bound'};
      paths.set(route.networkPid+':'+route.peer,route);
    }
    const egressPaths=[...paths.values()];
    return {...r,...(egressPaths.length===1?{peer:egressPaths[0].peer}:{}),egressPaths};
  });
}

function targetOf(endpoint) {
  try{const u=new URL(endpoint),port=u.port||(['https:','wss:'].includes(u.protocol)?'443':'80');return {address:u.hostname+':'+port,type:addressType(u.hostname),origin:u.origin};}catch{return null;}
}
function peerType(peer){return addressType(peer.startsWith('[')?peer.slice(1,peer.indexOf(']')):peer.slice(0,peer.lastIndexOf(':')));}
const transportOf=r=>['h3','quic'].includes(r.protocol)?'UDP':['http/1.1','http/1.0','h2'].includes(r.protocol)?'TCP':'未知';

export function summarizeEgress({pageRows=[],networkRows=[],connections=[],events=[],seconds=0}) {
  const exits=new Map(),buckets=new Map();
  const get=(address,type)=>{let g=exits.get(address);if(!g){g={address,addressType:type,observations:new Set(),protocols:new Set(),tracePids:new Set(),processes:[],routes:[]};exits.set(address,g);}return g;};
  for(const c of connections){const g=get(c.remote,c.addressType);g.observations.add('tcp_sample');g.protocols.add('TCP');g.processes.push(c);}
  for(const e of events){if(!e.peer||!/^UDP_/.test(e.name||''))continue;const g=get(e.peer,peerType(e.peer));g.observations.add('udp_event');g.protocols.add('UDP');if(Number.isInteger(e.pid))g.tracePids.add(e.pid);}
  for(const [source,rows]of [['application',pageRows],['network',networkRows]])for(const r of rows){
    const target=targetOf(r.endpoint);if(!target)continue;
    let paths=r.egressPaths?.length?r.egressPaths:!r.fromCache&&r.peer?[{peer:r.peer,evidence:'cdp_peer',transport:transportOf(r)}]:[{peer:target.address,evidence:r.fromCache?'cache':'url_target',transport:'未知'}];
    for(const p of paths){const actual=['socket_bound','cdp_peer'].includes(p.evidence),g=get(p.peer,actual?peerType(p.peer):target.type);g.observations.add(p.evidence);if(p.transport!=='未知')g.protocols.add(p.transport);if(p.networkPid)g.tracePids.add(p.networkPid);
      const k=JSON.stringify([p.peer,source,p.evidence,p.networkPid||null]),bucket=buckets.get(k)||{exit:g,source,evidence:p.evidence,networkPid:p.networkPid||null,rows:[]};bucket.rows.push(r);buckets.set(k,bucket);
    }
  }
  for(const b of buckets.values())for(const r of summarizeRequests(b.rows,seconds))b.exit.routes.push({...r,source:b.source,evidence:b.evidence,networkPid:b.networkPid});
  return {revision:1,derivedFromSummary:false,entries:[...exits.values()].map(({observations,protocols,tracePids,...g})=>({...g,observations:[...observations],protocols:[...protocols],tracePids:[...tracePids]})).sort((a,b)=>b.routes.length-a.routes.length||a.address.localeCompare(b.address)),note:'地址是客户端可见连接对端或URL目标，不是公网NAT出口IP。页面与NetLog请求独立统计；同地址仅作进程候选。NetLog绑定PID是网络栈记录进程，不代表最初发起业务的进程。代理之后的最终去向及Node.js原生HTTP路径仍未知。'};
}

// Read old summaries without modifying their files or inventing socket evidence.
export function egressFromSummary(view) {
  const report=summarizeEgress({connections:view.process?.connections||[]});
  report.derivedFromSummary=true;
  const entries=new Map(report.entries.map(e=>[e.address,e]));
  for(const [source,rows]of [['application',view.application?.interfaces||[]],['network',view.network?.interfaces||[]]])for(const r of rows){
    const target=targetOf(r.endpoint);if(!target)continue;
    const g=entries.get(target.address)||{address:target.address,addressType:target.type,observations:[],protocols:[],tracePids:[],processes:[],routes:[]};
    if(!g.observations.includes('url_target'))g.observations.push('url_target');g.routes.push({...r,source,evidence:'url_target',networkPid:null});entries.set(g.address,g);
  }
  report.entries=[...entries.values()].sort((a,b)=>b.routes.length-a.routes.length);report.note='历史汇总派生视图：仅按URL目标生成候选，未补造请求与Socket的关联。'+report.note;return report;
}
