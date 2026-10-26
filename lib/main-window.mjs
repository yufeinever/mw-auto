// Shared by readiness discovery and the actual Playwright connection.
export function isMainWindowUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'mobilework-shell:') return url.hostname === 'app' && url.pathname === '/index.html';
    return url.protocol === 'file:' && /\/MobileWork\/resources\/app-dist\/index\.html$/i.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

export function mainWindowTargets(targets) {
  return Array.isArray(targets) ? targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl && isMainWindowUrl(t.url)) : [];
}
