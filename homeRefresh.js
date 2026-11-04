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
  const FRAME_TIMEOUT = 12000;
  const REQUEST_TIMEOUT = 11000;
  const RELOAD_TIMEOUT = 20000;
  const RELOAD_KEY = 'yomikui_explore_refresh_v1:';
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
  };
  const isNativeColumn = column => globalThis.YomikuiHomeScroll.isReadableColumn(column);
  const refreshable = kind => globalThis.YomikuiHomeScroll.isRefreshableKind(kind);
  const readingKind = getSettings => globalThis.YomikuiHomeScroll.readingKind(getSettings);
  const currentPath = () => window.location.pathname + (window.location.search || '');
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
  function observeUntil(read, timeout, signal) {
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
      const deadline = setTimeout(() => finish(null), timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-selected', 'href'],
      });
      scan();
    });
  }

  function primaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function unavailableReason(getSettings, target) {
    const settings = getSettings();
    const path = window.location.pathname.replace(/\/$/, '');
    if ((path !== '/home' && !/^\/explore(?:\/tabs\/[\w-]+)?$/.test(path)) ||
        !isNativeColumn({ type: settings?.columnType, liveFeed: settings?.isLiveFeedColumn }) || settings?.isTimelineColumn) return 'not-home';
    if (document.hidden) return 'hidden';
    if (document.querySelector('[role="dialog"]')) return 'dialog';
    // X also prefixes its label and placeholder wrappers with tweetTextarea_.
    // Only the editable control contains draft text; its wrapper can contain
    // "What's happening?" even while the actual editor is empty.
    for (const editor of document.querySelectorAll(
      '[data-testid^="tweetTextarea_"][contenteditable="true"], textarea[data-testid^="tweetTextarea_"]',
    )) {
      const text = editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent;
      if (text?.trim()) return 'draft';
    }
    for (const attachments of document.querySelectorAll('[data-testid="attachments"]')) {
      if (!attachments.closest('article') && attachments.querySelector(
        'img, video, [data-testid="removeMedia"], [data-testid="removeMediaButton"]',
      )) return 'draft';
    }
    const kind = readingKind(getSettings);
    if (kind && target && kind !== target) return 'target-changed';
    if (kind && !refreshable(kind)) return 'following';
    return null;
  }

  function newPostsButton() {
    return [...primaryColumn()?.querySelectorAll('button, [role="button"]') ?? []]
      .find(globalThis.YomikuiHomeScroll.isNewPostsButton);
  }

  function tweetSignature() {
    return [...primaryColumn()?.querySelectorAll('article[data-testid="tweet"]') ?? []]
      .slice(0, 4).map(tweet => {
        const time = tweet.querySelector('time');
        const link = time?.closest('a[href*="/status/"]') ?? tweet.querySelector('a[href*="/status/"]');
        return link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] ?? '';
      }).filter(Boolean).join(',');
  }

  class NativeRefresher {
    constructor({ getSettings, getScroller, isTabRestoring = () => false, isVisible = () => true }) {
      this.getSettings = getSettings;
      this.getScroller = getScroller;
      this.isTabRestoring = isTabRestoring;
      this.isVisible = isVisible;
      this.positions = new globalThis.YomikuiHomeScroll.Tracker({ getSettings, getScroller });
      this.lastAction = -Infinity;
    }

    unavailableReason(target) {
      return !this.isVisible() ? 'hidden' : this.isTabRestoring() ? 'unavailable' : unavailableReason(this.getSettings, target);
    }

    async refresh(signal, target = readingKind(this.getSettings) ?? 'recommended') {
      checkAbort(signal);
      let reason = this.unavailableReason(target);
      if (reason) return { status: 'skipped', reason };
      if (!['recommended', 'following'].includes(target)) return { status: 'skipped', reason: 'unavailable' };
      if (Date.now() - this.lastAction < COOLDOWN) return { status: 'skipped', reason: 'cooldown' };

      const tab = await observeUntil(() => {
        reason = this.unavailableReason(target);
        return reason ? { reason } : globalThis.YomikuiHomeScroll.selectedTimelineTab();
      }, 4000, signal);
      if (tab?.reason) return { status: 'skipped', reason: tab.reason };
      if (!tab) return { status: 'skipped', reason: 'unavailable' };

      // CSS-hidden tab bars remain in the native DOM and can receive click().
      // Refresh only the selected Home tab, without switching or retrying.
      // The position preference belongs to recommendations, not Following.
      const position = target === 'recommended' ? this.positions.begin(signal) : null;
      let updated = false;
      try {
        const scroller = this.getScroller();
        if (scroller) scroller.scrollTop = 0;
        else window.scrollTo({ top: 0, behavior: 'instant' });
        await delay(200, signal);
        reason = this.unavailableReason(target);
        if (reason) return { status: 'skipped', reason };
        const selected = globalThis.YomikuiHomeScroll.selectedTimelineTab();
        if (!selected || selected !== tab || !selected.isConnected || selected.getAttribute('aria-disabled') === 'true') {
          return { status: 'skipped', reason: 'unavailable' };
        }
        const banner = newPostsButton();
        const before = tweetSignature();
        const method = banner ? 'new-posts' : 'tab';
        this.lastAction = Date.now();
        this.positions.request(position);
        this.positions.invoking = true;
        try { globalThis.YomikuiHomeScroll.clickWithHeaderLayout(banner ?? selected); }
        finally { this.positions.invoking = false; }
        const changed = await observeUntil(() => {
          reason = this.unavailableReason(target);
          if (reason) return { reason };
          const signature = tweetSignature();
          return signature && signature !== before ? { changed: true } : null;
        }, 5000, signal);
        if (changed?.reason) return { status: 'requested', method, reason: changed.reason };
        // A click may return the same posts. Never equate no DOM change with
        // "no new posts", and never claim a successful fetch based on click alone.
        updated = !!changed;
        return { status: changed ? 'updated' : 'requested', method };
      } finally {
        if (position) {
          if (signal?.aborted) this.positions.cancel(position);
          else if (!updated) this.positions.finish(position);
        }
      }
    }
  }

  function installFrame(options) {
    if (window.self === window.top) return null;
    let visible = true;
    const refresher = new NativeRefresher({ ...options, isVisible: () => visible });
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
      send(RESULT, job.id, result);
    };
    const failure = error => ({
      status: error.name === 'AbortError' ? 'skipped' : 'failed',
      reason: error.name === 'AbortError' ? 'cancelled' : 'error',
    });
    const reloadExplore = job => {
      const reason = refresher.unavailableReason('explore');
      if (reason || readingKind(options.getSettings) !== 'explore' || !globalThis.YomikuiHomeScroll.selectedTimelineTab()) {
        finish(job, { status: 'skipped', reason: reason || 'unavailable' });
        return;
      }
      if (Date.now() - refresher.lastAction < COOLDOWN) {
        finish(job, { status: 'skipped', reason: 'cooldown' });
        return;
      }
      // This one-shot receipt survives this column's document replacement. It
      // can only confirm the new display; it never initiates another reload.
      try {
        // X's SPA navigation can drop our settings hash. Keep this column's
        // bootstrap information so contentIframe initializes after the reload,
        // while preserving the actual Explore path and query string.
        if (!window.location.hash?.includes('yomikui') && bootstrapHash.includes('yomikui')) {
          window.history.replaceState(window.history.state, '', currentPath() + bootstrapHash);
        }
        window.sessionStorage.setItem(reloadKey, JSON.stringify({
          id: job.id, path: currentPath(), origin: options.getOrigin(), started: Date.now(),
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
        // Explore's URL identifies its tab. Confirm that tab directly instead
        // of waiting for Home's remembered-tab restoration timer to finish.
        const reason = !visible ? 'hidden' : unavailableReason(options.getSettings, 'explore');
        if (reason) return { reason };
        const selected = globalThis.YomikuiHomeScroll.selectedTimelineTab();
        if (!selected) return null;
        const href = selected.getAttribute('href');
        if (window.location.pathname.replace(/\/$/, '') !== '/explore' &&
            (!href || new URL(href, window.location.origin).pathname.replace(/\/$/, '') !== window.location.pathname.replace(/\/$/, ''))) return null;
        const content = primaryColumn()?.querySelector(
          '[data-testid="cellInnerDiv"] a[href], [data-testid="trend"], article[data-testid="tweet"]',
        );
        return content ? { ready: true } : null;
      }, Math.max(1, RELOAD_TIMEOUT - (Date.now() - receipt.started)), job.abort.signal);
      if (result?.reason) return { status: 'requested', method: 'reload', reason: result.reason };
      if (!result) return { status: 'requested', method: 'reload' };
      const scroller = options.getScroller();
      if (scroller) scroller.scrollTop = 0;
      else window.scrollTo({ top: 0, behavior: 'instant' });
      return { status: 'reloaded', method: 'reload' };
    };
    const onMessage = event => {
      const data = event.data;
      if (event.source !== window.parent || event.origin !== options.getOrigin() || !trustedOrigin(event.origin) || !data) return;
      if (data.type === 'yomikui-column-visibility') { visible = data.visible === true; context?.setVisible(visible); return; }
      if (data.columnId !== options.getColumnId()) return;
      if (data.type === DESCRIBE) {
        if (context) context.refresh(true);
        else context = new globalThis.YomikuiHomeScroll.ReadingContext({
          getSettings: options.getSettings, visible, onChange: kind => send(CONTEXT, null, { kind }),
        });
        return;
      }
      if (data.type === 'yomikui-settings-update') { context?.schedule(); return; }
      if (typeof data.requestId !== 'string' ||
          data.requestId.length < 1 || data.requestId.length > 100) return;
      if (data.type === NAVIGATE || data.type === SCROLL) {
        const scrolling = data.type === SCROLL;
        if (scrolling !== (data.mode === 'wheel') || !globalThis.YomikuiHomeScroll.isReadingAction(data) ||
            (data.group !== undefined && !globalThis.YomikuiHomeScroll.READING_GROUPS.includes(data.group))) return;
        if (navigated.has(data.requestId)) { if (!scrolling) send(NAVIGATED, data.requestId, navigated.get(data.requestId)); return; }
        let result;
        try {
          result = active ? { status: 'skipped', reason: 'busy' } : !visible ? { status: 'skipped', reason: 'hidden' } :
            data.group !== undefined && globalThis.YomikuiHomeScroll.readingKind(options.getSettings) !== data.group ? { status: 'skipped', reason: 'target-changed' } :
            globalThis.YomikuiHomeScroll.navigate({ ...options, direction: data.direction, mode: data.mode, deltaY: data.deltaY, deltaMode: data.deltaMode, beforeMove: () => refresher.positions.cancel() });
        } catch { result = { status: 'failed', reason: 'error' }; }
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
      if (data.target === 'explore') reloadExplore(job);
      else refresher.refresh(job.abort.signal, data.target).catch(failure).then(result => finish(job, result));
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
    let receipt;
    try {
      const saved = window.sessionStorage.getItem(reloadKey);
      clearReload();
      receipt = JSON.parse(saved);
    } catch {}
    if (receipt && typeof receipt.id === 'string' && receipt.id.length > 0 && receipt.id.length <= 100 &&
        receipt.origin === options.getOrigin() && trustedOrigin(receipt.origin) &&
        typeof receipt.path === 'string' && /^\/explore(?:\/tabs\/[\w-]+)?\/?(?:\?|$)/.test(receipt.path) &&
        Number.isFinite(receipt.started) && Date.now() >= receipt.started && Date.now() - receipt.started < RELOAD_TIMEOUT) {
      const job = { id: receipt.id, abort: new AbortController() };
      active = job;
      resumeReload(job, receipt).catch(failure).then(result => finish(job, result));
    }
    return { dispose() {
      cancel();
      context?.dispose();
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
        }, REQUEST_TIMEOUT);
        try { pending.frame.postMessage({
          type: REQUEST, requestId: pending.id, columnId: pending.columnId, target: pending.kind,
        }, pending.origin); } catch { pending.finish({ status: 'failed', reason: 'error' }); }
      } else if (data.type === RELOADING && pending.sent && pending.kind === 'explore' && !pending.reloading) {
        pending.reloading = true;
        clearTimeout(pending.deadline);
        pending.deadline = setTimeout(() => this.cancelPending('timeout'), RELOAD_TIMEOUT + 1000);
      } else if (data.type === RESULT && pending.sent && ['updated', 'reloaded', 'requested', 'skipped', 'failed'].includes(data.status)) {
        if (data.status === 'reloaded' && (!pending.reloading || pending.kind !== 'explore')) return;
        if (['updated', 'reloaded', 'requested'].includes(data.status) && !this.pendingIsCurrent()) {
          pending.finish({ status: 'skipped', reason: 'target-changed' });
          return;
        }
        pending.finish({ status: data.status, method: data.method, reason: data.reason });
      }
    }

    requestColumn(column, signal) {
      const columnId = column.id;
      return new Promise(resolve => {
        const pending = {
          id: crypto.randomUUID(), columnId, frame: null, origin: null, sent: false,
          kind: column.refreshKind, reloading: false, deadline: null, poll: null,
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

    async run({ target = 'all' } = {}) {
      if (this.disposed || this.active || Date.now() < this.cooldownUntil || document.hidden) return;
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
          let result;
          if (!this.getTargets(target).some(item => item.id === column.id && item.refreshKind === column.refreshKind)) {
            result = { status: 'skipped', reason: 'target-changed' };
          } else if (current.columnComposing?.[column.id]) {
            result = { status: 'skipped', reason: 'draft' };
          } else {
            current.markColumnActivity?.(column.id);
            result = await this.requestColumn(column, job.abort.signal);
          }
          results.push({ columnId: column.id, title: column.title, kind: column.refreshKind, ...result });
          this.publish({ results: [...results], done: results.length });
          if (results.length < columns.length) await delay(400, job.abort.signal);
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
    const count = status => view.results.filter(result => result.status === status).length;
    const unconfirmedReloads = view.results.filter(result => result.status === 'requested' && result.method === 'reload').length;
    const unconfirmedUpdates = count('requested') - unconfirmedReloads;
    const skippedReasons = [...new Set(view.results.filter(result => result.status === 'skipped')
      .map(result => REASONS[result.reason]).filter(Boolean))];
    return [
      count('updated') && `表示更新 ${count('updated')}列`,
      count('reloaded') && `再読み込み ${count('reloaded')}列`,
      unconfirmedReloads && `再読み込み操作済み・表示未確認 ${unconfirmedReloads}列`,
      unconfirmedUpdates && `操作済み・表示変化未確認 ${unconfirmedUpdates}列`,
      count('skipped') && `スキップ ${count('skipped')}列${skippedReasons.length === 1 ? `（${skippedReasons[0]}）` : ''}`,
      count('failed') && `応答未確認 ${count('failed')}列`,
    ].filter(Boolean).join(' ／ ');
  }

  function FloatingControl({ React, jsx, store, columns, frames, origins, onMountChange, hidden }) {
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
          return navigation.selectedColumns(target).map(column => ({ ...column, refreshKind: kinds[column.id] }));
        },
        onChange: setView,
      });
      controller.current = batch;
      reader.current = navigation;
      const sync = () => { navigation.syncState(); batch.syncState(); setWorkspaceId(store.getState().activeWorkspaceId); };
      const unsubscribe = store.subscribe(sync);
      sync();
      return () => { unsubscribe(); batch.dispose(); navigation.dispose(); controller.current = null; reader.current = null; };
    }, [store, frames, origins, onMountChange]);
    React.useEffect(() => { if (hidden) { controller.current?.cancel(); reader.current?.cancel(); } }, [hidden]);
    const details = view.results.map(result => `${result.title || '列'}: ${
      result.status === 'updated' ? '投稿一覧の更新を確認' : result.status === 'reloaded' ? '現在のページの再読み込みと一覧表示を確認' :
        result.status === 'requested' ? result.method === 'reload' ? '再読み込み操作済み・一覧表示未確認' : '更新操作済み・表示変化未確認' : REASONS[result.reason] || '応答未確認'
    }`).join('\n');
    return jsx.jsx(globalThis.YomikuiFloatingControls.Panel, {
      React, jsx, columns, view, reading, hidden, kinds, workspaceId, onVisibleChange, onCancelWheel, canRefresh: columns.some(isNativeColumn), refreshText: summary(view), refreshDetails: details,
      onRefresh: action => { if (store.getState().activeWorkspaceId === workspaceId && !reader.current?.active) { reader.current?.clearWheel(); controller.current?.run(action); } },
      onNavigate: action => { if (store.getState().activeWorkspaceId === workspaceId && !controller.current?.active) reader.current?.move(action); },
      onWheel: action => store.getState().activeWorkspaceId === workspaceId && !controller.current?.active && reader.current?.wheel(action) === true,
    });
  }

  globalThis.YomikuiHomeRefresh = Object.freeze({
    NativeRefresher, BatchRefresher, FloatingControl, installFrame, summary,
  });
})();
