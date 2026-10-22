const labels={
  '工作任务区查看更多至全部记录挂载':'任务列表',
  '点击历史任务至详情和输入区就绪':'任务详情',
  '展开工作空间区至空间标题就绪':'空间列表',
  '进入首页至右侧首屏和输入区就绪':'首页加载',
  '筛选执行成功至任务列表更新就绪':'筛选',
  '搜索无匹配结果呈现':'搜索',
  '快捷入口切换至代码开发并渲染场景内容':'入口切换',
  '已连接工具的会话选择开关':'工具开关',
  '进入案例库至首屏卡片封面就绪':'案例加载',
  '进入案例库至首屏卡片封面解码就绪':'案例加载',
  '新建任务页进入至输入区及有限动画就绪':'新建任务',
  '切换模式并关闭选择菜单':'模式切换',
  '切换模型并关闭菜单':'模型切换',
  '打开技能弹层至列表加载展示完成':'技能列表',
  '技能选择开关':'技能选择',
  '打开历史提问至浮层记录或明确空态就绪':'历史提问',
  '点击历史任务至首屏消息及界面就绪':'消息加载',
  '专家列表切换至专家团内容就绪':'切至专家团',
  '专家团切回专家内容就绪':'切回专家',
  '专家市场进入至首屏内容就绪':'专家加载',
  '分类切换至党建结果就绪':'分类切换',
  '技能市场进入至首屏内容就绪':'技能市场',
  '技能市场切换至已安装列表':'已安装列表',
  '已安装列表返回技能市场':'返回市场',
  '分类切换至办公结果就绪':'分类切换',
  '案例分类切换至经营管理卡片就绪':'分类切换',
  '市场＋下载至技能安装完成':'下载 / 安装',
  '点击安装至详情安装流程结束':'旧安装流程',
  '工具市场进入至首屏内容就绪':'工具加载',
  '打开案例预览至详情及可视资源就绪':'案例预览',
  '切换案例回放至只读消息首屏就绪':'案例回放',
  '进入自动化页至列表及操作入口就绪':'自动化列表',
  '自动化成功记录进入历史详情':'任务详情'
};
export const shortLabel=label=>labels[label]||(label?.length>10?label.slice(0,8)+'…':label)||'加载';
export const formatMs=value=>Number.isFinite(value)?String(+value.toFixed(2)):'—';
export function metricRows(result,mode='warm'){
  if(!result)return [];
  const samples=result.measurements||[];
  if(mode==='warm'&&result.statistics?.length)return result.statistics.map(s=>{
    const second=result.repetition?.planned===2;
    const expected=second?1:2;
    return {label:s.label,durationMs:s.sampleCount===expected?(second?s.durationMs:s.meanMs):null,
      samples:samples.filter(m=>m.label===s.label),history:!second,
      note:second?'首次预热不计入正式耗时；此处为第2次执行结果，不取均值。':`历史第2、3轮均值；样本：${(s.valuesMs||[]).join(' / ')} ms。`};
  });
  return samples.map(m=>({label:m.label,durationMs:m.durationMs,samples:[m],history:mode==='warm'&&result.sequence!=='cold-then-warm',
    note:mode==='cold'?'本批启动后的第1次操作耗时，不代表该操作的独立冷加载。':result.sequence==='cold-then-warm'?'第2轮热启动，单次实际执行结果，无额外预热。':'历史单次计时。'}));
}
export function compareMetric(spec,result,row,mode='warm'){
  const seconds=mode==='cold'?spec.coldSeconds:spec.hotSeconds;
  const targetMs=Number.isFinite(seconds)?seconds*1000:null;
  const answer=(text,tone,note,target=targetMs)=>({text,tone,note,targetMs:target});
  if(spec.installFlowTiming||result?.timingReview||spec.id==='MW-UI-037')
    return answer('待确认','neutral','原表目标保留供追溯；当前操作的目标适用范围待确认，暂不比较。');
  if((spec.id==='MW-UI-004'&&row?.label==='点击历史任务至详情和输入区就绪')||(spec.id==='MW-UI-018'&&mode==='cold'))
    return answer('不适用','neutral','原表目标对应其他操作，不套用于此项任务详情加载。',null);
  if(targetMs===null)return answer('未设目标','neutral','原表未提供此模式的目标，不借用另一模式的阈值。');
  if(!row||!Number.isFinite(row.durationMs))return answer('未测','neutral','尚无完整有效的计时样本。');
  if(!['pass','partial'].includes(result?.functional)||row.samples.some(m=>m.complete===false))
    return answer('未完成','neutral','执行未成功完成，不判性能达标。');
  if(mode==='cold')return answer('仅记录','neutral','目标为原表冷加载指标；当前样本为共享冷启动后的操作，不直接比较。');
  const supporting=row.samples.some(m=>m.targetRelation==='supporting');
  const reviewed=!!result.assessment||spec.id==='MW-UI-004'&&row.label==='工作任务区查看更多至全部记录挂载';
  if(supporting&&!reviewed)return answer('仅记录','neutral','补充场景与原表目标口径不同，不判达标。');
  const within=row.durationMs<=targetMs;
  return answer((supporting?'参考':'')+(within?'达标':'超标'),within?'good':'bad',
    `${supporting?'补充计时，仅作参考；':''}${within?'低于或等于目标':'超出目标 '+formatMs(row.durationMs-targetMs)+' ms'}。Windows 结果与功能通过状态分别判断。`);
}
