// One refresh landmark per native column. No scroll polling or extra requests.
(() => {
  if (globalThis.YomikuiRefreshBoundary) return;

  const TWEET = 'article[data-testid="tweet"]';
  const ATTRIBUTE = 'data-yomikui-refresh-boundary';
  const MARKER = 'yomikui-refresh-boundary';
  const STYLE_ID = 'yomikui-refresh-boundary-style';
  const primary = () => document.querySelector('[data-testid="primaryColumn"]');
  const path = () => window.location.pathname + (window.location.search || '');
  const tweetId = tweet => globalThis.YomikuiHomeScroll.tweetId(tweet);

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      ${TWEET}[${ATTRIBUTE}]{position:relative;box-shadow:inset 4px 0 0 #f59e0b}
      ${TWEET}>.${MARKER}{display:block;position:absolute;top:0;left:0;right:0;height:0;margin:0;padding:0;border:0;border-top:3px solid #f59e0b;pointer-events:none;z-index:2}
      ${TWEET}>.${MARKER}>span{display:inline-flex;align-items:center;position:absolute;top:-10px;left:16px;padding:2px 8px;border-radius:9999px;background:#d97706;color:#fff;font:700 11px/14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.45);letter-spacing:.02em}
      ${TWEET}>.${MARKER}>span::before{content:'🔖';margin-right:4px;font-size:11px;line-height:1}
      @media(forced-colors:active){${TWEET}[${ATTRIBUTE}]{box-shadow:inset 4px 0 0 Highlight}${TWEET}>.${MARKER}{border-color:Highlight}${TWEET}>.${MARKER}>span{background:Highlight;color:HighlightText}}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  globalThis.YomikuiRefreshBoundary = class {
    constructor({ getSettings }) {
      this.getSettings = getSettings;
      this.visible = true;
      this.pending = new Set();
      this.listeners = [];
      this.observer = new MutationObserver(records => this.onMutations(records));
      const listen = (target, type, callback) => {
        target?.addEventListener(type, callback);
        this.listeners.push(() => target?.removeEventListener(type, callback));
      };
      listen(document, 'visibilitychange', () => this.sync());
      listen(window, 'pagehide', () => { this.pageHidden = true; this.sync(); });
      listen(window, 'pageshow', () => { this.pageHidden = false; this.sync(); });
      for (const type of ['popstate', 'hashchange']) listen(window, type, () => this.sync());
      for (const type of ['currententrychange', 'navigatesuccess']) listen(window.navigation, type, () => this.sync());
    }

    snapshot(kind) {
      if (globalThis.YomikuiHomeScroll.readingKind(this.getSettings) !== kind) return null;
      const article = primary()?.querySelector(TWEET);
      const id = article && tweetId(article);
      return id ? { id, kind, path: path() } : null;
    }

    set(entry) {
      this.clear();
      if (this.disposed || !entry || typeof entry.id !== 'string' || !/^\d{1,25}$/.test(entry.id) ||
          !globalThis.YomikuiHomeScroll.isRefreshableKind(entry.kind) || entry.path !== path()) return;
      this.entry = { id: entry.id, kind: entry.kind, path: entry.path };
      this.sync();
    }

    sync() {
      if (!this.entry || this.disposed) return false;
      const kind = globalThis.YomikuiHomeScroll.readingKind(this.getSettings);
      if (path() !== this.entry.path || (kind && kind !== this.entry.kind)) { this.clear(); return false; }
      if (!this.visible || document.hidden || this.pageHidden) { this.pause(); return false; }
      if (!this.observing) {
        this.observing = true;
        this.observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'aria-selected'],
        });
        this.pending.add(primary());
        this.schedule();
      }
      return true;
    }

    onMutations(records) {
      if (!this.sync()) return;
      const root = primary();
      if (this.article && !this.article.isConnected) this.removeMarker();
      else if (this.article && this.marker?.parentElement !== this.article) this.pending.add(this.article);
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (record.type === 'attributes') {
          if (record.attributeName === 'href') this.pending.add(target?.closest(TWEET));
        } else {
          const nodes = [...record.addedNodes, ...record.removedNodes];
          // Our own landmark must not keep scheduling new work.
          if (nodes.length && nodes.every(node => node.nodeType === 1 && node.classList.contains(MARKER))) continue;
          const tweet = target?.closest(TWEET);
          if (tweet) this.pending.add(tweet);
          else for (const node of record.addedNodes) {
            if (node.nodeType === 1 && root && (root.contains(node) || node.contains(root))) this.pending.add(node);
          }
        }
      }
      if (this.pending.size) this.schedule();
    }

    schedule() {
      if (this.timer != null) return;
      // Check changed subtrees at most once per 80 ms, even on a busy feed.
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.sync()) return;
        const root = primary();
        if (this.article && (!root?.contains(this.article) || tweetId(this.article) !== this.entry.id)) this.removeMarker();
        if (this.article) { this.pending.clear(); this.mark(this.article); return; }
        const tweets = new Set();
        for (const node of this.pending) {
          if (!node?.isConnected || !root) continue;
          const scope = root.contains(node) ? node : node.contains(root) ? root : null;
          if (!scope) continue;
          if (scope.matches(TWEET)) tweets.add(scope);
          else for (const tweet of scope.querySelectorAll(TWEET)) tweets.add(tweet);
          if (scope === root) break;
        }
        this.pending.clear();
        for (const tweet of tweets) {
          if (tweetId(tweet) === this.entry.id) { this.mark(tweet); break; }
        }
      }, 80);
    }

    mark(article) {
      if (this.article === article && this.marker?.parentElement === article) return;
      this.removeMarker();
      installStyles();
      const marker = document.createElement('span');
      marker.className = MARKER;
      marker.setAttribute('role', 'separator');
      marker.setAttribute('aria-label', '更新前の先頭');
      const label = document.createElement('span');
      label.textContent = '更新前の先頭';
      marker.appendChild(label);
      this.article = article;
      this.marker = marker;
      article.setAttribute(ATTRIBUTE, this.entry.id);
      article.appendChild(marker);
    }

    removeMarker() {
      this.marker?.remove();
      this.article?.removeAttribute(ATTRIBUTE);
      this.marker = null;
      this.article = null;
    }

    pause() {
      this.observer.disconnect();
      this.observing = false;
      clearTimeout(this.timer);
      this.timer = null;
      this.pending.clear();
      this.removeMarker();
    }

    clear() { this.pause(); this.entry = null; }

    setVisible(visible) {
      if (this.visible !== visible) { this.visible = visible; this.sync(); }
    }

    dispose() {
      this.disposed = true;
      this.clear();
      this.listeners.forEach(remove => remove());
      this.listeners = [];
    }
  };
})();
