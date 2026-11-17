(() => {
  if (window !== window.top || !/^\/yomikui\/status\/0\/?$/.test(window.location.pathname)) return;

  // X's service worker can serve cached HTML without the header in deckRules.json.
  // Apply the same policy before the page runs scripts in the dashboard document.
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
