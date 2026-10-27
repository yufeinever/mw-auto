// A zero count is only "not observed" when the relevant collector actually ran.
export function protocolCoverage(view) {
  const modern=view.collectorRevision>=2;
  const layer=(key,count,wait=false)=>{
    const s=view.layers[key];
    if(!view.enabled[key])return '未启用';
    if(['failed','unavailable'].includes(s.state))return '不可用';
    if(['interrupted','partial'].includes(s.state)||s.gaps||s.dropped)return '采集不完整';
    if(s.state==='starting')return '启动中';
    if(wait&&!view.endedAt)return '停止后统计';
    return count>0?'已观察到':'本批未观察到';
  };
  const newLayer=(key,count,wait=false)=>modern?layer(key,count,wait):'旧批次未采集';
  const channels=view.application.channels||[],transports=view.network.transports||[];
  return [
    ['HTTP / HTTPS',layer('application',view.application.requests),'页面层请求；HTTP版本和连接对端见接口明细，独立worker未订阅。'],
    ['WebSocket',newLayer('application',channels.filter(r=>r.kind==='WebSocket').length),'统计可见页面的握手与收发帧；帧数不等于业务消息数，采集前已存在的连接可能缺URL/握手。'],
    ['SSE',newLayer('application',channels.filter(r=>r.kind==='SSE').length),'EventSource事件和网络数据块分开；fetch流只能数数据块，不解析业务正文。'],
    ['TCP远端连接',layer('process',view.process.connections.length),'进程树远端连接采样；包含已连接、正在连接及等待关闭，短连接可能漏采。'],
    ['UDP本地端点',newLayer('process',(view.process.udpEndpoints||[]).length),'只确认本地UDP绑定及所属PID；不能据此得到远端、数据报数或请求频率。'],
    ['Chromium UDP',newLayer('network',transports.find(r=>r.protocol==='UDP')?.events||0,true),'仅Chromium NetLog事件；可见时保留远端IP和字节数，不覆盖全部系统UDP。'],
    ['Chromium QUIC',newLayer('network',transports.find(r=>r.protocol==='QUIC')?.events||0,true),'QUIC事件不等同HTTP/3请求；HTTP/3需HTTP响应协议字段确认。'],
    ['主进程 / 子进程 Node.js HTTP','未覆盖','需要客户端及子进程侧请求埋点；TCP采样不能还原HTTPS接口路径。'],
    ['IPC / 命名管道','未覆盖','属于本机进程间通信；不计入对后端HTTP请求量。']
  ].map(([type,state,boundary])=>({type,state,boundary}));
}
