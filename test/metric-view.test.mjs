import test from 'node:test';
import assert from 'node:assert/strict';
import {metricRows,compareMetric,shortLabel} from '../public/metric-view.js';
const spec={id:'MW-UI-006',hotSeconds:.2,coldSeconds:3};
const result=(durationMs=200)=>({functional:'pass',measurements:[{label:'load',durationMs,complete:true,targetRelation:'direct',iteration:2}],repetition:{planned:2,completed:2},statistics:[{label:'load',sampleCount:1,durationMs,valuesMs:[durationMs]}]});
test('compares the exact second execution against its own mode target including equality',()=>{
  for(const [ms,text] of [[0,'达标'],[199.9,'达标'],[200,'达标'],[200.1,'超标']]){
    const r=result(ms),row=metricRows(r)[0],comparison=compareMetric(spec,r,row);
    assert.equal(row.durationMs,ms);assert.equal(comparison.text,text);assert.equal(comparison.targetMs,200);
  }
});
test('missing targets, incomplete samples and failures never become a pass or zero',()=>{
  const r=result();
  assert.equal(compareMetric({...spec,hotSeconds:null},r,metricRows(r)[0]).text,'未设目标');
  const incomplete={...r,statistics:[{...r.statistics[0],sampleCount:0}]};
  assert.equal(metricRows(incomplete)[0].durationMs,null);assert.equal(compareMetric(spec,incomplete,metricRows(incomplete)[0]).text,'未测');
  for(const functional of ['failed','blocked','interrupted'])assert.equal(compareMetric(spec,{...r,functional},metricRows(r)[0]).text,'未完成');
});
test('supporting timings distinguish reviewed reference comparison from incompatible scenarios',()=>{
  const r=result(343.6);r.measurements[0].targetRelation='supporting';r.measurements[0].label=r.statistics[0].label='工作任务区查看更多至全部记录挂载';
  const row=metricRows(r)[0];
  assert.equal(compareMetric({...spec,id:'MW-UI-004'},r,row).text,'参考超标');
  assert.equal(compareMetric(spec,r,row).text,'仅记录');
  r.assessment={policy:'visible-ui-completion-v1'};assert.equal(compareMetric(spec,r,row).text,'参考超标');
  row.label='点击历史任务至详情和输入区就绪';
  const mismatch=compareMetric({...spec,id:'MW-UI-004'},r,row);assert.equal(mismatch.text,'不适用');assert.equal(mismatch.targetMs,null);
});
test('pending download definitions and changed mappings do not borrow inappropriate targets',()=>{
  const r=result(15000),row=metricRows(r)[0];
  for(const id of ['MW-UI-036','MW-UI-037'])assert.equal(compareMetric({...spec,id,installFlowTiming:id==='MW-UI-036'},r,row).text,'待确认');
  assert.equal(compareMetric({...spec,id:'MW-UI-018'},r,row,'cold').text,'不适用');
});
test('shared cold operation shows the cold target without claiming independent cold performance',()=>{
  const r=result(100),row=metricRows(r,'cold')[0],c=compareMetric(spec,r,row,'cold');
  assert.equal(c.targetMs,3000);assert.equal(c.text,'仅记录');
});
test('legacy averages remain traceable, short labels keep full descriptions out of the table',()=>{
  const r={...result(),repetition:{planned:3},statistics:[{label:'load',sampleCount:2,meanMs:25,valuesMs:[20,30]}]};
  const row=metricRows(r)[0];assert.equal(row.durationMs,25);assert.equal(row.history,true);assert.match(row.note,/历史第2、3轮均值/);
  assert.equal(shortLabel('工作任务区查看更多至全部记录挂载'),'任务列表');
  assert.equal(shortLabel('点击历史任务至详情和输入区就绪'),'任务详情');
});
