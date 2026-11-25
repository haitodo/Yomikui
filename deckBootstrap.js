(() => {
  const deckPath = /^\/yomikui\/status\/0\/?$/;
  if (window === window.top) {
    if (!deckPath.test(window.location.pathname)) return;
  } else {
    // The history list is rendered by the content script on a reserved search URL.
    // Opening a saved post loads a new document, where X handles the detail page.
    const { pathname, search, hash } = window.location;
    if (window.parent !== window.top || !/^\/search\/?$/.test(pathname) ||
        new URLSearchParams(search).get('q') !== 'yomikui-timeline' ||
        !hash.startsWith('#yomikui-cid') || !hash.split('-').includes('tl1')) return;
    try {
      if (!deckPath.test(window.parent.location.pathname)) return;
    } catch { return; }
    globalThis.YomikuiHistorySurface = true;
  }

  // This runs before page scripts, including when X serves cached HTML.
  function blockPageScripts() {
    const root = document.documentElement;
    if (!root) return false;

    const head = document.head ?? root.insertBefore(document.createElement('head'), root.firstChild);
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "script-src 'none'";
    head.prepend(policy);
    return true;
  }

  if (!blockPageScripts()) {
    const observer = new MutationObserver(() => {
      if (blockPageScripts()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
  }
})();
