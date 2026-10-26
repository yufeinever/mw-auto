// Runs in the renderer without reading or persisting skill descriptions.
export function skillPickerReady() {
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const input=[...document.querySelectorAll('input')].find(e=>visible(e)&&e.placeholder==='输入名称搜索...');
  if(!input||document.fonts.status!=='loaded')return false;
  let root=input.parentElement;
  for(let i=0;i<7&&root;i++,root=root.parentElement){
    // Popup identity is structural; footer wording differs across client versions.
    if(!root.matches('[data-slot="popover-content"],[role="dialog"]')&&!root.querySelector('[role="checkbox"]')&&![...root.querySelectorAll('button')].some(b=>/^(添加技能|管理技能)$/.test(b.textContent.trim())))continue;
    if(!visible(root)||root.matches('[aria-busy="true"],.animate-spin')||[...root.querySelectorAll('[aria-busy="true"],.animate-spin')].some(visible))return false;
    if([...root.querySelectorAll('img')].some(e=>visible(e)&&(!e.complete||!e.naturalWidth)))return false;
    if(root.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;
    const rows=[...root.querySelectorAll('[role="checkbox"]')];
    if(/正在加载|加载中|加载失败|网络请求失败/.test(root.textContent))return false;
    return rows.length>0?rows.some(visible):/暂无.*技能|没有.*技能|未加载skills|No skills loaded/i.test(root.textContent);
  }
  return false;
}

export function marketInstallReady(name='Office办公助手') {
  const card=[...document.querySelectorAll('main [role="button"]')].find(e=>[...e.querySelectorAll('p')].some(p=>p.textContent.trim()===name));
  return !!card?.querySelector('button[aria-label="已安装"]')&&!card.querySelector('button[aria-label="下载中"],button[aria-label="安装中"]');
}
