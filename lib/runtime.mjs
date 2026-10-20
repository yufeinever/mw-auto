import fs from 'node:fs/promises';
import { loadPlaywright } from './dependencies.mjs';

export class Blocked extends Error { constructor(message) { super(message); this.name = 'Blocked'; } }
export function assert(value, message) { if (!value) throw new Error(message); }
export async function attach() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 7000 });
  const page = browser.contexts().flatMap(c => c.pages()).find(p => /MobileWork\/resources\/app-dist\/index\.html/i.test(p.url()));
  if (!page) { await browser.close(); throw new Blocked('未找到 MobileWork 主窗口，请开启本机 9223 CDP'); }
  page.setDefaultTimeout(8000);
  return { browser, page };
}
export async function dismiss(page) { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); }
export function button(page, name) { return page.getByRole('button', { name, exact: typeof name === 'string' }).first(); }
export async function available(locator, message) { if (!await locator.isVisible().catch(() => false)) throw new Blocked(message); return locator; }
export async function paint(page) { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }

// The clock lives in the renderer. Tool transport and Playwright polling are not the timer.
// End: scripted visible/state assertion remains true for two rendering opportunities.
export async function measure(ctx, action, predicate, label, {timeoutMs=10000}={}) {
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
      const q=window.__mwQA,root=q?.main();if(!root)return null;
      return {fontState:document.fonts.status,visiblePendingImages:Array.from(root.querySelectorAll('img')).filter(e=>q.visible(e)&&(!e.complete||!e.naturalWidth)).length,finiteAnimations:root.getAnimations({subtree:true}).filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).length,visibleLoading:Array.from(root.querySelectorAll('p,span,div')).filter(e=>q.visible(e)&&/^正在加载|^加载中[.…]|^正在下载/.test(e.textContent.trim())&&e.textContent.trim().length<70).length};
    });
    if(diagnostic)ctx.limitations.push('计时终态诊断：'+JSON.stringify(diagnostic));
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
