// Shared preferences and bounded scroll tracking for native Home refreshes.
(() => {
  if (globalThis.YomikuiHomeScroll) return;

  const getMode = settings => settings?.homeRefreshPosition === 'preserve' ? 'preserve' : 'top';
  const recommended = tab => RECOMMENDED_LABELS.has(
    (tab?.getAttribute('aria-label') || tab?.textContent || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(),
  );
  const RECOMMENDED_LABELS = new Set(['おすすめ', 'お勧め', 'foryou']);
  const FOLLOWING_LABELS = new Set(['following', 'フォロー中', 'フォロー']);
  const VALID_DELTA_MODES = new Set([0, 1, 2]);
  const READING_NAV_MODES = new Set(['post', 'page']);
  const STATUS_ID_RE = /\/status\/(\d+)/;
  const primary = () => document.querySelector('[data-testid="primaryColumn"]');
  const READING_TYPES = new Set(['home', 'following', 'notifications', 'explore', 'search', 'bookmarks', 'likes', 'customUrl']);
  const isReadableColumn = column => !!column && !column.liveFeed && READING_TYPES.has(column.type);
  const isReadingAction = ({ direction, mode, deltaY, deltaMode = 0 }) => mode === 'top' ||
    (mode === 'wheel' && Number.isFinite(deltaY) && deltaY !== 0 && VALID_DELTA_MODES.has(deltaMode)) ||
    ((direction === 1 || direction === -1) && READING_NAV_MODES.has(mode));
  const READING_GROUPS = ['recommended', 'following', 'search', 'explore'];
  const REFRESH_KINDS = ['recommended', 'following', 'search', 'explore'];
  const REFRESH_KINDS_SET = new Set(REFRESH_KINDS);
  const isRefreshableKind = kind => REFRESH_KINDS_SET.has(kind);
  const selectedTimelineTab = () => [...primary()?.querySelectorAll('[role="tab"][aria-selected="true"]') ?? []]
    .find(tab => !tab.closest('article, [role="dialog"]'));
  function readingKind(getSettings) {
    const settings = getSettings();
    const path = window.location.pathname.replace(/\/$/, '');
    if (!isReadableColumn({ type: settings?.columnType, liveFeed: settings?.isLiveFeedColumn }) || settings?.isTimelineColumn ||
        /\/status\/\d+|^\/(?:compose|messages)(?:\/|$)|^\/i\/(?:chat|grok)(?:\/|$)/.test(path)) return null;
    if (path === '/search') return 'search';
    if (/^\/explore(?:\/tabs\/[\w-]+)?$/.test(path)) return 'explore';
    if (path !== '/home') return 'other';
    const tab = selectedTimelineTab();
    if (!tab) return null;
    if (recommended(tab)) return 'recommended';
    const label = (tab.getAttribute('aria-label') || tab.textContent || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    return FOLLOWING_LABELS.has(label) ? 'following' : 'other';
  }

  class ReadingContext {
    constructor({ getSettings, onChange, visible = true }) {
      Object.assign(this, { getSettings, onChange, visible });
      this.listeners = [];
      this.kind = undefined;
      this.path = null;
      this.observer = new MutationObserver(records => {
        if (window.location.pathname !== this.path || records.some(record => {
          if (record.type === 'characterData') {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            return !!target?.closest('[role="tab"], [role="tablist"]');
          }
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (target?.closest('[role="tab"], [role="tablist"]')) return true;
          if (record.type !== 'childList' || target?.closest('article')) return false;
          return [...record.addedNodes, ...record.removedNodes].some(node =>
            node.nodeType === 1 && !node.matches('article, [data-testid="cellInnerDiv"]') &&
            (node.matches('[role="tab"], [role="tablist"], [data-testid="primaryColumn"]') ||
              node.querySelector('[role="tab"], [role="tablist"], [data-testid="primaryColumn"]')));
        })) this.schedule();
      });
      const listen = (target, type, callback) => {
        target?.addEventListener(type, callback);
        this.listeners.push(() => target?.removeEventListener(type, callback));
      };
      listen(document, 'visibilitychange', () => this.sync());
      listen(window, 'pagehide', () => { this.pageHidden = true; this.sync(); });
      listen(window, 'pageshow', () => { this.pageHidden = false; this.sync(); });
      for (const type of ['popstate', 'hashchange']) listen(window, type, () => this.schedule());
      for (const type of ['currententrychange', 'navigatesuccess']) listen(window.navigation, type, () => this.schedule());
      this.sync();
    }

    refresh(force = false) {
      if (this.disposed) return;
      this.path = window.location.pathname;
      const kind = this.visible && !document.hidden && !this.pageHidden ? readingKind(this.getSettings) : null;
      if (force || kind !== this.kind) { this.kind = kind; this.onChange(kind); }
    }

    schedule() {
      if (this.disposed || !this.visible || document.hidden || this.pageHidden || this.frame != null) return;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.refresh(); });
    }

    sync() {
      this.observer.disconnect();
      if (this.frame != null) cancelAnimationFrame(this.frame);
      this.frame = null;
      if (this.visible && !document.hidden && !this.pageHidden) this.observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'aria-label'],
      });
      this.refresh(true);
    }

    setVisible(visible) { if (this.visible !== visible) { this.visible = visible; this.sync(); } }

    dispose() {
      this.disposed = true;
      this.observer.disconnect();
      if (this.frame != null) cancelAnimationFrame(this.frame);
      this.listeners.forEach(remove => remove());
    }
  }
  const articles = () => [...primary()?.querySelectorAll('article[data-testid="tweet"]') ?? []];
  const tweetId = article => (article.querySelector('time')?.closest('a[href*="/status/"]') ??
    article.querySelector('a[href*="/status/"]'))?.getAttribute('href')?.match(STATUS_ID_RE)?.[1];
  const signature = () => articles().slice(0, 4).map(tweetId).filter(Boolean).join(',');
  const newPostsPattern = /^(?:show\s+(?:[\d,.]+\s+)?(?:new\s+)?(?:posts?|tweets?)|[\d,]+\s*件の(?:新しい)?(?:ポスト|ツイート)(?:を)?表示|(?:新しい|新着の?)(?:ポスト|ツイート)(?:を)?表示)$/i;

  function isNewPostsButton(button) {
    if (!button || button.closest('article, [role="dialog"], [role="tab"]') || button.disabled ||
        button.getAttribute('aria-disabled') === 'true' || button.closest('[hidden], [aria-hidden="true"]')) return false;
    if (button.checkVisibility && !button.checkVisibility({ visibilityProperty: true })) return false;
    return [button.getAttribute('aria-label'), button.textContent].some(value =>
      value && newPostsPattern.test(value.normalize('NFKC').trim()));
  }

  function isRecommendedHome(settings) {
    return readingKind(() => settings) === 'recommended' && !document.hidden &&
      !document.querySelector('[role="dialog"]');
  }

  // X keeps its header offset even when our CSS hides the tab bar. Give X the
  // original layout only during its synchronous click handler, so it can
  // distinguish a refresh from "go to top". Nothing is painted or persisted.
  function clickWithHeaderLayout(target) {
    const changed = [];
    if (target.getAttribute('role') === 'tab' && window.getComputedStyle) {
      for (let element = target; element && element !== primary(); element = element.parentElement) {
        if (window.getComputedStyle(element).display !== 'none') continue;
        changed.push({ element, style: element.getAttribute('style') });
        element.style.setProperty('display', 'flex', 'important');
        element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    try { target.click(); }
    finally {
      for (const { element, style } of changed) {
        if (style === null) element.removeAttribute('style');
        else element.setAttribute('style', style);
      }
    }
  }

  function scrollToTop(scroller) {
    const options = { top: 0, behavior: 'instant' };
    if (scroller?.scrollTo) scroller.scrollTo(options);
    else if (scroller) scroller.scrollTop = 0;
    else window.scrollTo(options);
  }

  // One explicit reading action, using only the existing rendered timeline.
  // Keep a screenful of a long post readable before advancing to the next one.
  function navigate({ getSettings, getScroller, direction, mode, deltaY, deltaMode = 0, beforeMove }) {
    if (!isReadingAction({ direction, mode, deltaY, deltaMode })) {
      return { status: 'skipped', reason: 'unavailable' };
    }
    const settings = getSettings();
    if (!isReadableColumn({ type: settings?.columnType, liveFeed: settings?.isLiveFeedColumn }) ||
        settings?.isTimelineColumn || /\/status\/\d+|^\/(?:compose|messages)(?:\/|$)|^\/i\/(?:chat|grok)(?:\/|$)/.test(window.location.pathname)) {
      return { status: 'skipped', reason: 'not-timeline' };
    }
    if (document.hidden) return { status: 'skipped', reason: 'hidden' };
    if (document.querySelector('[role="dialog"]')) return { status: 'skipped', reason: 'dialog' };
    for (const editor of document.querySelectorAll(
      '[data-testid^="tweetTextarea_"][contenteditable="true"], textarea[data-testid^="tweetTextarea_"]',
    )) {
      if ((editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent)?.trim()) return { status: 'skipped', reason: 'draft' };
    }
    for (const attachment of document.querySelectorAll('[data-testid="attachments"]')) {
      if (!attachment.closest('article') && attachment.querySelector('img, video, [data-testid="removeMedia"], [data-testid="removeMediaButton"]')) {
        return { status: 'skipped', reason: 'draft' };
      }
    }
    const scroller = getScroller();
    const rootScroller = !scroller || scroller === document.scrollingElement ||
      scroller === document.documentElement || scroller === document.body;
    const wheelScroller = rootScroller ? window : scroller;
    if (mode === 'wheel' && wheelScroller.scrollBy) {
      const itemSelector = readingKind(getSettings) === 'explore'
        ? '[data-testid="cellInnerDiv"] a[href], [data-testid="trend"], article[data-testid="tweet"]'
        : 'article[data-testid="tweet"]';
      if (!primary()?.querySelector(itemSelector)) return { status: 'skipped', reason: 'unavailable' };
      let unit = 1;
      if (deltaMode === 1) unit = parseFloat(window.getComputedStyle?.(scroller ?? document.documentElement).lineHeight) || 16;
      if (deltaMode === 2) {
        const rect = rootScroller ? null : scroller.getBoundingClientRect();
        unit = rootScroller ? window.innerHeight : Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top);
      }
      const amount = deltaY * unit;
      if (!Number.isFinite(amount) || !Number.isFinite(unit) || unit <= 0) return { status: 'skipped', reason: 'unavailable' };
      beforeMove?.();
      // Let the browser clamp a relative scroll. Pixel/line wheel input needs
      // no post bounds, viewport measurement, or readback after moving.
      wheelScroller.scrollBy({ top: amount, behavior: 'instant' });
      return { status: 'moved' };
    }
    const rect = rootScroller ? null : scroller.getBoundingClientRect();
    const height = rootScroller ? window.innerHeight : Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top);
    let posts = articles();
    if (readingKind(getSettings) === 'explore') {
      const cells = [...primary()?.querySelectorAll('[data-testid="cellInnerDiv"]') ?? []]
        .filter(cell => cell.querySelector('a[href], [data-testid="trend"], article[data-testid="tweet"]'));
      posts = cells.length ? cells : [...primary()?.querySelectorAll('[data-testid="trend"]') ?? []];
    }
    if (mode === 'post') posts = posts.filter(article => article.getBoundingClientRect().height > 0);
    const rendered = mode === 'post' ? posts.length > 0 : posts.some(article => article.getBoundingClientRect().height > 0);
    if (!rendered || !Number.isFinite(height) || height <= 0) return { status: 'skipped', reason: 'unavailable' };
    const top = scroller?.scrollTop ?? window.scrollY ?? 0;
    const viewportTop = rootScroller ? 0 : Math.max(0, rect.top);
    const stride = height * .8;
    const extent = scroller?.scrollHeight ?? document.documentElement.scrollHeight;
    const limit = Math.max(0, extent - (rootScroller ? window.innerHeight : scroller.clientHeight));
    let next = mode === 'top' ? 0 : top + direction * stride;
    if (mode === 'wheel') {
      const lineHeight = deltaMode === 1 ? parseFloat(window.getComputedStyle?.(scroller ?? document.documentElement).lineHeight) || 16 : 1;
      next = top + deltaY * (deltaMode === 2 ? height : lineHeight);
    }
    if (mode === 'post') {
      const anchors = posts.map(post => top + post.getBoundingClientRect().top - viewportTop).sort((a, b) => a - b);
      if (direction > 0) {
        const anchor = anchors.find(value => value > top + 4);
        if (anchor !== undefined) next = Math.min(next, anchor);
      } else {
        const anchor = anchors.filter(value => value < top - 4).at(-1);
        next = anchor === undefined ? Math.max(0, next) : Math.max(next, anchor);
      }
    }
    next = Math.max(0, Math.min(limit, next));
    if (!Number.isFinite(next)) return { status: 'skipped', reason: 'unavailable' };
    beforeMove?.();
    const atEdge = mode === 'wheel' ? next === top : Math.abs(next - top) < 1;
    // Direct input also cancels a smooth step that has not painted yet.
    if (atEdge && mode !== 'top' && mode !== 'wheel') return { status: 'edge' };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const options = { top: next, behavior: mode === 'top' || mode === 'wheel' || reduced ? 'instant' : 'smooth' };
    if (mode === 'top') scrollToTop(scroller);
    else if (scroller?.scrollTo) scroller.scrollTo(options);
    else if (scroller && !rootScroller) scroller.scrollTop = next;
    else window.scrollTo(options);
    return { status: atEdge ? 'edge' : 'moved' };
  }

  class Tracker {
    constructor({ getSettings, getScroller }) {
      this.getSettings = getSettings;
      this.getScroller = getScroller;
    }

    begin(signal) {
      this.cancel();
      const scroller = this.getScroller();
      const anchors = articles().map(article => ({ article, id: tweetId(article), rect: article.getBoundingClientRect() }))
        .filter(({ id, rect }) => id && rect.bottom > 0 && rect.top < (window.innerHeight ?? Infinity))
        .map(({ id, rect }) => ({ id, top: rect.top }));
      const job = {
        mode: getMode(this.getSettings()), top: scroller?.scrollTop ?? window.scrollY ?? 0,
        anchors, signal, changed: false, requested: false, applying: false, timers: new Set(),
      };
      this.job = job;
      job.cancel = () => this.cancel(job);
      job.input = event => {
        if (event.type !== 'keydown' || ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape'].includes(event.key)) job.cancel();
      };
      for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) window.addEventListener(type, job.input, { capture: true, passive: true });
      signal?.addEventListener('abort', job.cancel, { once: true });
      if (signal?.aborted) job.cancel();
      return job;
    }

    request(job = this.job) {
      if (this.job !== job || !job || job.requested) return;
      job.requested = true;
      job.signature = signature();
      job.observer = new MutationObserver(() => {
        if (!isRecommendedHome(this.getSettings())) { job.cancel(); return; }
        const next = signature();
        if (next && next !== job.signature) {
          job.signature = next;
          job.changed = true;
        }
        if (job.changed) this.schedule(job);
      });
      job.observer.observe(primary(), { childList: true, subtree: true });
      job.scroll = () => { if (job.changed && !job.applying) this.schedule(job); };
      window.addEventListener('scroll', job.scroll, { capture: true, passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        job.resize = new ResizeObserver(() => { if (job.changed) this.schedule(job); });
        job.resize.observe(primary());
      }
      this.later(job, () => this.finish(job), 6000);
    }

    later(job, callback, ms) {
      const timer = setTimeout(() => { job.timers.delete(timer); if (this.job === job) callback(); }, ms);
      job.timers.add(timer);
    }

    schedule(job) {
      if (this.job !== job || job.pending) return;
      job.pending = true;
      this.later(job, () => {
        job.pending = false;
        this.apply(job);
      }, 0);
      if (!job.settling) {
        job.settling = true;
        this.later(job, () => this.finish(job), 1200);
      }
    }

    apply(job) {
      if (this.job !== job) return;
      if (!isRecommendedHome(this.getSettings()) || getMode(this.getSettings()) !== job.mode) { job.cancel(); return; }
      const scroller = this.getScroller();
      const current = scroller?.scrollTop ?? window.scrollY ?? 0;
      let top = 0;
      if (job.mode === 'preserve') {
        const present = new Map(articles().map(article => [tweetId(article), article]));
        const anchor = job.anchors.find(item => present.has(item.id));
        top = anchor ? current + present.get(anchor.id).getBoundingClientRect().top - anchor.top : job.top;
      }
      if (Math.abs(current - top) < 1) return;
      job.applying = true;
      try {
        if (scroller) scroller.scrollTop = Math.max(0, top);
        else window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      } finally { job.applying = false; }
    }

    finish(job = this.job) {
      if (this.job !== job || !job) return;
      this.apply(job);
      this.cancel(job);
    }

    cancel(job = this.job) {
      if (!job || this.job !== job) return;
      this.job = null;
      job.observer?.disconnect();
      job.resize?.disconnect();
      job.timers.forEach(clearTimeout);
      for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) window.removeEventListener(type, job.input, true);
      if (job.scroll) window.removeEventListener('scroll', job.scroll, true);
      job.signal?.removeEventListener('abort', job.cancel);
    }

    install() {
      const onClick = event => {
        if (this.invoking || !isRecommendedHome(this.getSettings())) return;
        const target = event.target?.closest?.('[role="tab"], button, [role="button"]');
        if (!target || target.closest('article, [role="dialog"]')) return;
        if ((target.getAttribute('role') === 'tab' && recommended(target)) || isNewPostsButton(target)) this.request(this.begin());
      };
      const onVisibility = () => { if (document.hidden) this.cancel(); };
      const cancel = () => this.cancel();
      document.addEventListener('click', onClick, true);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', cancel);
      return () => {
        this.cancel();
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', cancel);
      };
    }
  }

  function SettingsControl({ column, onChange, jsx, t }) {
    if (column.type !== 'home' || column.liveFeed) return null;
    const mode = getMode(column);
    const id = `home-refresh-position-${column.id}`;
    return jsx.jsxs('div', { className: 'flex flex-col gap-2', children: [
      jsx.jsx('label', { htmlFor: id, className: 'text-sm text-foreground', children: t('column_settings_home_refresh_position') }),
      jsx.jsxs('select', {
        id, value: mode, 'aria-describedby': `${id}-description`,
        className: 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground',
        onChange: event => onChange({ homeRefreshPosition: getMode({ homeRefreshPosition: event.currentTarget.value }) }),
        children: [
          jsx.jsx('option', { value: 'top', children: t('column_settings_home_refresh_top') }),
          jsx.jsx('option', { value: 'preserve', children: t('column_settings_home_refresh_preserve') }),
        ],
      }),
      jsx.jsx('p', { id: `${id}-description`, className: 'text-xs text-muted-foreground', children: t(`column_settings_home_refresh_${mode}_desc`) }),
    ] });
  }

  globalThis.YomikuiHomeScroll = Object.freeze({ getMode, isNewPostsButton, Tracker, clickWithHeaderLayout, SettingsControl, isReadableColumn, isReadingAction, readingKind, ReadingContext, READING_GROUPS, REFRESH_KINDS, isRefreshableKind, navigate, scrollToTop, selectedTimelineTab, tweetId, isRecommendedTab: recommended });
})();
