// Shared by the dashboard and native X frames. No timeline API calls are made.
(() => {
  if (globalThis.YomikuiHomeRefresh) return;

  const PREFIX = 'yomikui-home-refresh-';
  const PROBE = PREFIX + 'probe';
  const READY = PREFIX + 'ready';
  const REQUEST = PREFIX + 'request';
  const RESULT = PREFIX + 'result';
  const CANCEL = PREFIX + 'cancel';
  const COOLDOWN = 5000;
  const FRAME_TIMEOUT = 12000;
  const REQUEST_TIMEOUT = 11000;
  const REASONS = {
    'not-home': 'ホーム以外を表示中',
    following: 'フォロー中など別のタブを表示中',
    unavailable: '更新用のタブを確認できませんでした',
    draft: '投稿を入力中',
    dialog: 'ダイアログを表示中',
    hidden: 'タブが非表示になりました',
    cooldown: '続けての更新を待機',
    busy: '別の更新を処理中',
    cancelled: '更新を中止しました',
    timeout: '列の応答を確認できませんでした',
    error: '更新操作に失敗しました',
  };
  const normalize = value => (value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const recommended = value => ['おすすめ', 'お勧め', 'foryou'].includes(normalize(value));
  const isHomeColumn = column => column.type === 'home' && !column.liveFeed;
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

  function selectedHomeTab() {
    const tabs = [...primaryColumn()?.querySelectorAll('[role="tab"]') ?? []]
      .filter(tab => !tab.closest('article, [role="dialog"]'));
    const forYou = tabs.find(tab => recommended(tab.getAttribute('aria-label') || tab.textContent));
    const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    return { forYou, selected };
  }

  function unavailableReason(getSettings) {
    const settings = getSettings();
    if (window.location.pathname.replace(/\/$/, '') !== '/home' ||
        settings?.columnType !== 'home' || settings.isLiveFeedColumn) return 'not-home';
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
    const { selected, forYou } = selectedHomeTab();
    if (selected && selected !== forYou) return 'following';
    return null;
  }

  function newPostsButton() {
    const pattern = /^(?:show\s+(?:[\d,.]+\s+)?(?:new\s+)?(?:posts?|tweets?)|[\d,]+\s*件の(?:新しい)?(?:ポスト|ツイート)(?:を)?表示|(?:新しい|新着の?)(?:ポスト|ツイート)(?:を)?表示)$/i;
    return [...primaryColumn()?.querySelectorAll('button, [role="button"]') ?? []].find(button => {
      if (button.closest('article, [role="dialog"], [role="tab"]') || button.disabled ||
          button.getAttribute('aria-disabled') === 'true' || button.closest('[hidden], [aria-hidden="true"]')) return false;
      const name = (button.getAttribute('aria-label') || button.textContent).normalize('NFKC').trim();
      return pattern.test(name);
    });
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
    constructor({ getSettings, getScroller }) {
      this.getSettings = getSettings;
      this.getScroller = getScroller;
      this.lastAction = -Infinity;
    }

    async refresh(signal) {
      checkAbort(signal);
      let reason = unavailableReason(this.getSettings);
      if (reason) return { status: 'skipped', reason };
      if (Date.now() - this.lastAction < COOLDOWN) return { status: 'skipped', reason: 'cooldown' };

      const tab = await observeUntil(() => {
        reason = unavailableReason(this.getSettings);
        return reason ? { reason } : selectedHomeTab().forYou;
      }, 4000, signal);
      if (tab?.reason) return { status: 'skipped', reason: tab.reason };
      if (!tab) return { status: 'skipped', reason: 'unavailable' };

      // CSS-hidden tab bars remain in the native DOM and can receive click().
      // Do not switch to Following and back, or retry a click without evidence.
      const scroller = this.getScroller();
      if (scroller) scroller.scrollTop = 0;
      else window.scrollTo({ top: 0, behavior: 'instant' });
      await delay(200, signal);
      reason = unavailableReason(this.getSettings);
      if (reason) return { status: 'skipped', reason };
      const { forYou, selected } = selectedHomeTab();
      if (!forYou || selected !== forYou || !forYou.isConnected || forYou.getAttribute('aria-disabled') === 'true') {
        return { status: 'skipped', reason: 'unavailable' };
      }
      const banner = newPostsButton();
      const before = tweetSignature();
      const method = banner ? 'new-posts' : 'tab';
      this.lastAction = Date.now();
      (banner ?? forYou).click();
      const changed = await observeUntil(() => {
        reason = unavailableReason(this.getSettings);
        if (reason) return { reason };
        const signature = tweetSignature();
        return signature && signature !== before ? { changed: true } : null;
      }, 5000, signal);
      if (changed?.reason) return { status: 'requested', method, reason: changed.reason };
      // A click may return the same posts. Never equate no DOM change with
      // "no new posts", and never claim a successful fetch based on click alone.
      return { status: changed ? 'updated' : 'requested', method };
    }
  }

  function installFrame(options) {
    if (window.self === window.top) return null;
    const refresher = new NativeRefresher(options);
    const completed = new Map();
    let active = null;
    const send = (type, requestId, value = {}) => {
      const origin = options.getOrigin();
      if (trustedOrigin(origin)) window.parent.postMessage({
        type, requestId, columnId: options.getColumnId(), ...value,
      }, origin);
    };
    const onMessage = event => {
      const data = event.data;
      if (event.source !== window.parent || event.origin !== options.getOrigin() || !trustedOrigin(event.origin) ||
          !data || data.columnId !== options.getColumnId() || typeof data.requestId !== 'string' ||
          data.requestId.length < 1 || data.requestId.length > 100) return;
      if (data.type === PROBE) { send(READY, data.requestId); return; }
      if (data.type === CANCEL) {
        if (active?.id === data.requestId) active.abort.abort();
        return;
      }
      if (data.type !== REQUEST || data.target !== 'recommended') return;
      if (completed.has(data.requestId)) { send(RESULT, data.requestId, completed.get(data.requestId)); return; }
      if (active) {
        if (active.id !== data.requestId) send(RESULT, data.requestId, { status: 'skipped', reason: 'busy' });
        return;
      }
      const job = { id: data.requestId, abort: new AbortController() };
      active = job;
      refresher.refresh(job.abort.signal).catch(error => ({
        status: error.name === 'AbortError' ? 'skipped' : 'failed',
        reason: error.name === 'AbortError' ? 'cancelled' : 'error',
      })).then(result => {
        if (active === job) active = null;
        completed.set(job.id, result);
        if (completed.size > 32) completed.delete(completed.keys().next().value);
        send(RESULT, job.id, result);
      });
    };
    const cancel = () => active?.abort.abort();
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return { dispose() {
      cancel();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
    } };
  }

  class BatchRefresher {
    constructor({ getState, getFrame, setMounted, onChange }) {
      Object.assign(this, { getState, getFrame, setMounted, onChange });
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
      else if (this.pending && !state.columns.some(column => column.id === this.pending.columnId && isHomeColumn(column))) {
        this.cancelPending();
      }
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
        pending.sent = true;
        clearTimeout(pending.deadline);
        pending.deadline = setTimeout(() => {
          this.cancelPending('timeout');
        }, REQUEST_TIMEOUT);
        try { pending.frame.postMessage({
          type: REQUEST, requestId: pending.id, columnId: pending.columnId, target: 'recommended',
        }, pending.origin); } catch { pending.finish({ status: 'failed', reason: 'error' }); }
      } else if (data.type === RESULT && pending.sent && ['updated', 'requested', 'skipped', 'failed'].includes(data.status)) {
        pending.finish({ status: data.status, method: data.method, reason: data.reason });
      }
    }

    requestColumn(columnId, signal) {
      return new Promise(resolve => {
        const pending = {
          id: crypto.randomUUID(), columnId, frame: null, origin: null, sent: false,
          deadline: null, poll: null,
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

    async run() {
      if (this.disposed || this.active || Date.now() < this.cooldownUntil || document.hidden) return;
      const state = this.getState();
      const columns = state.columns.filter(isHomeColumn);
      if (!columns.length) return;
      const job = { abort: new AbortController(), workspaceId: state.activeWorkspaceId };
      this.active = job;
      const results = [];
      this.publish({ phase: 'running', results: [], total: columns.length, done: 0 });
      try {
        for (const column of columns) {
          checkAbort(job.abort.signal);
          const current = this.getState();
          let result;
          if (!current.columns.some(item => item.id === column.id && isHomeColumn(item))) {
            result = { status: 'skipped', reason: 'cancelled' };
          } else if ((current.columnActiveTabs?.[column.id] ?? column.activeTab) &&
              !recommended(current.columnActiveTabs?.[column.id] ?? column.activeTab)) {
            // Restoring a saved tab takes place after frame startup. Avoid
            // clicking a default For you tab before Following is restored.
            result = { status: 'skipped', reason: 'following' };
          } else if (current.columnComposing?.[column.id]) {
            result = { status: 'skipped', reason: 'draft' };
          } else {
            current.markColumnActivity?.(column.id);
            this.setMounted(new Set([column.id]));
            result = await this.requestColumn(column.id, job.abort.signal);
          }
          results.push({ columnId: column.id, title: column.title, ...result });
          this.setMounted(new Set());
          this.publish({ results: [...results], done: results.length });
          if (results.length < columns.length) await delay(400, job.abort.signal);
        }
      } catch (error) {
        if (error.name !== 'AbortError') results.push({ status: 'failed', reason: 'error' });
      } finally {
        this.setMounted(new Set());
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
      this.setMounted(new Set());
      this.setMounted = () => {};
      clearTimeout(this.timer);
      window.removeEventListener('message', this.onMessage);
      window.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  function summary(view) {
    if (view.phase === 'running') return `おすすめを更新中 ${view.done}/${view.total}列`;
    if (view.phase === 'cancelled') return '一括更新を中止しました';
    if (!view.results.length) return '';
    const count = status => view.results.filter(result => result.status === status).length;
    const skippedReasons = [...new Set(view.results.filter(result => result.status === 'skipped')
      .map(result => REASONS[result.reason]).filter(Boolean))];
    return [
      count('updated') && `表示更新 ${count('updated')}列`,
      count('requested') && `操作済み・表示変化未確認 ${count('requested')}列`,
      count('skipped') && `スキップ ${count('skipped')}列${skippedReasons.length === 1 ? `（${skippedReasons[0]}）` : ''}`,
      count('failed') && `応答未確認 ${count('failed')}列`,
    ].filter(Boolean).join(' ／ ');
  }

  function FloatingControl({ React, jsx, store, columns, frames, origins, onMountChange, hidden }) {
    const [view, setView] = React.useState({ phase: 'idle', results: [], total: 0, done: 0 });
    const controller = React.useRef(null);
    React.useEffect(() => {
      const batch = new BatchRefresher({
        getState: store.getState,
        getFrame: id => {
          const frame = frames.current.get(id);
          return frame ? { window: frame, origin: origins.current.get(id) ?? window.location.origin } : null;
        },
        setMounted: onMountChange, onChange: setView,
      });
      controller.current = batch;
      const unsubscribe = store.subscribe(() => batch.syncState());
      return () => { unsubscribe(); batch.dispose(); controller.current = null; };
    }, [store, frames, origins, onMountChange]);
    React.useEffect(() => { if (hidden) controller.current?.cancel(); }, [hidden]);
    if (hidden || !columns.some(isHomeColumn)) return null;
    const busy = view.phase === 'running';
    const disabled = busy || view.phase === 'cooldown' || view.phase === 'cancelled';
    const text = summary(view);
    const label = busy ? 'おすすめを一括更新中' : 'ホームのおすすめを一括更新';
    const details = view.results.map(result => `${result.title || 'ホーム'}: ${
      result.status === 'updated' ? '投稿一覧の更新を確認' : result.status === 'requested' ? '更新操作済み・表示変化未確認' : REASONS[result.reason] || '応答未確認'
    }`).join('\n');
    return jsx.jsxs('div', {
      'data-yomikui-home-refresh': '',
      style: { position: 'fixed', right: 20, bottom: 24, zIndex: 800, display: 'flex', alignItems: 'flex-end', gap: 10, maxWidth: 'calc(100vw - 40px)', pointerEvents: 'none' },
      children: [text && jsx.jsx('div', {
        id: 'yomikui-home-refresh-status', role: 'status', 'aria-live': 'polite', title: details,
        style: { maxWidth: 320, padding: '9px 12px', borderRadius: 12, fontSize: 12, color: 'var(--foreground)', background: 'var(--card)', border: '1px solid var(--border)', boxShadow: '0 4px 18px #0003', pointerEvents: 'auto' },
        children: text,
      }), jsx.jsx('button', {
        type: 'button', disabled, 'aria-label': label, 'aria-busy': busy,
        'aria-describedby': text ? 'yomikui-home-refresh-status' : undefined,
        title: `${label}${disabled && !busy ? '（次の更新まで少しお待ちください）' : ''}${details ? '\n' + details : ''}`,
        onClick: () => controller.current?.run(),
        style: { width: 52, height: 52, flexShrink: 0, display: 'grid', placeItems: 'center', border: '1px solid var(--border)', borderRadius: '50%', color: 'var(--primary-foreground)', background: 'var(--primary)', boxShadow: '0 4px 18px #0005', cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.65 : 1, pointerEvents: 'auto' },
        children: jsx.jsxs('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className: busy ? 'animate-spin' : undefined,
          children: [jsx.jsx('path', { d: 'M20 7v5h-5M4 17v-5h5' }), jsx.jsx('path', { d: 'M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17' })],
        }),
      })],
    });
  }

  globalThis.YomikuiHomeRefresh = Object.freeze({
    NativeRefresher, BatchRefresher, FloatingControl, installFrame, isHomeColumn, summary,
  });
})();
