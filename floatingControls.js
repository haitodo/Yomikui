// Dashboard-only UI and reading requests. Timeline refreshes remain sequential.
(() => {
  if (globalThis.YomikuiFloatingControls) return;
  const PREFIX = 'yomikui-home-refresh-';
  const STORAGE_KEY = 'yomikui_floating_controls_v1';
  const TARGETS_KEY = 'yomikui_reading_targets_v1';
  const GROUPS = Object.freeze({ recommended: 'おすすめ', following: 'フォロー中', search: '検索結果' });
  const trusted = origin => origin === 'https://x.com' || origin === 'https://twitter.com';
  const clamp = value => Math.max(0, Math.min(1, value));
  const readable = column => globalThis.YomikuiHomeScroll.isReadableColumn(column);
  const REASONS = {
    hidden: '画面外・非表示', draft: '投稿を入力中', dialog: 'ダイアログを表示中',
    busy: '更新を処理中', 'not-timeline': '投稿一覧以外を表示中', unavailable: '投稿一覧を確認できませんでした',
    timeout: '列の応答を確認できませんでした', cancelled: '操作を中止しました', error: '移動操作に失敗しました',
    'target-changed': '表示内容が対象から変わりました',
  };
  const targetGroup = target => typeof target === 'string' && target.startsWith('group:') ? target.slice(6) : null;
  const normalizeTarget = value => typeof value === 'string' && value.length > 0 && value.length <= 100 &&
    (!value.startsWith('group:') || Object.hasOwn(GROUPS, targetGroup(value))) ? value : 'all';
  const workspaceKey = id => typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : 'default';
  const matchesTarget = (column, target, kinds) => target === 'all' ||
    (targetGroup(target) ? Object.hasOwn(GROUPS, targetGroup(target)) && kinds[column.id] === targetGroup(target) : column.id === target);

  async function loadTarget(workspaceId) {
    try {
      await savingTargets;
      return normalizeTarget((await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY]?.[workspaceKey(workspaceId)]);
    }
    catch { return 'all'; }
  }

  let savingTargets = Promise.resolve();
  function saveTarget(workspaceId, target) {
    savingTargets = savingTargets.then(async () => {
      try {
        const value = (await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY];
        const previous = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        await chrome.storage.local.set({ [TARGETS_KEY]: { ...previous, [workspaceKey(workspaceId)]: normalizeTarget(target) } });
      } catch {}
    });
    return savingTargets;
  }

  function preferences(value) {
    return {
      x: Number.isFinite(value?.x) ? clamp(value.x) : 1,
      y: Number.isFinite(value?.y) ? clamp(value.y) : 1,
      collapsed: value?.collapsed === true,
      mode: value?.mode === 'page' ? 'page' : 'post',
      transparency: Number.isFinite(value?.transparency) ? Math.max(0, Math.min(80, Math.round(value.transparency / 5) * 5)) : 0,
    };
  }

  async function loadPreferences() {
    try { return preferences((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]); }
    catch { return preferences(); }
  }

  let saving = Promise.resolve();
  function savePreferences(value) {
    const next = preferences(value);
    saving = saving.then(async () => {
      try { await chrome.storage.local.set({ [STORAGE_KEY]: next }); } catch {}
    });
    return saving;
  }

  // The rack's existing observer includes a 200px preload margin. Reading must
  // use the actual visible area instead, and must never mount an offscreen frame.
  function visibleColumnIds() {
    const rack = document.querySelector('.rd-rack');
    if (!rack) return new Set();
    const rect = rack.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return new Set();
    return new Set([...rack.querySelectorAll('[data-column-id]')].filter(element => {
      const bounds = element.getBoundingClientRect();
      // Fractional column widths can leave a subpixel sliver of the next column.
      return Math.min(bounds.right, right) - Math.max(bounds.left, left) >= 1 &&
        Math.min(bounds.bottom, bottom) - Math.max(bounds.top, top) >= 1;
    }).map(element => element.getAttribute('data-column-id')));
  }

  class ReadingController {
    constructor({ getState, getFrame, getVisibleIds = visibleColumnIds, onChange, onContext = () => {} }) {
      Object.assign(this, { getState, getFrame, getVisibleIds, onChange, onContext });
      this.pending = new Map();
      this.contexts = new Map();
      this.visible = new Set();
      this.active = null;
      this.receive = this.receive.bind(this);
      this.onVisibility = () => { if (document.hidden) this.cancel(); };
      this.onPageHide = () => this.cancel();
      window.addEventListener('message', this.receive);
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.syncState();
    }

    receive(event) {
      const data = event.data;
      if (data?.type === PREFIX + 'context' || ['yomikui-frame-ready', 'yomikui-tab-change', 'yomikui-path-change'].includes(data?.type)) {
        const column = this.getState().columns.find(column => column.id === data.columnId && readable(column));
        const frame = column && this.getFrame(column.id);
        if (!frame?.window || event.source !== frame.window || event.origin !== frame.origin || !trusted(event.origin)) return;
        if (data.type === PREFIX + 'context') {
          if (![...Object.keys(GROUPS), 'other', null].includes(data.kind)) return;
          this.contexts.set(column.id, { ...frame, kind: data.kind });
          this.publishContexts();
        } else if (this.getVisibleIds().has(column.id)) this.requestContext(column, true);
        return;
      }
      const pending = this.pending.get(data?.requestId);
      if (!pending || data.type !== PREFIX + 'navigated' || data.columnId !== pending.columnId ||
          event.source !== pending.frame || event.origin !== pending.origin || !trusted(event.origin) ||
          !['moved', 'edge', 'skipped', 'failed'].includes(data.status)) return;
      pending.finish({ status: data.status, reason: data.reason });
    }

    kinds() {
      return Object.fromEntries(this.getState().columns.filter(readable).flatMap(column => {
        const entry = this.contexts.get(column.id), frame = this.getFrame(column.id);
        return entry && entry.window === frame?.window && entry.origin === frame.origin ? [[column.id, entry.kind]] : [];
      }));
    }

    publishContexts() {
      const kinds = this.kinds(), signature = JSON.stringify(kinds);
      if (!this.disposed && signature !== this.contextSignature) { this.contextSignature = signature; this.onContext(kinds); }
    }

    requestContext(column, force = false) {
      const frame = this.getFrame(column.id);
      if (!frame?.window || !trusted(frame.origin)) { this.contexts.delete(column.id); return; }
      const previous = this.contexts.get(column.id);
      if (previous?.window === frame.window && previous.origin === frame.origin) {
        if (!force) return;
      } else this.contexts.set(column.id, { ...frame, kind: null });
      try { frame.window.postMessage({ type: PREFIX + 'describe', columnId: column.id }, frame.origin); } catch {}
    }

    syncVisible(ids = this.getVisibleIds()) {
      if (this.disposed) return;
      for (const column of this.getState().columns) {
        if (readable(column) && ids.has(column.id)) this.requestContext(column, !this.visible.has(column.id));
      }
      this.visible = new Set(ids);
      this.publishContexts();
    }

    request(column, frame, direction, mode, group) {
      return new Promise(resolve => {
        const id = crypto.randomUUID();
        const pending = { columnId: column.id, frame: frame.window, origin: frame.origin };
        pending.finish = result => {
          if (!this.pending.delete(id)) return;
          clearTimeout(pending.timer);
          resolve({ columnId: column.id, title: column.title, ...result });
        };
        this.pending.set(id, pending);
        pending.timer = setTimeout(() => pending.finish({ status: 'failed', reason: 'timeout' }), 1200);
        try { frame.window.postMessage({ type: PREFIX + 'navigate', requestId: id, columnId: column.id, direction, mode, ...(group ? { group } : {}) }, frame.origin); }
        catch { pending.finish({ status: 'failed', reason: 'error' }); }
      });
    }

    async move({ target = 'all', direction, mode }) {
      if (this.disposed || this.active || document.hidden || !globalThis.YomikuiHomeScroll.isReadingAction({ direction, mode })) return;
      const state = this.getState();
      const visible = this.getVisibleIds();
      const kinds = this.kinds();
      const columns = state.columns.filter(column => readable(column) && visible.has(column.id) && matchesTarget(column, target, kinds));
      if (!columns.length) {
        this.onChange({ busy: false, results: [], message: '画面内に閲覧対象の列がありません' });
        return;
      }
      const job = { workspaceId: state.activeWorkspaceId, cancelled: false };
      this.active = job;
      const started = Date.now();
      this.onChange({ busy: true, results: [], message: `${columns.length}列を移動中` });
      let results = [];
      try {
        results = await Promise.all(columns.map(column => {
          if (job.cancelled) return { columnId: column.id, title: column.title, status: 'skipped', reason: 'cancelled' };
          const frame = this.getFrame(column.id);
          if (state.columnComposing?.[column.id]) return { columnId: column.id, title: column.title, status: 'skipped', reason: 'draft' };
          if (!frame?.window || !trusted(frame.origin)) return { columnId: column.id, title: column.title, status: 'skipped', reason: 'unavailable' };
          state.markColumnActivity?.(column.id);
          return this.request(column, frame, direction, mode, targetGroup(target));
        }));
        // Bound rapid clicks without queuing steps or running a repeat timer.
        const remaining = 300 - (Date.now() - started);
        if (remaining > 0 && !job.cancelled) await new Promise(resolve => {
          job.release = resolve;
          job.timer = setTimeout(resolve, remaining);
        });
      } catch {
        for (const pending of this.pending.values()) pending.finish({ status: 'failed', reason: 'error' });
        results = [{ status: 'failed', reason: 'error' }];
      } finally {
        clearTimeout(job.timer);
        this.active = null;
        if (!this.disposed) this.onChange({ busy: false, results, message: job.cancelled ? '閲覧操作を中止しました' : readingSummary(results) });
      }
    }

    syncState() {
      const state = this.getState();
      const changed = state.activeWorkspaceId !== this.workspaceId || state.columns !== this.columns;
      if (state.activeWorkspaceId !== this.workspaceId) {
        this.cancel(); this.contexts.clear(); this.visible.clear(); this.workspaceId = state.activeWorkspaceId;
      }
      this.columns = state.columns;
      for (const id of this.contexts.keys()) if (!state.columns.some(column => column.id === id && readable(column))) this.contexts.delete(id);
      if (changed) this.syncVisible();
      else {
        // Activity updates need not measure the rack again. Its scroll/resize
        // listener supplies visibility changes; only replaced frames need a probe.
        for (const column of state.columns) if (readable(column) && this.visible.has(column.id)) this.requestContext(column);
        this.publishContexts();
      }
      for (const pending of this.pending.values()) {
        if (!state.columns.some(column => column.id === pending.columnId && readable(column))) pending.finish({ status: 'skipped', reason: 'cancelled' });
      }
    }

    cancel() {
      if (!this.active) return;
      this.active.cancelled = true;
      for (const pending of this.pending.values()) pending.finish({ status: 'skipped', reason: 'cancelled' });
      this.active.release?.();
    }

    dispose() {
      this.disposed = true;
      this.cancel();
      window.removeEventListener('message', this.receive);
      window.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  function readingSummary(results) {
    const count = status => results.filter(result => result.status === status).length;
    return [
      count('moved') && `移動 ${count('moved')}列`,
      count('edge') && `端に到達 ${count('edge')}列`,
      count('skipped') && `スキップ ${count('skipped')}列`,
      count('failed') && `応答未確認 ${count('failed')}列`,
    ].filter(Boolean).join(' ／ ');
  }

  // Imperative position updates avoid rerendering React or saving storage on
  // every pointer move. The transparent shield keeps iframe content inert.
  class PanelPosition {
    constructor({ panel, handle, position, onCommit }) {
      Object.assign(this, { panel, handle, onCommit });
      this.position = preferences(position);
      this.listeners = [];
      const listen = (target, type, callback, options) => {
        target?.addEventListener(type, callback, options);
        this.listeners.push(() => target?.removeEventListener(type, callback, options));
      };
      listen(handle, 'pointerdown', event => this.start(event));
      listen(handle, 'pointermove', event => this.move(event));
      listen(handle, 'pointerup', event => this.end(event));
      listen(handle, 'pointercancel', event => this.end(event, true));
      listen(handle, 'lostpointercapture', event => this.end(event, true));
      listen(handle, 'keydown', event => this.key(event));
      listen(window, 'resize', () => this.place());
      listen(window.visualViewport, 'resize', () => this.place());
      listen(window.visualViewport, 'scroll', () => this.place());
      listen(window, 'pagehide', () => this.end(null, true));
      listen(document, 'visibilitychange', () => { if (document.hidden) this.end(null, true); });
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.place());
        this.observer.observe(panel);
      }
      this.place();
    }

    bounds() {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      return {
        left: (viewport?.offsetLeft ?? 0) + 8,
        top: (viewport?.offsetTop ?? 0) + 8,
        x: Math.max(0, width - this.panel.offsetWidth - 16),
        y: Math.max(0, height - this.panel.offsetHeight - 16),
        scaleX: Math.max(1, width - 16), scaleY: Math.max(1, height - 16),
      };
    }

    coordinates(bounds = this.bounds()) {
      return {
        left: bounds.left + Math.min(bounds.x, bounds.scaleX * this.position.x),
        top: bounds.top + Math.min(bounds.y, bounds.scaleY * this.position.y),
      };
    }

    place() {
      this.panel.style.maxWidth = `${Math.max(0, (window.visualViewport?.width ?? window.innerWidth) - 16)}px`;
      this.panel.style.maxHeight = `${Math.max(0, (window.visualViewport?.height ?? window.innerHeight) - 16)}px`;
      const point = this.coordinates();
      this.panel.style.left = `${point.left}px`;
      this.panel.style.top = `${point.top}px`;
      this.panel.style.right = 'auto';
      this.panel.style.bottom = 'auto';
    }

    setPosition(position) {
      if (!this.drag) { this.position = preferences(position); this.place(); }
    }

    placeAt(left, top) {
      const bounds = this.bounds();
      // Coordinates use the viewport, so changing status text or folding the
      // settings does not shift an interior header. A value of 1 anchors an edge.
      if (bounds.x) this.position.x = left >= bounds.left + bounds.x - 1 ? 1 : clamp((left - bounds.left) / bounds.scaleX);
      if (bounds.y) this.position.y = top >= bounds.top + bounds.y - 1 ? 1 : clamp((top - bounds.top) / bounds.scaleY);
      this.place();
    }

    start(event) {
      if (event.button !== 0 || this.drag) return;
      event.preventDefault();
      this.handle.focus({ preventScroll: true });
      const point = this.coordinates();
      this.drag = {
        id: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        left: point.left, top: point.top,
        previous: { ...this.position }, moved: false,
      };
      this.shield = document.createElement('div');
      Object.assign(this.shield.style, { position: 'fixed', inset: '0', zIndex: '799', cursor: 'grabbing', touchAction: 'none' });
      this.shield.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.shield);
      this.handle.style.cursor = 'grabbing';
      try { this.handle.setPointerCapture(event.pointerId); } catch { this.end(null, true); }
    }

    move(event) {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const dx = event.clientX - this.drag.clientX, dy = event.clientY - this.drag.clientY;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      this.drag.moved = true;
      this.placeAt(this.drag.left + dx, this.drag.top + dy);
    }

    end(event, cancelled = false) {
      if (!this.drag || (event && event.pointerId !== undefined && event.pointerId !== this.drag.id)) return;
      const drag = this.drag;
      this.drag = null;
      this.shield?.remove();
      this.shield = null;
      this.handle.style.cursor = 'grab';
      if (cancelled) { this.position = drag.previous; this.place(); }
      try { this.handle.releasePointerCapture(drag.id); } catch {}
      if (!cancelled && drag.moved) this.onCommit({ x: this.position.x, y: this.position.y });
    }

    key(event) {
      if (event.key === 'Escape' && this.drag) { event.preventDefault(); this.end(null, true); return; }
      const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (!delta || this.drag) return;
      event.preventDefault();
      const point = this.coordinates(), step = event.shiftKey ? 40 : 10;
      this.placeAt(point.left + delta[0] * step, point.top + delta[1] * step);
      this.onCommit({ x: this.position.x, y: this.position.y });
    }

    dispose() {
      this.end(null, true);
      this.observer?.disconnect();
      this.listeners.forEach(remove => remove());
    }
  }

  const STYLE_MARKER = '/* yomikui-floating-controls */';
  const CSS = `
    .yomikui-floating-panel{position:fixed;right:20px;bottom:24px;z-index:800;width:248px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;border:1px solid var(--border);border-radius:var(--radius);--yf-panel-background:color-mix(in oklab,var(--popover) var(--yf-surface-opacity,100%),transparent);--yf-control-background:color-mix(in oklab,var(--secondary) var(--yf-surface-opacity,100%),transparent);background:var(--yf-panel-background);color:var(--popover-foreground);box-shadow:0 4px 16px #00000024,0 1px 3px #00000012;font-size:12px;line-height:1.4}
    .yomikui-floating-panel *{box-sizing:border-box}
    .yomikui-floating-panel svg{flex-shrink:0}
    .yomikui-floating-panel .yf-header{display:flex;align-items:center;gap:2px;position:sticky;top:0;z-index:1;padding:4px 4px 0;background:var(--yf-panel-background)}
    .yomikui-floating-panel button{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;min-height:30px;padding:5px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:pointer;touch-action:manipulation;transition:background-color .15s,color .15s}
    .yomikui-floating-panel button:not(:disabled):hover{background:color-mix(in oklab,var(--accent) var(--yf-surface-opacity,100%),transparent);color:var(--accent-foreground)}
    .yomikui-floating-panel button:disabled{opacity:.4;cursor:default}
    .yomikui-floating-panel button:focus-visible,.yomikui-floating-panel select:focus-visible,.yomikui-floating-panel input:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
    .yomikui-floating-panel .yf-handle{flex:1;justify-content:flex-start;gap:6px;min-height:24px;padding:4px 5px;color:var(--muted-foreground);cursor:grab;touch-action:none;user-select:none}
    .yomikui-floating-panel .yf-title{flex-shrink:0;font-size:11px;font-weight:600;color:var(--foreground)}
    .yomikui-floating-panel .yf-collapse{width:24px;min-height:24px;padding:4px;color:var(--muted-foreground)}
    .yomikui-floating-panel .yf-body{padding:8px}
    .yomikui-floating-panel .yf-fields{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:6px;margin-bottom:8px}
    .yomikui-floating-panel label{position:relative;min-width:0}
    .yomikui-floating-panel .yf-sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    .yomikui-floating-panel select{appearance:none;width:100%;min-width:0;height:28px;padding:0 23px 0 8px;border:1px solid transparent;border-radius:6px;background:var(--yf-control-background);color:var(--secondary-foreground);font:inherit;font-size:11px;text-overflow:ellipsis;cursor:pointer;transition:border-color .15s}
    .yomikui-floating-panel select:not(:disabled):hover{border-color:var(--border)}
    .yomikui-floating-panel select:disabled{opacity:.5;cursor:default}
    .yomikui-floating-panel option{background:var(--popover);color:var(--popover-foreground)}
    .yomikui-floating-panel label>svg{position:absolute;right:7px;top:50%;width:12px;height:12px;transform:translateY(-50%);color:var(--muted-foreground);pointer-events:none}
    .yomikui-floating-panel .yf-transparency{grid-column:1 / -1;display:flex;align-items:center;gap:8px;font-size:10px;color:var(--muted-foreground)}
    .yomikui-floating-panel .yf-transparency input{appearance:none;flex:1;min-width:0;height:20px;padding:0;background:transparent;cursor:pointer}
    .yomikui-floating-panel .yf-transparency input::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:color-mix(in oklab,var(--muted-foreground) 35%,transparent)}
    .yomikui-floating-panel .yf-transparency input::-webkit-slider-thumb{appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:var(--primary)}
    .yomikui-floating-panel .yf-transparency-value{width:3.5ch;text-align:right;font-variant-numeric:tabular-nums}
    .yomikui-floating-panel .yf-summary{min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:400;color:var(--muted-foreground)}
    .yomikui-floating-panel .yf-actions{display:flex;align-items:stretch;gap:6px}
    .yomikui-floating-panel .yf-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));flex:1;min-width:0;gap:2px;padding:2px;border-radius:8px;background:var(--yf-control-background)}
    .yomikui-floating-panel .yf-down{background:var(--primary);color:var(--primary-foreground)}
    .yomikui-floating-panel .yf-down:not(:disabled):hover{background:color-mix(in oklab,var(--primary) 88%,var(--foreground));color:var(--primary-foreground)}
    .yomikui-floating-panel .yf-refresh-area{display:flex;align-items:center;padding-left:6px;border-left:1px solid var(--border)}
    .yomikui-floating-panel .yf-refresh{width:32px;min-height:32px;color:var(--muted-foreground)}
    .yomikui-floating-panel .yf-refresh[aria-busy="true"] svg{animation:yomikui-floating-spin 1s linear infinite}
    .yomikui-floating-panel .yf-status{margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;color:var(--muted-foreground)}
    @keyframes yomikui-floating-spin{to{transform:rotate(360deg)}}
    @media(pointer:coarse){.yomikui-floating-panel button{min-height:44px}.yomikui-floating-panel .yf-collapse,.yomikui-floating-panel .yf-refresh{width:44px}.yomikui-floating-panel select{height:36px;font-size:12px}.yomikui-floating-panel .yf-transparency input{height:28px}}
    @media(prefers-reduced-motion:reduce){.yomikui-floating-panel button,.yomikui-floating-panel select{transition:none}.yomikui-floating-panel .yf-refresh[aria-busy="true"] svg{animation:none}}
  `.replaceAll('.yomikui-floating-panel', '#yomikui-root .yomikui-floating-panel');

  function installStyles() {
    // The dashboard removes every other stylesheet on head mutations. Extend
    // its protected sheet instead of rendering a separate React <style> node.
    // The root prefix also takes precedence over the dashboard's margin reset.
    const style = document.getElementById('yomikui-styles');
    if (!style) return false;
    if (!style.textContent.includes(STYLE_MARKER)) {
      style.appendChild(document.createTextNode(`\n${STYLE_MARKER}\n${CSS}`));
    }
    return true;
  }

  function Panel({ React, jsx, columns, view, reading, refreshText, refreshDetails, canRefresh, hidden, onRefresh, onNavigate, workspaceId = 'default', kinds = {}, onVisibleChange }) {
    const [prefs, setPrefs] = React.useState(preferences);
    const [selection, setSelection] = React.useState(() => ({ workspaceId, target: 'all', ready: false }));
    const [visible, setVisible] = React.useState(() => new Set());
    const [lastAction, setLastAction] = React.useState('reading');
    const prefsRef = React.useRef(prefs), dirty = React.useRef(false);
    const panelRef = React.useRef(null), handleRef = React.useRef(null), positionRef = React.useRef(null);
    const eligible = columns.filter(readable);
    const available = eligible.length > 0 || canRefresh;
    const targetReady = selection.workspaceId === workspaceId && selection.ready;
    const target = targetReady ? selection.target : '__loading__';
    const useLayoutEffect = React.useLayoutEffect ?? React.useEffect;
    const updatePrefs = React.useCallback(patch => {
      dirty.current = true;
      const next = preferences({ ...prefsRef.current, ...patch });
      prefsRef.current = next;
      setPrefs(next);
      savePreferences(next);
    }, []);
    React.useEffect(() => {
      let mounted = true;
      loadPreferences().then(value => {
        if (mounted && !dirty.current) { prefsRef.current = value; setPrefs(value); }
      });
      return () => { mounted = false; };
    }, []);
    useLayoutEffect(() => {
      if (hidden || !available || !panelRef.current || !handleRef.current) return;
      installStyles();
      const position = new PanelPosition({ panel: panelRef.current, handle: handleRef.current, position: prefsRef.current, onCommit: updatePrefs });
      positionRef.current = position;
      return () => { position.dispose(); positionRef.current = null; };
    }, [hidden, available, updatePrefs]);
    useLayoutEffect(() => { positionRef.current?.setPosition(prefs); }, [prefs]);
    React.useEffect(() => {
      let mounted = true;
      loadTarget(workspaceId).then(target => {
        if (mounted) { setSelection({ workspaceId, target, ready: true }); setLastAction('selection'); }
      });
      return () => { mounted = false; };
    }, [workspaceId]);
    React.useEffect(() => {
      if (hidden || !available) return;
      let scheduled = null;
      const update = () => {
        scheduled = null;
        const ids = visibleColumnIds();
        onVisibleChange?.(ids);
        setVisible(previous => previous.size === ids.size && [...previous].every(id => ids.has(id)) ? previous : ids);
      };
      const schedule = () => { if (scheduled === null) scheduled = requestAnimationFrame(update); };
      const rack = document.querySelector('.rd-rack');
      update();
      rack?.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
      if (rack) observer?.observe(rack);
      return () => {
        rack?.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        observer?.disconnect();
        if (scheduled !== null) cancelAnimationFrame(scheduled);
      };
    }, [hidden, available, columns, onVisibleChange]);
    if (hidden || !available) return null;
    const busy = view.phase === 'running';
    const visibleColumns = eligible.filter(column => visible.has(column.id));
    const selectedColumns = targetReady ? visibleColumns.filter(column => matchesTarget(column, target, kinds)) : [];
    const selected = !targetReady ? '読み込み中' : target === 'all' ? '表示中すべて' : GROUPS[targetGroup(target)] || columns.find(column => column.id === target)?.title || '選択した列';
    const selectionVisible = selectedColumns.length > 0;
    const selectTarget = target => {
      setSelection({ workspaceId, target, ready: true });
      setLastAction('selection');
      saveTarget(workspaceId, target);
    };
    const icon = name => jsx.jsx('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      children: jsx.jsx('path', { d: {
        top: 'M5 3h14M12 21V7m-6 6 6-6 6 6', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6',
        grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
        refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17',
      }[name] }),
    });
    const details = reading.results.map(result => `${result.title || '列'}: ${
      result.status === 'moved' ? '移動操作済み' : result.status === 'edge' ? '端に到達' : REASONS[result.reason] || '応答未確認'
    }`).join('\n');
    const showRefresh = busy || (lastAction === 'refresh' && !reading.busy);
    const noSelection = targetReady && !selectionVisible && !busy;
    const statusText = !targetReady ? '対象を読み込み中' : noSelection ? '画面内に閲覧対象の列がありません' : showRefresh ? refreshText : lastAction === 'reading' || reading.busy ? reading.message : '';
    const statusDetails = noSelection ? statusText : showRefresh ? refreshDetails || refreshText : details || reading.message;
    const navigate = action => { setLastAction('reading'); onNavigate(action); };
    return jsx.jsxs('section', {
      ref: panelRef, className: 'yomikui-floating-panel', 'data-yomikui-home-refresh': '', 'aria-label': '閲覧・更新パネル',
      style: { '--yf-surface-opacity': `${100 - prefs.transparency}%` },
      children: [
        jsx.jsxs('div', { className: 'yf-header', children: [
          jsx.jsxs('button', { ref: handleRef, type: 'button', className: 'yf-handle', title: 'ドラッグして移動（矢印キーでも移動）', 'aria-label': '閲覧・更新パネルを移動。矢印キーでも移動できます', children: [
            icon('grip'), jsx.jsx('span', { className: 'yf-title', children: '閲覧・更新' }),
            prefs.collapsed && jsx.jsx('span', { className: 'yf-summary', title: `${selected}・${selectedColumns.length}列 · ${prefs.mode === 'page' ? '画面ごと' : '投稿ごと'}`, children: `${target === 'all' ? 'すべて' : selected}・${selectedColumns.length}列 · ${prefs.mode === 'page' ? '画面' : '投稿'}` }),
          ] }),
          jsx.jsx('button', { type: 'button', className: 'yf-collapse', 'aria-label': prefs.collapsed ? '設定を展開する' : '設定を折りたたむ', 'aria-expanded': !prefs.collapsed, 'aria-controls': 'yomikui-reading-settings', onClick: () => updatePrefs({ collapsed: !prefs.collapsed }), children: icon(prefs.collapsed ? 'down' : 'up') }),
        ] }),
        jsx.jsxs('div', { className: 'yf-body', children: [
          jsx.jsxs('div', { id: 'yomikui-reading-settings', className: 'yf-fields', hidden: prefs.collapsed, style: prefs.collapsed ? { display: 'none' } : undefined, children: [
            jsx.jsxs('label', { children: [jsx.jsx('span', { className: 'yf-sr-only', children: '閲覧する列' }), jsx.jsxs('select', { 'aria-label': '閲覧する列', title: `${selected}・${selectedColumns.length}列`, value: target, disabled: !targetReady || busy || reading.busy, onChange: event => selectTarget(event.target.value), children: [
              !targetReady && jsx.jsx('option', { value: '__loading__', children: '読み込み中' }),
              jsx.jsxs('optgroup', { label: '表示内容', children: [
                jsx.jsx('option', { value: 'all', children: '表示中すべて' }),
                ...Object.entries(GROUPS).map(([group, title]) => jsx.jsx('option', { value: `group:${group}`, children: `${title}（${visibleColumns.filter(column => kinds[column.id] === group).length}列）` }, group)),
              ] }),
              jsx.jsxs('optgroup', { label: '個別の列', children: [
                ...eligible.map((column, index) => jsx.jsx('option', { value: column.id, disabled: !visible.has(column.id), children: `${index + 1}. ${column.title || '列'}${visible.has(column.id) ? '' : '（画面外）'}` }, column.id)),
                targetReady && target !== 'all' && !targetGroup(target) && !eligible.some(column => column.id === target) && jsx.jsx('option', { value: target, disabled: true, children: '選択した列（対象なし）' }),
              ] }),
            ] }), icon('down')] }),
            jsx.jsxs('label', { children: [jsx.jsx('span', { className: 'yf-sr-only', children: '移動方式' }), jsx.jsxs('select', { 'aria-label': '移動方式', title: '移動方式', value: prefs.mode, disabled: busy || reading.busy, onChange: event => updatePrefs({ mode: event.target.value }), children: [jsx.jsx('option', { value: 'post', children: '投稿ごと' }), jsx.jsx('option', { value: 'page', children: '画面ごと' })] }), icon('down')] }),
            jsx.jsxs('label', { className: 'yf-transparency', htmlFor: 'yomikui-panel-transparency', title: '背景の透明度（0%で不透明）', children: [
              jsx.jsx('span', { children: '透明度' }),
              jsx.jsx('input', { id: 'yomikui-panel-transparency', type: 'range', min: 0, max: 80, step: 5, value: prefs.transparency, 'aria-label': '背景の透明度', 'aria-valuetext': `${prefs.transparency}%`, onChange: event => updatePrefs({ transparency: Number(event.currentTarget.value) }) }),
              jsx.jsx('span', { className: 'yf-transparency-value', 'aria-hidden': true, children: `${prefs.transparency}%` }),
            ] }),
          ] }),
          jsx.jsxs('div', { className: 'yf-actions', children: [
            jsx.jsxs('div', { className: 'yf-steps', children: [jsx.jsxs('button', {
              type: 'button', className: 'yf-top', disabled: busy || reading.busy || !selectionVisible,
              'aria-label': '先頭へ', title: '一覧の先頭へ戻る', onClick: () => navigate({ target, mode: 'top' }), children: [icon('top'), '先頭'],
            }),
            ...[-1, 1].map(direction => jsx.jsxs('button', {
              type: 'button', className: direction === 1 ? 'yf-down' : 'yf-up', disabled: busy || reading.busy || !selectionVisible,
              title: `${prefs.mode === 'page' ? '画面の約8割' : '投稿ごと'}に${direction === 1 ? '下' : '上'}へ移動`,
              onClick: () => navigate({ target, direction, mode: prefs.mode }), children: [icon(direction === 1 ? 'down' : 'up'), direction === 1 ? '下へ' : '上へ'],
            }, direction)),
            ] }),
            canRefresh && jsx.jsx('div', { className: 'yf-refresh-area', children:
              jsx.jsx('button', { type: 'button', className: 'yf-refresh', disabled: busy || reading.busy || view.phase === 'cooldown' || view.phase === 'cancelled', 'aria-label': 'ホームを一括更新', 'aria-busy': busy, title: `${view.phase === 'cooldown' || view.phase === 'cancelled' ? '次の更新まで少しお待ちください。' : ''}ホームを一括更新：閲覧する列の選択にかかわらず、ホーム列全体を順番に更新します`, onClick: () => { setLastAction('refresh'); onRefresh(); }, children: icon('refresh') }),
            }),
          ] }),
          statusText && jsx.jsx('div', { id: 'yomikui-home-refresh-status', className: 'yf-status', role: 'status', 'aria-live': 'polite', title: statusDetails, children: statusText }),
        ] }),
      ],
    });
  }

  globalThis.YomikuiFloatingControls = Object.freeze({ ReadingController, PanelPosition, Panel, visibleColumnIds, preferences, loadPreferences, savePreferences, loadTarget, saveTarget, matchesTarget, readingSummary, installStyles });
})();
