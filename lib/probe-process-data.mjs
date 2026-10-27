import {addressType,ipEndpoint,keyOf} from './probe-data.mjs';

const roleOf=role=>['main','renderer','NetworkService','utility','child'].includes(role)?role:'child';
export function recordProcessSample(a,data,emit) {
  const s=a.layers.process;
  a.sampleCount++;s.sampleAt=data.at;s.processCount=data.processCount;
  for(const k of ['tcp','udp']){
    if(data[k+'Status']==='failed'){s[k+'Failures']=(s[k+'Failures']||0)+1;s.gaps++;}
    else if(data[k+'Status']==='ok')s[k+'Samples']=(s[k+'Samples']||0)+1;
  }
  const sample=new Map();
  for(const c of data.connections||[]){
    const remote=ipEndpoint(c.remoteAddress,c.remotePort);if(!remote||!Number.isInteger(c.pid))continue;
    const type=addressType(c.remoteAddress);if(type==='unspecified'||type==='local')continue;
    const role=roleOf(c.role),state=/^[A-Za-z]+$/.test(c.state)?c.state:'Unknown';
    const tuple=keyOf(`${c.pid}:${c.localAddress}:${c.localPort}:${remote}`);
    emit('process',{kind:'connection',protocol:'TCP',at:data.at,pid:c.pid,role,remote,addressType:type,state,tuple});
    const k=c.pid+':'+remote,g=a.connections.get(k)||{protocol:'TCP',pid:c.pid,role,remote,addressType:type,samples:0,peakConnections:0,states:{},firstSeen:data.at,lastSeen:data.at,tuples:new Set()};
    g.tuples.add(tuple);g.states[state]=(g.states[state]||0)+1;g.lastSeen=data.at;a.connections.set(k,g);sample.set(k,(sample.get(k)||0)+1);
  }
  for(const [k,n]of sample){const g=a.connections.get(k);g.samples++;g.peakConnections=Math.max(g.peakConnections,n);}
  const seen=new Set();
  for(const c of data.udpEndpoints||[]){
    const local=ipEndpoint(c.localAddress,c.localPort);if(!local||!Number.isInteger(c.pid))continue;
    const k=c.pid+':'+local;if(seen.has(k))continue;seen.add(k);
    const role=roleOf(c.role),g=a.udpEndpoints.get(k)||{protocol:'UDP',pid:c.pid,role,local,samples:0,firstSeen:data.at,lastSeen:data.at};
    g.samples++;g.lastSeen=data.at;a.udpEndpoints.set(k,g);
    emit('process',{kind:'udp_endpoint',at:data.at,pid:c.pid,role,local});
  }
}
