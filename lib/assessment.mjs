// Only reviewed UI completion checks qualify. Missing or substituted scenarios
// (013/018/037/045) deliberately have no rule. Raw historical runs stay intact.
export const ASSESSMENT_POLICY='visible-ui-completion-v1';
const definitions=[
  [5,'工作空间列表已展示，展开/收起完成','展开工作空间区至空间标题就绪'],
  [6,'首页右侧首屏、输入区及可视资源就绪','进入首页至右侧首屏和输入区就绪'],
  [7,'筛选操作完成，列表展示筛选结果','筛选执行成功至任务列表更新就绪'],
  [12,'新任务界面和输入区加载完成，已测控件可交互','新建任务页进入至输入区及有限动画就绪'],
  [19,'历史任务界面及输入区加载完成','点击历史任务至详情和输入区就绪'],
  [20,'会话搜索响应完成，明确展示结果或空态','搜索无匹配结果呈现'],
  [25,'历史提问弹层加载完成，允许明确空态','打开历史提问至浮层记录或明确空态就绪'],
  [26,'历史会话首屏内容及可视资源加载完成','点击历史任务至首屏消息及界面就绪'],
  [27,'专家市场首屏及可视资源加载完成','专家市场进入至首屏内容就绪'],
  [29,'专家分类选中变化，分类结果界面就绪','分类切换至党建结果就绪'],
  [31,'召唤后跳回任务界面，目标专家回显','召唤专家至新任务及目标专家绑定就绪'],
  [32,'技能市场首屏及可视资源加载完成','技能市场进入至首屏内容就绪'],
  [34,'技能分类选中变化，分类结果界面就绪','分类切换至办公结果就绪'],
  [36,'安装动画结束，已安装列表可见且清理完成','点击安装至详情安装流程结束'],
  [38,'工具市场首屏及可视资源加载完成','工具市场进入至首屏内容就绪'],
  [40,'案例库首屏卡片和可视封面加载完成','进入案例库至首屏卡片封面解码就绪'],
  [41,'案例预览弹窗及可视信息加载完成','打开案例预览至详情及可视资源就绪'],
  [42,'案例回放首屏及只读提示加载完成','切换案例回放至只读消息首屏就绪'],
  [46,'自动化列表和操作入口首屏加载完成','进入自动化页至列表及操作入口就绪']
];
const rules=new Map(definitions.map(([row,scope,label])=>['MW-UI-'+String(row).padStart(3,'0'),{scope,label}]));
export function assessResult(result){
  const rule=rules.get(result.id),source=result.sourceFunctional||result.functional;
  const {assessment,...original}=result;
  const unchanged={...original,sourceFunctional:source};
  if(!rule||!['pass','partial'].includes(source)||!['pass','partial'].includes(result.functional))return unchanged;
  const proven=result.restored===true&&!result.cleanupIssues?.length&&!result.reason&&result.assertions?.length>0
    &&!['blocked','failed'].includes(result.originalScenario?.status)
    &&(!result.repetition||result.repetition.completed===result.repetition.planned)
    &&result.measurements?.some(m=>m.label===rule.label&&m.complete===true&&Number.isFinite(m.durationMs)&&m.durationMs>=0);
  if(!proven)return unchanged;
  return {...unchanged,functional:'pass',testability:'automatable',assessment:{policy:ASSESSMENT_POLICY,sourceFunctional:source,status:'pass',scope:rule.scope,
    reason:'按用户确认的加载展示口径，已有终态断言和计时证明界面完成；未核验的业务、离屏资源及独立冷加载保留在范围说明中。'}};
}
export function assessRun(run){
  if(!run)return null;
  return {...run,assessmentPolicy:ASSESSMENT_POLICY,results:run.results.map(item=>{
    const result=assessResult(item),startup=item.coldStart||((item.batchStartupRef?.runId===run.id)?(run.results.find(r=>r.id===item.batchStartupRef.caseId)?.coldStart||run.coldStart):null);
    return startup?{...result,batchStartup:{durationMs:startup.durationMs,launchAt:startup.launchAt,scope:startup.scope,caseId:item.coldStart?item.id:item.batchStartupRef.caseId}}:result;
  })};
}
