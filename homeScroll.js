// Shared preferences and bounded scroll tracking for native Home refreshes.
(() => {
  if (globalThis.YomikuiHomeScroll) return;

  const getMode = settings => settings?.homeRefreshPosition === 'preserve' ? 'preserve' : 'top';
  const recommended = tab => ['おすすめ', 'お勧め', 'foryou'].includes(
    (tab?.getAttribute('aria-label') || tab?.textContent || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(),
  );
  const primary = () => document.querySelector('[data-testid="primaryColumn"]');
  const articles = () => [...primary()?.querySelectorAll('article[data-testid="tweet"]') ?? []];
  const tweetId = article => (article.querySelector('time')?.closest('a[href*="/status/"]') ??
    article.querySelector('a[href*="/status/"]'))?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
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
    return settings?.columnType === 'home' && !settings.isLiveFeedColumn &&
      window.location.pathname.replace(/\/$/, '') === '/home' && !document.hidden &&
      !document.querySelector('[role="dialog"]') && recommended(primary()?.querySelector('[role="tab"][aria-selected="true"]'));
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

  globalThis.YomikuiHomeScroll = Object.freeze({ getMode, isNewPostsButton, Tracker, clickWithHeaderLayout, SettingsControl });
})();
