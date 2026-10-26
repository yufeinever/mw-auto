import test from 'node:test';
import assert from 'node:assert/strict';
import {isMainWindowUrl,mainWindowTargets} from '../lib/main-window.mjs';

test('recognizes current shell and legacy file main windows with routes',()=>{
  for(const url of ['mobilework-shell://app/index.html#/workspace/ws/session/ses', 'mobilework-shell://app/index.html', 'file:///C:/Users/test/AppData/Local/Programs/MobileWork/resources/app-dist/index.html#/workspace/a/session']) assert.equal(isMainWindowUrl(url),true,url);
});
test('rejects embedded websites, lookalike URLs, other shell pages and invalid URLs',()=>{
  for(const url of ['https://example.com/MobileWork/resources/app-dist/index.html','mobilework-shell://other/index.html','mobilework-shell://app/index.html/extra','mobilework-shell://app/plugins/login/index.html','file:///C:/Other/index.html','garbage',undefined]) assert.equal(isMainWindowUrl(url),false,String(url));
});
test('discovery excludes workers and non-debuggable targets and preserves ambiguity',()=>{
  const target={type:'page',url:'mobilework-shell://app/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/test'};
  assert.equal(mainWindowTargets([target,{...target,type:'service_worker'},{...target,webSocketDebuggerUrl:undefined}]).length,1);
  assert.equal(mainWindowTargets([target,target]).length,2);
  assert.deepEqual(mainWindowTargets({}),[]);
});
