// Runs in the renderer without reading or persisting skill descriptions.
export function skillPickerReady() {
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const input=[...document.querySelectorAll('input')].find(e=>visible(e)&&e.placeholder==='输入名称搜索...');
  if(!input||document.fonts.status!=='loaded')return false;
  let root=input.parentElement;
  for(let i=0;i<7&&root;i++,root=root.parentElement){
    if(![...root.querySelectorAll('button')].some(b=>b.textContent.trim()==='添加技能'))continue;
    if(!visible(root)||root.matches('[aria-busy="true"],.animate-spin')||[...root.querySelectorAll('[aria-busy="true"],.animate-spin')].some(visible))return false;
    if([...root.querySelectorAll('img')].some(e=>visible(e)&&(!e.complete||!e.naturalWidth)))return false;
    if(root.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;
    const rows=[...root.querySelectorAll('[role="checkbox"]')];
    return rows.length>0?rows.every(e=>e.querySelector('span.truncate')?.textContent.trim()):/暂无.*技能|没有.*技能/.test(root.textContent);
  }
  return false;
}

export function marketInstallReady() {
  const card=[...document.querySelectorAll('main [role="button"]')].find(e=>[...e.querySelectorAll('p')].some(p=>p.textContent.trim()==='Office办公助手'));
  return !!card?.querySelector('button[aria-label="已安装"]')&&!card.querySelector('button[aria-label="下载中"],button[aria-label="安装中"]');
}
