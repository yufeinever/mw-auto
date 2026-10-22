// Return only readiness/counts. Never persist case text, image URLs or credentials.
export function gallerySnapshot() {
  const root=document.querySelector('main');
  const cards=[...(root?.querySelectorAll('.mw-case-card')||[])];
  const buttons=[...(root?.querySelectorAll('button')||[])];
  const all=buttons.find(e=>e.textContent.trim()==='全部');
  return {
    allSelected:!!all?.className.includes('border-[var(--mw-brand)]'),
    unfiltered:!!root?.querySelector('input[placeholder="请输入关键词查询"]') && !root.querySelector('input[placeholder="请输入关键词查询"]').value,
    allHeading:[...(root?.querySelectorAll('h1,h2,h3,p,span,div')||[])].some(e=>e.textContent.trim()==='全部案例'),
    count:cards.length,
    titled:cards.filter(e=>e.textContent.trim()).length,
    covered:cards.filter(e=>e.querySelector('img')).length,
    images:cards.reduce((n,e)=>n+e.querySelectorAll('img').length,0),
    pendingImages:cards.reduce((n,e)=>n+[...e.querySelectorAll('img')].filter(i=>!i.complete||!i.naturalWidth).length,0),
    continuation:buttons.some(e=>!e.disabled&&/加载更多|下一页|下页/.test(e.textContent+' '+(e.getAttribute('aria-label')||''))) || !!root?.querySelector('[aria-label*="分页"],[aria-label*="pagination"]'),
  };
}

export function galleryComplete(s) {
  return s.allSelected&&s.unfiltered&&s.allHeading&&s.count>0&&s.titled===s.count&&s.covered===s.count&&s.images>=s.count&&s.pendingImages===0&&!s.continuation;
}
