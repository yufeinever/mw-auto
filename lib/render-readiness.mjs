export const RENDER_POLICY='render-surface-v2';

// Executed inside the renderer. Return only states/counts, never business content.
export function installRenderProbe() {
  const visible=e=>{
    if(!e?.getClientRects().length||getComputedStyle(e).visibility==='hidden')return false;
    const r=e.getBoundingClientRect();
    if(r.width<=0||r.height<=0||r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth)return false;
    for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowY)&&(r.bottom<=b.top||r.top>=b.bottom))return false;}
    return true;
  };
  const state=root=>{
    if(!visible(root))return {ready:false,state:'missing'};
    const nodes=[root,...root.querySelectorAll('*')].filter(visible);
    // Short leaf messages avoid interpreting user conversation text as service errors.
    const messages=nodes.filter(e=>!e.children.length&&e.textContent.trim().length<100).map(e=>e.textContent.trim());
    const serviceError=nodes.some(e=>e.getAttribute('role')==='alert'&&/失败|错误|重试|无法|error|failed/i.test(e.textContent))||messages.some(t=>/^(?:网络请求失败|网络连接失败|加载失败|请求失败|资产列表加载失败|无法加载|服务不可用)/.test(t));
    if(serviceError)return {ready:false,state:'error'};
    if(nodes.some(e=>e.getAttribute('aria-busy')==='true'||e.getAttribute('role')==='progressbar'||e.classList.contains('animate-spin'))||messages.some(t=>/^(?:正在加载|加载中|正在下载|正在安装|Loading\b)/i.test(t)))return {ready:false,state:'loading'};
    const images=nodes.filter(e=>e.tagName==='IMG');
    if(images.some(e=>e.complete&&!e.naturalWidth))return {ready:false,state:'resource_error'};
    if(document.fonts.status!=='loaded'||images.some(e=>!e.complete)||root.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return {ready:false,state:'rendering'};
    const empty=messages.some(t=>/^(?:暂无|没有|未找到|未加载|无结果|无匹配|No (?:results|items|skills|tasks))/.test(t));
    return {ready:true,state:empty?'empty':'content'};
  };
  const main=()=>[...document.querySelectorAll('main')].find(visible);
  const popup=()=>[...document.querySelectorAll('[role="dialog"],[data-slot="popover-content"],[role="menu"],[data-slot="dropdown-menu-content"]')].filter(visible).at(-1);
  const text=name=>[...document.querySelectorAll('h1,h2,h3,p,span,button,div')].find(e=>visible(e)&&e.textContent.trim()===name);
  const btn=name=>[...document.querySelectorAll('button')].find(e=>visible(e)&&(e.getAttribute('aria-label')===name||e.textContent.trim()===name));
  window.__mwRender={visible,state,main,popup};
  window.__mwQA={visible,state,main,popup,btn,text,ready:root=>state(root).ready,editor:()=>[...document.querySelectorAll('[role="textbox"]')].find(visible)};
}

export async function installRendering(page){await page.evaluate(installRenderProbe);}

export async function waitSurface(page,selector='main',timeout=15000){
  await installRendering(page);
  await page.waitForFunction(selector=>{
    const q=window.__mwRender,root=[...document.querySelectorAll(selector)].find(q.visible),s=q.state(root);
    return s.ready||['error','resource_error'].includes(s.state);
  },selector,{timeout});
  const state=await page.evaluate(selector=>{const q=window.__mwRender;return q.state([...document.querySelectorAll(selector)].find(q.visible));},selector);
  if(!state.ready)throw Object.assign(new Error('目标区域显示加载/资源错误；未记录为正常渲染完成'),{failureKind:'dependency'});
  return state;
}
