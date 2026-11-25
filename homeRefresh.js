// Shared by the dashboard and native X frames. No timeline API calls are made.
(() => {
  if (globalThis.YomikuiHomeRefresh) return;

  const PREFIX = 'yomikui-home-refresh-';
  const PROBE = PREFIX + 'probe';
  const READY = PREFIX + 'ready';
  const REQUEST = PREFIX + 'request';
  const RESULT = PREFIX + 'result';
  const RELOADING = PREFIX + 'reloading';
  const CANCEL = PREFIX + 'cancel';
  const NAVIGATE = PREFIX + 'navigate';
  const NAVIGATED = PREFIX + 'navigated';
  const SCROLL = PREFIX + 'scroll';
  const DESCRIBE = PREFIX + 'describe';
  const CONTEXT = PREFIX + 'context';
  const COOLDOWN = 5000;
  const COLUMN_INTERVAL_MS = 400;
  const FRAME_TIMEOUT = 12000;
  const REQUEST_TIMEOUT = 11000;
  const RELOAD_TIMEOUT = 20000;
  const TAB_READY_TIMEOUT = 4000;
  const SCROLL_TOP_TIMEOUT = 1200;
  const NEW_POSTS_WAIT = 600;
  const UPDATE_TIMEOUT = 5000;
  const HOME_REQUEST_TIMEOUT = TAB_READY_TIMEOUT + 2 * (SCROLL_TOP_TIMEOUT + NEW_POSTS_WAIT + UPDATE_TIMEOUT) + 1000;
  const HIGH_TWEET_LOAD_COUNT = 100;
  const RELOAD_KEY = 'yomikui_page_refresh_v1:';
  const TIMELINE_MUTATIONS = {
    childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'href'],
  };
  const BANNER_MUTATIONS = {
    ...TIMELINE_MUTATIONS,
    characterData: true,
    attributeFilter: [
      ...TIMELINE_MUTATIONS.attributeFilter, 'aria-label', 'aria-disabled', 'disabled', 'aria-hidden', 'hidden', 'class', 'style',
    ],
  };
  let frameWheel = null;
  const REASONS = {
    'not-home': '更新対象以外のページを表示中',
    following: '更新対象以外のタブを表示中',
    unavailable: '更新用のタブを確認できませんでした',
    draft: '投稿を入力中',
    dialog: 'ダイアログを表示中',
    hidden: 'タブが非表示になりました',
    cooldown: '続けての更新を待機',
    busy: '別の更新を処理中',
    cancelled: '更新を中止しました',
    timeout: '列の応答を確認できませんでした',
    error: '更新操作に失敗しました',
    'target-changed': '対象の表示内容・表示範囲が変わりました',
    'reload-unavailable': '列の再読み込みを準備できませんでした',
    'scroll-top': '先頭への移動を確認できませんでした',
  };
  const SEARCH_PATH_RE = /^\/search\/?(?:\?|$)/;
  const EXPLORE_PATH_RE = /^\/explore(?:\/tabs\/[\w-]+)?\/?(?:\?|$)/;
  const HOME_PATH_RE = /^\/home\/?(?:\?|$)/;
  const STATUS_KEYS_SET = new Set(['updated', 'reloaded', 'requested', 'skipped', 'failed']);
  const DELIVERED_STATUSES = new Set(['updated', 'reloaded', 'requested']);
  const isNativeColumn = column => globalThis.YomikuiHomeScroll.isReadableColumn(column);
  const refreshable = kind => globalThis.YomikuiHomeScroll.isRefreshableKind(kind);
  const readingKind = getSettings => globalThis.YomikuiHomeScroll.readingKind(getSettings);
  const currentPath = () => window.location.pathname + (window.location.search || '');
  const homeKind = kind => kind === 'recommended' || kind === 'following';
  const hasHighTweetLoad = count => Number.isFinite(count) && count >= HIGH_TWEET_LOAD_COUNT;
  const shouldReload = (kind, highTweetLoad) => globalThis.YomikuiHomeScroll.isReloadRefreshKind(kind, highTweetLoad);
  const reloadKind = path => typeof path !== 'string' ? null :
    SEARCH_PATH_RE.test(path) ? 'search' :
    EXPLORE_PATH_RE.test(path) ? 'explore' : null;
  const reloadPathMatches = (kind, path) => homeKind(kind)
    ? typeof path === 'string' && HOME_PATH_RE.test(path)
    : reloadKind(path) === kind;
  const trustedOrigin = origin => origin === 'https://x.com' || origin === 'https://twitter.com';
  const abortError = () => new DOMException('Refresh cancelled', 'AbortError');
  const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const finish = error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(abortError());
      const timer = setTimeout(() => finish(), ms);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  // Observe only for the duration of a user-requested operation. A quiet page
  // needs no polling, and a busy timeline is scanned at most once per 80 ms.
  function observeUntil(read, timeout, signal, mutations = TIMELINE_MUTATIONS) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      let scanTimer = null;
      let finished = false;
      const finish = (value, error) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(deadline);
        clearTimeout(scanTimer);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value);
      };
      const scan = () => {
        clearTimeout(scanTimer);
        scanTimer = null;
        try {
          const value = read();
          if (value) finish(value);
        } catch (error) { finish(null, error); }
      };
      const cancel = () => finish(null, abortError());
      const observer = new MutationObserver(() => {
        if (scanTimer === null && !finished) scanTimer = setTimeout(scan, 80);
      });
      const deadline = setTimeout(() => {
        // Catch changes made inside the final debounce interval.
        scan();
        finish(null);
      }, timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      observer.observe(document.documentElement, mutations);
      scan();
    });
  }

  function primaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function reloadTabMatches(kind, getSettings) {
    if (homeKind(kind)) return readingKind(getSettings) === kind;
    const href = globalThis.YomikuiHomeScroll.selectedTimelineTab()?.getAttribute('href');
    if (!href) return false;
    try {
      const current = new URL(currentPath(), window.location.origin);
      const tab = new URL(href, window.location.origin);
      if (tab.origin !== current.origin || reloadKind(tab.pathname + tab.search) !== kind) return false;
      const path = current.pathname.replace(/\/$/, '');
      if (kind === 'explore' && path === '/explore') return true;
      if (tab.pathname.replace(/\/$/, '') !== path) return false;
      // Search links can encode spaces differently or omit the default Top
      // filter. Compare their meaning without changing the actual current URL.
      return kind !== 'search' || (tab.searchParams.get('q') === current.searchParams.get('q') &&
        (tab.searchParams.get('f') || 'top') === (current.searchParams.get('f') || 'top'));
    } catch { return false; }
  }

  function unavailableReason(getSettings, target) {
    const settings = getSettings();
    const path = window.location.pathname.replace(/\/$/, '');
    if ((path !== '/home' && !reloadKind(currentPath())) ||
        !isNativeColumn({ type: settings?.columnType, liveFeed: settings?.isLiveFeedColumn }) || settings?.isTimelineColumn) return 'not-home';
    if (document.hidden) return 'hidden';
    const blocked = globalThis.YomikuiHomeScroll.interactionBlockReason();
    if (blocked) return blocked;
    const kind = readingKind(getSettings);
    if (kind && target && kind !== target) return 'target-changed';
    if (kind && !refreshable(kind)) return 'following';
    return null;
  }

  function newPostsButton() {
    const column = primaryColumn();
    if (!column) return undefined;
    for (const button of column.querySelectorAll('button, [role="button"]')) {
      if (globalThis.YomikuiHomeScroll.isNewPostsButton(button)) return button;
    }
    return undefined;
  }

  function isAtTop(scroller) {
    const top = scroller?.scrollTop ?? window.scrollY ?? 0;
    return Number.isFinite(top) && Math.abs(top) <= 1;
  }

  const tweetSignature = () => globalThis.YomikuiHomeScroll.tweetSignature();

  class NativeRefresher {
    constructor({ getSettings, getScroller, isTabRestoring = () => false, isVisible = () => true, boundary = null }) {
      this.getSettings = getSettings;
      this.getScroller = getScroller;
      this.isTabRestoring = isTabRestoring;
      this.isVisible = isVisible;
      this.boundary = boundary;
      this.positions = new globalThis.YomikuiHomeScroll.Tracker({ getSettings, getScroller });
      this.lastAction = -Infinity;
    }

    unavailableReason(target) {
      return !this.isVisible() ? 'hidden' : this.isTabRestoring() ? 'unavailable' : unavailableReason(this.getSettings, target);
    }

    async prepare(signal, target) {
      checkAbort(signal);
      const reason = this.unavailableReason(target);
      if (reason) return reason;
      const path = currentPath();
      let scroller = this.getScroller();
      globalThis.YomikuiHomeScroll.scrollToTop(scroller);
      // Confirm two painted frames at the top as well as X's short settling
      // interval. A stalled/overridden scroll must never turn into a refresh.
      const schedule = window.requestAnimationFrame?.bind(window) ?? (callback => setTimeout(callback, 16));
      const unschedule = window.cancelAnimationFrame?.bind(window) ?? clearTimeout;
      return new Promise((resolve, reject) => {
        let frame = null, paints = 0, settled = false, finished = false;
        const guard = () => currentPath() !== path ? 'target-changed' : this.unavailableReason(target);
        const atTop = () => {
          // Sample the known scroll offset during settling. Resolving all
          // candidate containers is only necessary on replacement or confirmation.
          if (settled || scroller?.isConnected === false) {
            const current = this.getScroller();
            if (current !== scroller) { paints = 0; scroller = current; }
          }
          return isAtTop(scroller);
        };
        const finish = (reason, error) => {
          if (finished) return;
          finished = true;
          unschedule(frame);
          clearTimeout(settleTimer);
          clearTimeout(deadline);
          signal?.removeEventListener('abort', cancel);
          error ? reject(error) : resolve(reason);
        };
        const cancel = () => finish(null, abortError());
        const sample = () => {
          try {
            const reason = guard();
            if (reason) { finish(reason); return; }
            paints = atTop() ? paints + 1 : 0;
            if (settled && paints >= 2) { finish(null); return; }
            frame = schedule(sample);
          } catch (error) { finish(null, error); }
        };
        const settleTimer = setTimeout(() => {
          settled = true;
          try {
            const reason = guard();
            if (reason) finish(reason);
            else if (atTop() && paints >= 2) finish(null);
          } catch (error) { finish(null, error); }
        }, 200);
        const deadline = setTimeout(() => finish('scroll-top'), SCROLL_TOP_TIMEOUT);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        else frame = schedule(sample);
      });
    }

    async prepareForNewPosts(signal, target, guard) {
      const reason = guard() || await this.prepare(signal, target);
      if (reason) return reason;
      const result = await observeUntil(() => {
        const reason = guard();
        if (reason) return { reason };
        if (!isAtTop(this.getScroller())) return { reason: 'scroll-top' };
        return newPostsButton();
      }, NEW_POSTS_WAIT, signal, BANNER_MUTATIONS);
      return result?.reason ?? null;
    }

    click(target, signal) {
      checkAbort(signal);
      this.lastAction = Date.now();
      this.positions.invoking = true;
      try { globalThis.YomikuiHomeScroll.clickWithHeaderLayout(target); }
      finally { this.positions.invoking = false; }
    }

    async refresh(signal, target = readingKind(this.getSettings) ?? 'recommended') {
      checkAbort(signal);
      let reason = this.unavailableReason(target);
      if (reason) return { status: 'skipped', reason };
      if (!homeKind(target)) return { status: 'skipped', reason: 'unavailable' };
      if (Date.now() - this.lastAction < COOLDOWN) return { status: 'skipped', reason: 'cooldown' };

      const path = currentPath();
      const guard = () => currentPath() === path ? this.unavailableReason(target) : 'target-changed';
      const ready = await observeUntil(() => {
        const reason = guard();
        return reason ? { reason } : globalThis.YomikuiHomeScroll.selectedTimelineTab();
      }, TAB_READY_TIMEOUT, signal);
      if (!ready || ready.reason) return { status: 'skipped', reason: ready?.reason ?? 'unavailable' };

      // The position preference belongs to recommendations, not Following.
      const position = target === 'recommended' ? this.positions.begin(signal) : null;
      let updated = false, method;
      try {
        reason = await this.prepareForNewPosts(signal, target, guard);
        if (reason === 'scroll-top') reason = await this.prepareForNewPosts(signal, target, guard);
        checkAbort(signal);
        reason ||= guard();
        if (reason) return { status: 'skipped', reason };
        if (!isAtTop(this.getScroller())) return { status: 'skipped', reason: 'scroll-top' };
        const selected = globalThis.YomikuiHomeScroll.selectedTimelineTab();
        const banner = newPostsButton();
        if (!selected?.isConnected || (!banner && selected.getAttribute('aria-disabled') === 'true')) {
          return { status: 'skipped', reason: 'unavailable' };
        }
        const before = tweetSignature();
        method = banner ? 'new-posts' : 'tab';
        this.positions.request(position, banner ? undefined : 2 * UPDATE_TIMEOUT + 1000);
        this.boundary?.set(this.boundary.snapshot(target));
        this.click(banner ?? selected, signal);
        const checkResult = () => {
          const reason = guard();
          if (reason) return { reason };
          const lateBanner = method === 'tab' ? newPostsButton() : null;
          if (lateBanner && readingKind(this.getSettings) === target) {
            method = 'new-posts';
            this.click(lateBanner, signal);
            return { bannerClicked: true };
          }
          const signature = tweetSignature();
          return signature && signature !== before ? { changed: true } : null;
        };
        let result = await observeUntil(checkResult, UPDATE_TIMEOUT, signal, banner ? TIMELINE_MUTATIONS : BANNER_MUTATIONS);
        if (result?.bannerClicked) result = await observeUntil(checkResult, UPDATE_TIMEOUT, signal);
        if (result?.reason) {
          reason = result.reason;
          return { status: 'requested', method, reason };
        }
        // A click may return the same posts. Never equate no DOM change with
        // "no new posts", and never claim a successful fetch based on click alone.
        updated = !!result?.changed;
        return { status: updated ? 'updated' : 'requested', method };
      } finally {
        if (position) {
          if (signal?.aborted || !method || reason) this.positions.cancel(position);
          else if (!updated) this.positions.finish(position);
        }
      }
    }
  }

  function installFrame(options) {
    if (window.self === window.top) return null;
    let visible = true;
    const boundary = new globalThis.YomikuiRefreshBoundary(options);
    const refresher = new NativeRefresher({ ...options, boundary, isVisible: () => visible });
    const disposePositions = refresher.positions.install();
    const completed = new Map();
    const navigated = new Map();
    let active = null;
    let context = null;
    const bootstrapHash = window.location.hash || '';
    const send = (type, requestId, value = {}) => {
      const origin = options.getOrigin();
      if (trustedOrigin(origin)) window.parent.postMessage({
        type, requestId, columnId: options.getColumnId(), ...value,
      }, origin);
    };
    const reloadKey = RELOAD_KEY + options.getColumnId();
    const clearReload = () => { try { window.sessionStorage.removeItem(reloadKey); } catch {} };
    const finish = (job, result) => {
      if (job.finished) return;
      job.finished = true;
      if (active === job) active = null;
      completed.set(job.id, result);
      if (completed.size > 32) completed.delete(completed.keys().next().value);
      if (job.resuming) context?.refresh(true);
      send(RESULT, job.id, result);
    };
    const failure = error => ({
      status: error.name === 'AbortError' ? 'skipped' : 'failed',
      reason: error.name === 'AbortError' ? 'cancelled' : 'error',
    });
    const reloadPage = async (job, kind) => {
      const reason = refresher.unavailableReason(kind);
      if (reason || readingKind(options.getSettings) !== kind || !reloadTabMatches(kind, options.getSettings)) {
        finish(job, { status: 'skipped', reason: reason || 'unavailable' });
        return;
      }
      if (Date.now() - refresher.lastAction < COOLDOWN) {
        finish(job, { status: 'skipped', reason: 'cooldown' });
        return;
      }
      const preparation = await refresher.prepare(job.abort.signal, kind);
      if (preparation || !reloadTabMatches(kind, options.getSettings)) {
        finish(job, { status: 'skipped', reason: preparation || 'target-changed' });
        return;
      }
      // This one-shot receipt survives this column's document replacement. It
      // can only confirm the new display; it never initiates another reload.
      try {
        // X's SPA navigation can drop our settings hash. Keep this column's
        // bootstrap information so contentIframe initializes after the reload,
        // while preserving the actual page path and query string.
        if (!window.location.hash?.includes('yomikui') && bootstrapHash.includes('yomikui')) {
          window.history.replaceState(window.history.state, '', currentPath() + bootstrapHash);
        }
        // A recent tab click may still be waiting to report its selection.
        if (homeKind(kind)) options.reportActiveTab?.();
        window.sessionStorage.setItem(reloadKey, JSON.stringify({
          id: job.id, kind, path: currentPath(), origin: options.getOrigin(), started: Date.now(),
          boundary: boundary.snapshot(kind),
        }));
      } catch {
        finish(job, { status: 'skipped', reason: 'reload-unavailable' });
        return;
      }
      job.reloading = true;
      refresher.lastAction = Date.now();
      send(RELOADING, job.id);
      try { window.location.reload(); }
      catch { clearReload(); finish(job, { status: 'failed', reason: 'error' }); }
    };
    const resumeReload = async (job, receipt) => {
      const result = await observeUntil(() => {
        if (currentPath() !== receipt.path) return { reason: 'target-changed' };
        // Home may briefly show its default tab before the dashboard restores
        // the selected one. Confirm the requested tab and its content together.
        const reason = !visible ? 'hidden' : unavailableReason(options.getSettings, homeKind(receipt.kind) ? undefined : receipt.kind);
        if (reason) return { reason };
        if (!reloadTabMatches(receipt.kind, options.getSettings)) return null;
        const selector = receipt.kind === 'search'
          ? '[data-testid="cellInnerDiv"] a[href], article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="emptyState"]'
          : homeKind(receipt.kind) ? 'article[data-testid="tweet"], [data-testid="emptyState"]'
          : '[data-testid="cellInnerDiv"] a[href], [data-testid="trend"], article[data-testid="tweet"]';
        const content = primaryColumn()?.querySelector(selector);
        return content ? { ready: true } : null;
      }, Math.max(1, RELOAD_TIMEOUT - (Date.now() - receipt.started)), job.abort.signal);
      if (result?.reason) return { status: 'requested', method: 'reload', reason: result.reason };
      if (!result) return { status: 'requested', method: 'reload' };
      globalThis.YomikuiHomeScroll.scrollToTop(options.getScroller());
      if (receipt.boundary?.kind === receipt.kind && receipt.boundary.path === receipt.path) boundary.set(receipt.boundary);
      return { status: 'reloaded', method: 'reload' };
    };
    const validReading = data => globalThis.YomikuiHomeScroll.isReadingAction(data) &&
      (data.group === undefined || refreshable(data.group));
    const beforeReadingMove = () => refresher.positions.cancel();
    const applyReading = ({ mode, deltaY, deltaMode, group }) => {
      if (active) return { status: 'skipped', reason: 'busy' };
      if (!visible) return { status: 'skipped', reason: 'hidden' };
      try {
        return globalThis.YomikuiHomeScroll.navigate({ ...options, mode, deltaY, deltaMode, group, beforeMove: beforeReadingMove });
      } catch { return { status: 'failed', reason: 'error' }; }
    };
    const receiveWheel = (source, data) => {
      const origin = window.location.origin;
      if (source !== window.parent || origin !== options.getOrigin() || !trustedOrigin(origin) || data?.columnId !== options.getColumnId()) return false;
      if (data.mode === 'wheel' && validReading(data)) applyReading(data);
      // The command was handled here even if a guard blocked movement.
      return true;
    };
    const onMessage = event => {
      const data = event.data;
      if (event.source !== window.parent || event.origin !== options.getOrigin() || !trustedOrigin(event.origin) || !data) return;
      if (data.type === 'yomikui-column-visibility') { visible = data.visible === true; context?.setVisible(visible); boundary.setVisible(visible); return; }
      if (data.columnId !== options.getColumnId()) return;
      if (data.type === DESCRIBE) {
        if (context) context.refresh(true);
        else context = new globalThis.YomikuiHomeScroll.ReadingContext({
          getSettings: options.getSettings, visible,
          onChange: kind => send(CONTEXT, null, { kind: active?.resuming ? null : kind }),
        });
        return;
      }
      if (data.type === 'yomikui-settings-update') { context?.schedule(); return; }
      if (typeof data.requestId !== 'string' ||
          data.requestId.length < 1 || data.requestId.length > 100) return;
      if (data.type === NAVIGATE || data.type === SCROLL) {
        const scrolling = data.type === SCROLL;
        if (scrolling !== (data.mode === 'wheel') || !validReading(data)) return;
        if (navigated.has(data.requestId)) { if (!scrolling) send(NAVIGATED, data.requestId, navigated.get(data.requestId)); return; }
        const result = applyReading(data);
        navigated.set(data.requestId, result);
        if (navigated.size > 32) navigated.delete(navigated.keys().next().value);
        if (!scrolling) send(NAVIGATED, data.requestId, result);
        return;
      }
      if (data.type === PROBE) { send(READY, data.requestId); return; }
      if (data.type === CANCEL) {
        if (active?.id === data.requestId) cancel();
        return;
      }
      if (data.type !== REQUEST || !refreshable(data.target)) return;
      if (completed.has(data.requestId)) { send(RESULT, data.requestId, completed.get(data.requestId)); return; }
      if (active) {
        if (active.id !== data.requestId) send(RESULT, data.requestId, { status: 'skipped', reason: 'busy' });
        return;
      }
      const job = { id: data.requestId, abort: new AbortController() };
      active = job;
      // The column may have been reloaded separately since the batch was started.
      const highTweetLoad = data.reload === true && hasHighTweetLoad(options.getTweetCount?.());
      if (shouldReload(data.target, highTweetLoad)) {
        reloadPage(job, data.target).catch(error => finish(job, failure(error)));
      } else {
        refresher.refresh(job.abort.signal, data.target).catch(failure).then(result => finish(job, result));
      }
    };
    const cancel = () => {
      active?.abort.abort();
      if (active?.reloading) { clearReload(); finish(active, { status: 'skipped', reason: 'cancelled' }); }
      refresher.positions.cancel();
    };
    const onPageHide = () => { if (!active?.reloading) cancel(); };
    const onVisibility = () => { if (document.hidden && !active?.reloading) cancel(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    frameWheel = receiveWheel;
    let receipt;
    try {
      const saved = window.sessionStorage.getItem(reloadKey);
      clearReload();
      receipt = JSON.parse(saved);
    } catch {}
    if (receipt && typeof receipt.id === 'string' && receipt.id.length > 0 && receipt.id.length <= 100 &&
        receipt.origin === options.getOrigin() && trustedOrigin(receipt.origin) &&
        refreshable(receipt.kind) && reloadPathMatches(receipt.kind, receipt.path) &&
        Number.isFinite(receipt.started) && Date.now() >= receipt.started && Date.now() - receipt.started < RELOAD_TIMEOUT) {
      const job = { id: receipt.id, abort: new AbortController(), resuming: true };
      active = job;
      resumeReload(job, receipt).catch(failure).then(result => finish(job, result));
    }
    return { dispose() {
      if (frameWheel === receiveWheel) frameWheel = null;
      cancel();
      context?.dispose();
      boundary.dispose();
      disposePositions();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    } };
  }

  class BatchRefresher {
    constructor({ getState, getFrame, getTargets, onChange }) {
      Object.assign(this, { getState, getFrame, getTargets, onChange });
      this.pending = null;
      this.active = null;
      this.timer = null;
      this.cooldownUntil = 0;
      this.view = { phase: 'idle', results: [], total: 0, done: 0 };
      this.onMessage = event => this.receive(event);
      this.onVisibility = () => { if (document.hidden) this.cancel(); };
      this.onPageHide = () => this.cancel();
      window.addEventListener('message', this.onMessage);
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener('visibilitychange', this.onVisibility);
    }

    publish(values) {
      if (this.disposed) return;
      this.view = { ...this.view, ...values };
      this.onChange(this.view);
    }

    syncState() {
      if (!this.active) return;
      const state = this.getState();
      if (state.activeWorkspaceId !== this.active.workspaceId) this.cancel();
      else if (this.pending && !this.pendingIsCurrent()) {
        this.cancelPending('target-changed');
      }
    }

    pendingIsCurrent() {
      const pending = this.pending;
      const frame = this.getFrame(pending.columnId);
      if (pending.frame && (frame?.window !== pending.frame || frame.origin !== pending.origin)) return false;
      // A deliberate reload briefly publishes an unknown kind on pagehide.
      // Keep waiting only while this same column is still readable and visible.
      const column = this.getTargets(pending.reloading ? 'all' : this.active.target)
        .find(column => column.id === pending.columnId);
      return !!column && (column.refreshKind === pending.kind || (pending.reloading && column.refreshKind == null));
    }

    cancelPending(reason = 'cancelled') {
      const pending = this.pending;
      if (!pending) return;
      try { pending.frame?.postMessage({ type: CANCEL, columnId: pending.columnId, requestId: pending.id }, pending.origin); } catch {}
      pending.finish({ status: reason === 'timeout' ? 'failed' : 'skipped', reason });
    }

    cancel() {
      if (!this.active) return;
      this.active.abort.abort();
      this.cancelPending();
    }

    receive(event) {
      const pending = this.pending;
      const data = event.data;
      if (!pending || !data || data.requestId !== pending.id || data.columnId !== pending.columnId ||
          event.source !== pending.frame || event.origin !== pending.origin || !trustedOrigin(event.origin)) return;
      if (data.type === READY && !pending.sent) {
        if (!this.pendingIsCurrent()) {
          this.cancelPending('target-changed');
          return;
        }
        pending.sent = true;
        clearTimeout(pending.deadline);
        pending.deadline = setTimeout(() => {
          this.cancelPending('timeout');
        }, homeKind(pending.kind) ? HOME_REQUEST_TIMEOUT : REQUEST_TIMEOUT);
        try { pending.frame.postMessage({
          type: REQUEST, requestId: pending.id, columnId: pending.columnId, target: pending.kind,
          reload: pending.reload,
        }, pending.origin); } catch { pending.finish({ status: 'failed', reason: 'error' }); }
      } else if (data.type === RELOADING && pending.sent && pending.reload && !pending.reloading) {
        pending.reloading = true;
        clearTimeout(pending.deadline);
        pending.deadline = setTimeout(() => this.cancelPending('timeout'), RELOAD_TIMEOUT + 1000);
      } else if (data.type === RESULT && pending.sent && STATUS_KEYS_SET.has(data.status)) {
        if (data.status === 'reloaded' && !pending.reloading) return;
        if (DELIVERED_STATUSES.has(data.status) && !this.pendingIsCurrent()) {
          pending.finish({ status: 'skipped', reason: 'target-changed' });
          return;
        }
        pending.finish({ status: data.status, method: data.method, reason: data.reason });
      }
    }

    requestColumn(column, signal, highTweetLoad) {
      const columnId = column.id;
      return new Promise(resolve => {
        const pending = {
          id: crypto.randomUUID(), columnId, frame: null, origin: null, sent: false,
          kind: column.refreshKind, reload: shouldReload(column.refreshKind, highTweetLoad),
          reloading: false, deadline: null, poll: null,
        };
        let finished = false;
        pending.finish = result => {
          if (finished) return;
          finished = true;
          clearTimeout(pending.deadline);
          clearTimeout(pending.poll);
          signal.removeEventListener('abort', cancel);
          window.removeEventListener('message', ready);
          if (this.pending === pending) this.pending = null;
          resolve(result);
        };
        const cancel = () => this.cancelPending();
        // A newly mounted frame may not have installed its content script at
        // the first probe. Its existing frame-ready notification permits a
        // fresh probe; neither probe performs an update.
        const ready = event => {
          if (!pending.sent && event.source === pending.frame && event.origin === pending.origin &&
              event.data?.type === 'yomikui-frame-ready' && event.data.columnId === columnId) probe();
        };
        const probe = () => {
          try { pending.frame.postMessage({ type: PROBE, requestId: pending.id, columnId }, pending.origin); }
          catch { pending.finish({ status: 'failed', reason: 'error' }); }
        };
        const find = () => {
          if (finished) return;
          const frame = this.getFrame(columnId);
          if (frame && trustedOrigin(frame.origin)) {
            pending.frame = frame.window;
            pending.origin = frame.origin;
            probe();
          } else pending.poll = setTimeout(find, 100);
        };
        this.pending = pending;
        pending.deadline = setTimeout(() => pending.finish({ status: 'failed', reason: 'timeout' }), FRAME_TIMEOUT);
        signal.addEventListener('abort', cancel, { once: true });
        window.addEventListener('message', ready);
        if (signal.aborted) cancel();
        else find();
      });
    }

    async run({ target = 'all', highTweetLoadIds } = {}) {
      if (this.disposed || this.active || Date.now() < this.cooldownUntil || document.hidden) return;
      if (Array.isArray(target)) target = [...new Set(target)];
      const state = this.getState();
      const columns = this.getTargets(target).filter(column => refreshable(column.refreshKind));
      if (!columns.length) return;
      const job = { abort: new AbortController(), workspaceId: state.activeWorkspaceId, target };
      this.active = job;
      const results = [];
      this.publish({ phase: 'running', results: [], total: columns.length, done: 0 });
      try {
        for (const column of columns) {
          checkAbort(job.abort.signal);
          const current = this.getState();
          let result, nextStart = 0;
          if (!this.getTargets(target).some(item => item.id === column.id && item.refreshKind === column.refreshKind)) {
            result = { status: 'skipped', reason: 'target-changed' };
          } else if (current.columnComposing?.[column.id]) {
            result = { status: 'skipped', reason: 'draft' };
          } else {
            current.markColumnActivity?.(column.id);
            nextStart = Date.now() + COLUMN_INTERVAL_MS;
            result = await this.requestColumn(column, job.abort.signal, highTweetLoadIds?.has(column.id));
          }
          results.push({ columnId: column.id, title: column.title, kind: column.refreshKind, ...result });
          this.publish({ results: [...results], done: results.length });
          const remaining = nextStart - Date.now();
          if (results.length < columns.length && remaining > 0) await delay(remaining, job.abort.signal);
        }
      } catch (error) {
        if (error.name !== 'AbortError') results.push({ status: 'failed', reason: 'error' });
      } finally {
        this.active = null;
        this.cooldownUntil = Date.now() + COOLDOWN;
        this.publish({ phase: job.abort.signal.aborted ? 'cancelled' : 'cooldown', results: [...results], done: results.length });
        if (!this.disposed) this.timer = setTimeout(() => {
          this.timer = null;
          this.publish({ phase: 'idle' });
        }, COOLDOWN);
      }
    }

    dispose() {
      this.disposed = true;
      this.onChange = () => {};
      this.cancel();
      clearTimeout(this.timer);
      window.removeEventListener('message', this.onMessage);
      window.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  function summary(view) {
    if (view.phase === 'running') return `選択中の列を更新中 ${view.done}/${view.total}列`;
    if (view.phase === 'cancelled') return '一括更新を中止しました';
    if (!view.results.length) return '';
    let updated = 0, reloaded = 0, unconfirmedReloads = 0, unconfirmedUpdates = 0, skipped = 0, failed = 0;
    const skippedReasons = new Set();
    for (const result of view.results) {
      if (result.status === 'updated') updated++;
      else if (result.status === 'reloaded') reloaded++;
      else if (result.status === 'requested') {
        if (result.method === 'reload') unconfirmedReloads++;
        else unconfirmedUpdates++;
      } else if (result.status === 'skipped') {
        skipped++;
        if (REASONS[result.reason]) skippedReasons.add(REASONS[result.reason]);
      } else if (result.status === 'failed') failed++;
    }
    const onlySkippedReason = skippedReasons.size === 1 ? skippedReasons.values().next().value : null;
    return [
      updated && `表示更新 ${updated}列`,
      reloaded && `再読み込み ${reloaded}列`,
      unconfirmedReloads && `再読み込み操作済み・表示未確認 ${unconfirmedReloads}列`,
      unconfirmedUpdates && `操作済み・表示変化未確認 ${unconfirmedUpdates}列`,
      skipped && `スキップ ${skipped}列${onlySkippedReason ? `（${onlySkippedReason}）` : ''}`,
      failed && `応答未確認 ${failed}列`,
    ].filter(Boolean).join(' ／ ');
  }

  function formatRefreshDetails(results) {
    if (!results.length) return '';
    return results.map(result => `${result.title || '列'}: ${
      result.status === 'updated' ? '投稿一覧の更新を確認' : result.status === 'reloaded' ? '現在のページの再読み込みと一覧表示を確認' :
        result.status === 'requested' ? result.method === 'reload' ? '再読み込み操作済み・一覧表示未確認' : '更新操作済み・表示変化未確認' : REASONS[result.reason] || '応答未確認'
    }`).join('\n');
  }

  function FloatingControl({ React, jsx, store, columns, frames, origins, highTweetLoadIds, hidden }) {
    const [view, setView] = React.useState({ phase: 'idle', results: [], total: 0, done: 0 });
    const [reading, setReading] = React.useState({ busy: false, results: [], message: '' });
    const [kinds, setKinds] = React.useState({});
    const [workspaceId, setWorkspaceId] = React.useState(() => store.getState().activeWorkspaceId);
    const controller = React.useRef(null);
    const reader = React.useRef(null);
    const onVisibleChange = React.useCallback(ids => { reader.current?.syncVisible(ids); controller.current?.syncState(); }, []);
    const onCancelWheel = React.useCallback(() => reader.current?.clearWheel(), []);
    React.useEffect(() => {
      const getFrame = id => {
        const frame = frames.current.get(id);
        return frame ? { window: frame, origin: origins.current.get(id) ?? window.location.origin } : null;
      };
      const navigation = new globalThis.YomikuiFloatingControls.ReadingController({
        getState: store.getState, getFrame, onChange: setReading,
        onContext: kinds => { setKinds(kinds); controller.current?.syncState(); },
      });
      const batch = new BatchRefresher({
        getState: store.getState,
        getFrame,
        getTargets: target => {
          const kinds = navigation.kinds();
          return navigation.selectedColumns(target, undefined, kinds).map(column => ({ ...column, refreshKind: kinds[column.id] }));
        },
        onChange: setView,
      });
      controller.current = batch;
      reader.current = navigation;
      let prevSyncState = null;
      const sync = () => {
        const state = store.getState();
        const activeWorkspaceId = state.activeWorkspaceId;
        const columns = state.columns;
        const columnComposing = state.columnComposing;
        if (prevSyncState &&
            prevSyncState.activeWorkspaceId === activeWorkspaceId &&
            prevSyncState.columns === columns &&
            prevSyncState.columnComposing === columnComposing) {
          return;
        }
        const workspaceChanged = !prevSyncState || prevSyncState.activeWorkspaceId !== activeWorkspaceId;
        prevSyncState = { activeWorkspaceId, columns, columnComposing };
        navigation.syncState();
        batch.syncState();
        if (workspaceChanged) setWorkspaceId(activeWorkspaceId);
      };
      const unsubscribe = store.subscribe(sync);
      sync();
      return () => { unsubscribe(); batch.dispose(); navigation.dispose(); controller.current = null; reader.current = null; };
    }, [store, frames, origins]);
    React.useEffect(() => { if (hidden) { controller.current?.cancel(); reader.current?.cancel(); } }, [hidden]);
    const details = formatRefreshDetails(view.results);
    return jsx.jsx(globalThis.YomikuiFloatingControls.Panel, {
      React, jsx, columns, view, reading, hidden, kinds, workspaceId, highTweetLoadIds, onVisibleChange, onCancelWheel, canRefresh: columns.some(isNativeColumn), refreshText: summary(view), refreshDetails: details,
      onRefresh: action => {
        if (store.getState().activeWorkspaceId !== workspaceId || reader.current?.active) return;
        reader.current?.clearWheel();
        controller.current?.run({ ...action, highTweetLoadIds });
      },
      onCancelRefresh: () => controller.current?.cancel(),
      onNavigate: action => { if (store.getState().activeWorkspaceId === workspaceId && !controller.current?.active) reader.current?.move(action); },
      onWheel: action => store.getState().activeWorkspaceId === workspaceId && !controller.current?.active && reader.current?.wheel(action) === true,
    });
  }

  globalThis.YomikuiHomeRefresh = Object.freeze({
    NativeRefresher, BatchRefresher, FloatingControl, installFrame, hasHighTweetLoad, summary,
    scrollFrame: (source, data) => frameWheel?.(source, data) === true,
  });
})();
