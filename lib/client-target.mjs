export function isMobileWorkPage(value) {
  try {
    const url=new URL(value);
    return url.protocol==='mobilework-shell:'&&url.hostname==='app'&&url.pathname==='/index.html'
      ||url.protocol==='file:'&&/\/MobileWork\/resources\/app-dist\/index\.html$/i.test(url.pathname);
  } catch { return false; }
}
