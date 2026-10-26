import fs from 'node:fs/promises';
import { loadPlaywright } from './dependencies.mjs';
import { reportProgress } from './worker.mjs';
import { isMainWindowUrl } from './main-window.mjs';

export class Blocked extends Error { constructor(message) { super(message); this.name = 'Blocked'; this.failureKind='precondition'; } }
export function assert(value, message) { if (!value) throw Object.assign(new Error(message),{failureKind:'assertion'}); }
export function stage(ctx, name) { ctx.stage=name; ctx.diagnostics??=[]; ctx.diagnostics.push({stage:name,at:new Date().toISOString()}); reportProgress({stage:name}); }
export async function attach() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 7000 });
  const pages = browser.contexts().flatMap(c => c.pages()).filter(p => isMainWindowUrl(p.url()));
  if (pages.length!==1) { await browser.close(); throw new Blocked('未找到唯一 MobileWork 主窗口，请检查本机 9223 CDP'); }
  const [page]=pages;
  page.setDefaultTimeout(8000);
  return { browser, page };
}
export async function dismiss(page) {
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  // The case preview does not consistently handle Escape in this MW build.
  // Close only this identified preview, never arbitrary confirmation dialogs.
  const preview=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'效果预览',exact:true})}).filter({visible:true}).first();
  if(await preview.isVisible()){
    const close=preview.getByRole('button',{name:'关闭',exact:true});
    if(await close.isVisible()){await close.click();await preview.waitFor({state:'hidden'});}
  }
}
export function button(page, name) { return page.getByRole('button', { name, exact: typeof name === 'string' }).filter({visible:true}).first(); }
export async function available(locator, message) { if (!await locator.isVisible().catch(() => false)) throw new Blocked(message); return locator; }
export async function paint(page) { await page.evaluate(() => new Promise((resolve,reject) => {
  const timer=setTimeout(()=>reject(new Error('等待渲染帧超时')),3000);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));
})); }

// The clock lives in the renderer. Tool transport and Playwright polling are not the timer.
// End: scripted visible/state assertion remains true for two rendering opportunities.
export async function measure(ctx, action, predicate, label, {timeoutMs=10000}={}) {
  stage(ctx,`计时：${label}`);
  const { page } = ctx;
  const setup = await page.evaluate(({ predicate, timeoutMs }) => {
    window.__mwLocalMeasurement?.cancel?.();
    const test = new Function(`return (${predicate})`)();
    try { if (test()) return { alreadySatisfied: true }; } catch {}
    let start = null, done = false, consecutive = 0, raf;
    const record = { label: '', startedAt: null, durationMs: null, complete: false };
    const onStart = e => { if (start === null) { start = performance.now(); record.startedAt = start; record.event = e.type; } };
    for (const name of ['pointerdown', 'input', 'keydown']) document.addEventListener(name, onStart, true);
    const cancel = () => { done = true; cancelAnimationFrame(raf); for (const n of ['pointerdown','input','keydown']) document.removeEventListener(n, onStart, true); };
    window.__mwLocalMeasurement = { record, cancel };
    const tick = () => {
      if (done) return;
      if (start !== null) {
        let yes = false; try { yes = !!test(); } catch {}
        consecutive = yes ? consecutive + 1 : 0;
        if (consecutive >= 2) { record.durationMs = +(performance.now() - start).toFixed(2); record.complete = true; cancel(); return; }
        if (performance.now() - start > timeoutMs) { record.timeout = true; cancel(); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }, { predicate, timeoutMs });
  if (setup?.alreadySatisfied) throw new Blocked(`${label}：操作前终态已成立，跳过无效计时`);
  await action();
  await page.waitForFunction(() => window.__mwLocalMeasurement?.record.complete || window.__mwLocalMeasurement?.record.timeout, null, { timeout: timeoutMs+2000 });
  const result = await page.evaluate(() => window.__mwLocalMeasurement.record);
  if (!result.complete) {
    const diagnostic=await page.evaluate(()=>{
      const visible=e=>!!e?.getClientRects().length;
      const q=window.__mwQA||{visible},root=q.main?.()||[...document.querySelectorAll('main')].find(visible);
      const state={routeKind:/\/session\/[^/]+$/.test(location.hash)?'history':/\/session$/.test(location.hash)?'new-task':'other',visibleEditors:[...document.querySelectorAll('[role="textbox"]')].filter(visible).length,fontState:document.fonts.status};
      if(!root)return state;
      return {...state,visiblePendingImages:Array.from(root.querySelectorAll('img')).filter(e=>q.visible(e)&&(!e.complete||!e.naturalWidth)).length,finiteAnimations:root.getAnimations({subtree:true}).filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).length,visibleLoading:Array.from(root.querySelectorAll('p,span,div')).filter(e=>q.visible(e)&&/^正在加载|^加载中[.…]|^正在下载/.test(e.textContent.trim())&&e.textContent.trim().length<70).length};
    });
    if(diagnostic){ctx.limitations??=[];ctx.limitations.push('计时终态诊断：'+JSON.stringify(diagnostic));}
    throw new Error(`${label}：终态断言在 ${timeoutMs/1000} 秒内未满足`);
  }
  result.label = label;
  result.method = 'renderer-input-event-to-two-animation-frames';
  result.scope = '当前已运行进程的热态交互；两帧状态稳定，不等同像素级整页完成';
  ctx.measurements.push(result);
  return result;
}

export async function screenshot(page, file, region) {
  await (region || page).screenshot({ path: file, timeout: 5000 }).catch(() => {});
}
export async function json(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
