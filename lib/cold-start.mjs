import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { attach, Blocked } from './runtime.mjs';

const execFileAsync = promisify(execFile);
export const COLD_ID = 'MW-STARTUP-HOME';
export const executable = path.join(os.homedir(), 'AppData/Local/Programs/MobileWork/MobileWork.exe');
export async function runningMobileWork() {
  const { stdout } = await execFileAsync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name='MobileWork.exe'\" -ErrorAction Stop | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  const ids = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(ids) ? ids : [ids]).filter(Number.isInteger);
}
async function launchMobileWork() {
  await fs.access(executable);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// Only aggregate counts and readiness booleans leave the renderer. No task text
// or account/session data is collected. This measures the initial visible page;
// it deliberately does not click "more" and call that a startup measurement.
export function homepageReadiness() {
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const inViewport=e=>{if(!visible(e))return false;const r=e.getBoundingClientRect();return r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;};
  const main = Array.from(document.querySelectorAll('main')).find(inViewport);
  const home = /^#\/workspace\/[^/]+\/session$/.test(location.hash);
  if (!main || !home || !main.textContent.includes('Mobile熠动，Work智简')) return { ready: false, home,reason:'homepage_not_visible' };
  const heading = document.querySelector('#recent-tasks-heading');
  const tasks = document.querySelector('[data-testid="recent-tasks-scroll"]');
  const spaces = document.querySelector('[data-testid="workspace-scroll"]');
  const editor = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]')).find(visible);
  if (!visible(heading) || !visible(tasks) || !visible(spaces) || !editor) return { ready: false, home,reason:'homepage_regions_not_visible',regions:{heading:visible(heading),tasks:visible(tasks),spaces:visible(spaces),editor:!!editor} };
  const total = Number(heading.textContent.match(/[（(](\d+)/)?.[1] ?? NaN);
  const taskCount = tasks.querySelectorAll('button[data-slot="context-menu-trigger"]').length;
  const spaceCount = spaces.querySelectorAll('[data-workspace-row-header]').length;
  const buttons = Array.from(tasks.querySelectorAll('button'));
  const hasMore = buttons.some(e => visible(e) && /查看更多/.test(e.textContent));
  const tasksReady = Number.isFinite(total) && (total === 0 || taskCount > 0) && (taskCount === total || hasMore);
  const roots = [main, tasks, spaces];
  const loading = roots.some(root => Array.from(root.querySelectorAll('[aria-busy="true"], [role="progressbar"],p,span')).some(e => visible(e) && (e.getAttribute('aria-busy') === 'true' || e.getAttribute('role') === 'progressbar' || /^(正在加载|加载中)[.…]/.test(e.textContent.trim()))));
  const pendingImages=new Set(roots.flatMap(root=>Array.from(root.querySelectorAll('img')).filter(e=>{const r=e.getBoundingClientRect();return visible(e)&&r.bottom>0&&r.top<innerHeight&&(!e.complete||!e.naturalWidth);}))).size;
  const finiteAnimations=new Set(roots.flatMap(root=>root.getAnimations({subtree:true}).filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))).size;
  const resourcesReady=document.fonts.status==='loaded'&&!pendingImages&&!finiteAnimations;
  const ready=tasksReady&&spaceCount>0&&!loading&&resourcesReady;
  return {ready,home,taskCount,taskTotal:Number.isFinite(total)?total:null,spaceCount,hasMore,
    reason:ready?'ready':!tasksReady?'task_data_pending':!spaceCount?'workspace_data_pending':loading?'loading_indicator':!resourcesReady?'resources_pending':'unknown',
    resources:{fontState:document.fonts.status,pendingImages,finiteAnimations,loading}};
}

async function clickInViewport(locator) {
  const index=await locator.evaluateAll(es=>es.findIndex(e=>{
    const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&getComputedStyle(e).visibility!=='hidden';
  }));
  if(index<0)return false;
  await locator.nth(index).click({timeout:3000});return true;
}
export async function prepareHomepage(page,state={actions:new Set()}) {
  const once=async(key,locator)=>{
    if(state.actions.has(key))return false;
    if(!await clickInViewport(locator))return false;
    state.actions.add(key);return true;
  };
  // A narrow/reopened window can have an off-screen sidebar "new task"
  // button and a visible toolbar button with the same accessible name.
  if(await once('sidebar',page.getByRole('button',{name:'展开侧边栏',exact:true})))return;
  const home=await page.evaluate(()=>/^#\/workspace\/[^/]+\/session$/.test(location.hash));
  if(!home && await once('home',page.getByRole('button',{name:'新建任务',exact:true})))return;
  for(const [key,root,content] of [
    ['tasks',page.locator('#recent-tasks-heading'),page.getByTestId('recent-tasks-scroll')],
    ['spaces',page.getByTestId('workspace-section'),page.getByTestId('workspace-scroll')]
  ]) {
    if(!await content.isVisible())await once(key,root.getByRole('button',{name:'展开',exact:true}));
  }
}

export async function runColdStartup({ listProcesses = runningMobileWork, launch = launchMobileWork, connect = attach, prepare=prepareHomepage,
  now = () => performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 60000, alreadyRestarted=false } = {}) {
  if (!alreadyRestarted&&(await listProcesses()).length) throw new Blocked('MobileWork 仍在运行。请从系统托盘右键选择“退出”，不要手动重新打开，然后再次点击冷启动。');
  // The start time precedes process launch and CDP connection, not the first click.
  const launchAt = new Date().toISOString(), start = now();
  if(!alreadyRestarted)await launch();
  let connection, observations, stable = 0,stage='connect',lastErrorType;
  const preparation={actions:new Set()};
  try {
    while (now() - start < timeoutMs) {
      try {
        stage='connect';connection ||= await connect();
        stage='observe';
        observations = await connection.page.evaluate(homepageReadiness);
        stable = observations.ready ? stable + 1 : 0;
        if (stable >= 2) return {
          launchAt:alreadyRestarted?null:launchAt,observedAt:new Date().toISOString(),durationMs:alreadyRestarted?null:+(now() - start).toFixed(1), observations,
          method:alreadyRestarted?'user-confirmed-restart-observed-homepage-ready':'host-before-process-launch-to-observed-homepage-ready',
          scope:alreadyRestarted?'用户确认手动重启，执行器等待首页就绪；未观察启动起点，不记录应用启动耗时；本批首轮按冷启动记录':'应用进程冷启动至首页首屏就绪；保留登录态与磁盘缓存；包含恢复到首页和展开区域的必要操作、CDP 连接和轮询观察开销，为观察到就绪的耗时上界'
        };
        // Observe an already loaded page without clicking anything. Preparation
        // is idempotent and runs only for missing navigation/visible regions;
        // animations, images and data settle while the observer waits.
        if(!observations.ready&&(!observations.home||['homepage_not_visible','homepage_regions_not_visible'].includes(observations.reason))){
          stage='prepare';await prepare(connection.page,preparation);
        }
      } catch(e) {
        lastErrorType=['TimeoutError','Blocked','Error'].includes(e.name)?e.name:'OtherError';
        stable = 0;
        if (connection) await connection.browser.close().catch(() => {});
        connection = null;
      }
      await sleep(100);
    }
    const error=new Error(`冷启动后 ${timeoutMs/1000} 秒内未观察到首页首屏就绪；阶段：${stage}，终态：${observations?.reason||'not_observed'}。没有生成耗时样本。`);
    error.coldDiagnostic={stage,lastErrorType,observations,preparationActions:[...preparation.actions]};throw error;
  } finally {
    if (connection) await connection.browser.close().catch(() => {});
  }
}
