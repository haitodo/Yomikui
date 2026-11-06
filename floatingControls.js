// Dashboard-only UI and reading requests. Timeline refreshes remain sequential.
(() => {
  if (globalThis.YomikuiFloatingControls) return;
  const PREFIX = 'yomikui-home-refresh-';
  const NAVIGATION_TIMEOUT_MS = 1200;
  const READING_ACTION_INTERVAL_MS = 300;
  const STORAGE_KEY = 'yomikui_floating_controls_v1';
  const TARGETS_KEY = 'yomikui_reading_targets_v1';
  const GROUPS = Object.freeze({ recommended: 'おすすめ', following: 'フォロー中', search: '検索結果', explore: '話題を検索' });
  const COLORS = Object.freeze({ bluegray: 'ブルーグレー', lavender: 'ラベンダー', sage: 'セージ', gray: 'グレー', theme: 'テーマに合わせる' });
  const ALL_GROUPS = Object.freeze(Object.keys(GROUPS));
  const FRAME_EVENT_TYPES = new Set(['yomikui-frame-ready', 'yomikui-tab-change', 'yomikui-path-change']);
  const VALID_CONTEXT_KINDS = new Set([...ALL_GROUPS, 'other', null]);
  const NAVIGATED_STATUSES = new Set(['moved', 'edge', 'skipped', 'failed']);
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
  const groupName = value => Object.hasOwn(GROUPS, value) ? value : targetGroup(value);
  function selectionPreferences(value) {
    const valid = candidate => typeof candidate === 'string' && Object.hasOwn(GROUPS, groupName(candidate));
    if (typeof value === 'string') {
      if (value === 'all') return { selectionMode: 'multiple', single: 'recommended', multiple: ALL_GROUPS, multipleReady: true };
      value = { single: valid(value) ? groupName(value) : 'recommended' };
    }
    const single = valid(value?.single) ? groupName(value.single) : 'recommended';
    return {
      selectionMode: value?.selectionMode === 'multiple' ? 'multiple' : 'single', single,
      multiple: Array.isArray(value?.multiple) ? [...new Set(value.multiple.filter(valid).map(groupName))] : [single],
      multipleReady: value?.multipleReady === true || value?.selectionMode === 'multiple',
    };
  }
  const selectedGroups = selection => selection.selectionMode === 'multiple' ? selection.multiple : [selection.single];
  const targetKey = target => Array.isArray(target) ? [...new Set(target)].sort().join(',') : target;
  const frameGroup = (target, kind) => Array.isArray(target) ? kind : targetGroup(target);
  const workspaceKey = id => typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : 'default';
  const matchesTarget = (column, target, kinds) => Array.isArray(target) ? target.some(kind => Object.hasOwn(GROUPS, kind) && kinds[column.id] === kind) : target === 'all' ||
    (targetGroup(target) ? Object.hasOwn(GROUPS, targetGroup(target)) && kinds[column.id] === targetGroup(target) : column.id === target);

  async function loadTarget(workspaceId) {
    try {
      await savingTargets;
      return selectionPreferences((await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY]?.[workspaceKey(workspaceId)]);
    }
    catch { return selectionPreferences(); }
  }

  let savingTargets = Promise.resolve();
  function saveTarget(workspaceId, target) {
    const next = selectionPreferences(target);
    savingTargets = savingTargets.then(async () => {
      try {
        const value = (await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY];
        const previous = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        await chrome.storage.local.set({ [TARGETS_KEY]: { ...previous, [workspaceKey(workspaceId)]: next } });
      } catch {}
    });
    return savingTargets;
  }

  function preferences(value) {
    return {
      x: Number.isFinite(value?.x) ? clamp(value.x) : 1,
      y: Number.isFinite(value?.y) ? clamp(value.y) : 1,
      mode: value?.mode === 'page' ? 'page' : 'post',
      hideEmpty: value?.hideEmpty !== false,
      color: Object.hasOwn(COLORS, value?.color) ? value.color : 'bluegray',
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
    const ids = new Set();
    for (const element of rack.querySelectorAll('[data-column-id]')) {
      const bounds = element.getBoundingClientRect();
      if (Math.min(bounds.right, right) - Math.max(bounds.left, left) >= 1 &&
          Math.min(bounds.bottom, bottom) - Math.max(bounds.top, top) >= 1) {
        const id = element.getAttribute('data-column-id');
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  class ReadingController {
    constructor({ getState, getFrame, getVisibleIds = visibleColumnIds, onChange, onContext = () => {} }) {
      Object.assign(this, { getState, getFrame, getVisibleIds, onChange, onContext });
      this.pending = new Map();
      this.contexts = new Map();
      this.visible = new Set();
      this.wheelActivity = new Map();
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
      if (data?.type === PREFIX + 'context' || FRAME_EVENT_TYPES.has(data?.type)) {
        const column = this.getState().columns.find(column => column.id === data.columnId && readable(column));
        const frame = column && this.getFrame(column.id);
        if (!frame?.window || event.source !== frame.window || event.origin !== frame.origin || !trusted(event.origin)) return;
        if (data.type === PREFIX + 'context') {
          if (!VALID_CONTEXT_KINDS.has(data.kind)) return;
          this.contexts.set(column.id, { ...frame, kind: data.kind });
          this.publishContexts();
        } else if (this.getVisibleIds().has(column.id)) this.requestContext(column, true);
        return;
      }
      const pending = this.pending.get(data?.requestId);
      if (!pending || data.type !== PREFIX + 'navigated' || data.columnId !== pending.columnId ||
          event.source !== pending.frame || event.origin !== pending.origin || !trusted(event.origin) ||
          !NAVIGATED_STATUSES.has(data.status)) return;
      pending.finish({ status: data.status, reason: data.reason });
    }

    kinds() {
      const result = {};
      for (const column of this.getState().columns) {
        if (!readable(column)) continue;
        const entry = this.contexts.get(column.id), frame = this.getFrame(column.id);
        if (entry && entry.window === frame?.window && entry.origin === frame.origin) {
          result[column.id] = entry.kind;
        }
      }
      return result;
    }

    selectedColumns(target = 'all', visible = this.getVisibleIds()) {
      const kinds = this.kinds();
      return this.getState().columns.filter(column => readable(column) && visible.has(column.id) && matchesTarget(column, target, kinds));
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
        pending.timer = setTimeout(() => pending.finish({ status: 'failed', reason: 'timeout' }), NAVIGATION_TIMEOUT_MS);
        try { frame.window.postMessage({ type: PREFIX + 'navigate', requestId: id, columnId: column.id, direction, mode, ...(group ? { group } : {}) }, frame.origin); }
        catch { pending.finish({ status: 'failed', reason: 'error' }); }
      });
    }

    wheel({ target = 'all', deltaY, deltaMode = 0 }) {
      if (this.disposed || document.hidden || !globalThis.YomikuiHomeScroll.isReadingAction({ mode: 'wheel', deltaY, deltaMode })) return false;
      const state = this.getState();
      if (!this.selectedColumns(target, this.visible).length) return false;
      if (this.active && !this.active.cancelled) { this.active.cancelledByWheel = true; this.cancel(); }
      const previous = this.wheelBuffer;
      if (previous && (previous.workspaceId !== state.activeWorkspaceId || targetKey(previous.target) !== targetKey(target))) this.clearWheel();
      // Keep reversals and unit changes in order, including at a column's edge.
      else if (previous && (previous.deltaMode !== deltaMode || previous.direction !== Math.sign(deltaY))) this.flushWheel();
      const leading = !this.wheelBuffer;
      if (leading) this.wheelBuffer = { workspaceId: state.activeWorkspaceId, target: Array.isArray(target) ? [...target] : target, deltaMode, direction: Math.sign(deltaY), deltaY: 0, frame: null };
      const buffer = this.wheelBuffer;
      buffer.deltaY += deltaY;
      // Send the first input in this event, without waiting for the dashboard's
      // next paint. Only additional input in the same frame needs coalescing.
      if (leading) this.flushWheel(true);
      return true;
    }

    flushWheel(leading = false) {
      const buffer = this.wheelBuffer;
      if (!buffer) return;
      const deltaY = buffer.deltaY;
      if (leading) {
        buffer.deltaY = 0;
        buffer.frame = requestAnimationFrame(() => this.flushWheel());
      } else this.clearWheel();
      if (deltaY === 0) return;
      const state = this.getState();
      if (this.disposed || document.hidden || state.activeWorkspaceId !== buffer.workspaceId) return;
      const kinds = this.kinds();
      for (const column of this.selectedColumns(buffer.target)) {
        if (state.columnComposing?.[column.id]) continue;
        const frame = this.getFrame(column.id);
        if (!frame?.window || !trusted(frame.origin)) continue;
        const group = frameGroup(buffer.target, kinds[column.id]);
        const now = Date.now();
        if (!this.wheelActivity.has(column.id) || now - this.wheelActivity.get(column.id) >= 500) {
          this.wheelActivity.set(column.id, now);
          state.markColumnActivity?.(column.id);
        }
        // Continuous input is applied immediately in the frame. It has no
        // response deadline, repeat timer, or queue behind a previous action.
        try { frame.window.postMessage({
          type: PREFIX + 'scroll', requestId: crypto.randomUUID(), columnId: column.id, mode: 'wheel',
          deltaY, deltaMode: buffer.deltaMode,
          ...(group ? { group } : {}),
        }, frame.origin); } catch {}
      }
    }

    clearWheel() {
      if (this.wheelBuffer?.frame != null) cancelAnimationFrame(this.wheelBuffer.frame);
      this.wheelBuffer = null;
    }

    async move({ target = 'all', direction, mode }) {
      if (this.disposed || this.active || document.hidden || !globalThis.YomikuiHomeScroll.isReadingAction({ direction, mode })) return;
      this.clearWheel();
      const state = this.getState();
      const kinds = this.kinds();
      const columns = this.selectedColumns(target);
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
          return this.request(column, frame, direction, mode, frameGroup(target, kinds[column.id]));
        }));
        // Bound rapid clicks without queuing steps or running a repeat timer.
        const remaining = READING_ACTION_INTERVAL_MS - (Date.now() - started);
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
        if (!this.disposed) this.onChange({ busy: false, results, message: job.cancelledByWheel ? 'ホイール操作に切り替えました' : job.cancelled ? '閲覧操作を中止しました' : readingSummary(results) });
      }
    }

    syncState() {
      const state = this.getState();
      const changed = state.activeWorkspaceId !== this.workspaceId || state.columns !== this.columns;
      if (state.activeWorkspaceId !== this.workspaceId) {
        this.cancel(); this.contexts.clear(); this.visible.clear(); this.wheelActivity.clear(); this.workspaceId = state.activeWorkspaceId;
      }
      this.columns = state.columns;
      for (const id of this.contexts.keys()) if (!state.columns.some(column => column.id === id && readable(column))) this.contexts.delete(id);
      for (const id of this.wheelActivity.keys()) if (!state.columns.some(column => column.id === id)) this.wheelActivity.delete(id);
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
      this.clearWheel();
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

  function installWheel(panel, onWheel) {
    const receive = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
          Math.abs(event.deltaX || 0) > Math.abs(event.deltaY) ||
          event.target.closest?.('label, select, input, textarea, [contenteditable="true"], [role="listbox"], [role="menu"]') ||
          panel.scrollHeight > panel.clientHeight + 1) return;
      const action = { deltaY: event.deltaY, deltaMode: event.deltaMode ?? 0 };
      if (globalThis.YomikuiHomeScroll.isReadingAction({ mode: 'wheel', ...action }) && onWheel(action)) event.preventDefault();
    };
    panel.addEventListener('wheel', receive, { passive: false, capture: true });
    return () => panel.removeEventListener('wheel', receive, { capture: true });
  }

  function readingSummary(results) {
    const counts = Object.fromEntries(['moved', 'edge', 'skipped', 'failed'].map(status => [
      status, results.filter(result => result.status === status).length,
    ]));
    return [
      counts.moved && `移動 ${counts.moved}列`,
      counts.edge && `端に到達 ${counts.edge}列`,
      counts.skipped && `スキップ ${counts.skipped}列`,
      counts.failed && `応答未確認 ${counts.failed}列`,
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
      listen(handle, 'dblclick', event => this.resetPosition(event));
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

    place(bounds = this.bounds(), dragMoving = false) {
      if (!dragMoving) {
        this.panel.style.maxWidth = `${Math.max(0, (window.visualViewport?.width ?? window.innerWidth) - 16)}px`;
        this.panel.style.maxHeight = `${Math.max(0, (window.visualViewport?.height ?? window.innerHeight) - 16)}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
      }
      const point = this.coordinates(bounds);
      this.panel.style.left = `${point.left}px`;
      this.panel.style.top = `${point.top}px`;
    }

    setPosition(position) {
      if (!this.drag) { this.position = preferences(position); this.place(); }
    }

    placeAt(left, top, bounds = this.bounds(), dragMoving = false) {
      // Coordinates use the viewport, so changing status text or folding the
      // settings does not shift an interior header. A value of 1 anchors an edge.
      if (bounds.x) this.position.x = left >= bounds.left + bounds.x - 1 ? 1 : clamp((left - bounds.left) / bounds.scaleX);
      if (bounds.y) this.position.y = top >= bounds.top + bounds.y - 1 ? 1 : clamp((top - bounds.top) / bounds.scaleY);
      this.place(bounds, dragMoving);
    }

    start(event) {
      if (event.button !== 0 || this.drag) return;
      event.preventDefault();
      this.handle.focus({ preventScroll: true });
      const bounds = this.bounds();
      const point = this.coordinates(bounds);
      this.drag = {
        id: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        left: point.left, top: point.top, bounds,
        previous: { ...this.position }, moved: false,
      };
      this.panel.style.willChange = 'left, top';
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
      const bounds = this.drag.bounds;
      const rawLeft = this.drag.left + dx, rawTop = this.drag.top + dy;
      const targetLeft = Math.max(bounds.left, Math.min(bounds.left + bounds.x, rawLeft));
      const targetTop = Math.max(bounds.top, Math.min(bounds.top + bounds.y, rawTop));
      // Re-sync origin when hitting viewport boundary to prevent lag when reversing direction
      if (rawLeft !== targetLeft) this.drag.clientX = event.clientX - (targetLeft - this.drag.left);
      if (rawTop !== targetTop) this.drag.clientY = event.clientY - (targetTop - this.drag.top);
      this.placeAt(targetLeft, targetTop, bounds, true);
    }

    end(event, cancelled = false) {
      if (!this.drag || (event && event.pointerId !== undefined && event.pointerId !== this.drag.id)) return;
      const drag = this.drag;
      this.drag = null;
      this.panel.style.willChange = '';
      this.shield?.remove();
      this.shield = null;
      this.handle.style.cursor = 'grab';
      if (cancelled) { this.position = drag.previous; this.place(); }
      try { this.handle.releasePointerCapture(drag.id); } catch {}
      if (!cancelled && drag.moved) {
        this.lastDragMovedAt = Date.now();
        this.onCommit({ x: this.position.x, y: this.position.y });
      }
    }

    resetPosition(event) {
      if (event.button !== 0 || this.drag || Date.now() - (this.lastDragMovedAt ?? 0) < 500) return;
      this.position = preferences({ x: 1, y: 1 });
      this.place();
      this.onCommit({ x: this.position.x, y: this.position.y });
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
    #yomikui-root{--yf-bluegray:#2c3e52;--yf-lavender:#45364f;--yf-sage:#2f453b;--yf-gray:#3a3b45}
    #yomikui-root[data-theme="dim"]{--yf-bluegray:#30475b;--yf-lavender:#453c56;--yf-sage:#344d46;--yf-gray:#3a424b}
    #yomikui-root[data-theme="light"]{--yf-bluegray:#e5eef8;--yf-lavender:#eee5f7;--yf-sage:#e1f0e8;--yf-gray:#e9eaef}
    .yomikui-floating-panel{position:fixed;right:20px;bottom:24px;z-index:800;width:288px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;border:1px solid color-mix(in oklab,var(--popover-foreground) 20%,transparent);border-radius:var(--radius);--yf-panel-background:color-mix(in oklab,var(--yf-surface-base) var(--yf-surface-opacity,100%),transparent);--yf-control-background:color-mix(in oklab,color-mix(in oklab,var(--yf-surface-base) 94%,var(--popover-foreground)) var(--yf-surface-opacity,100%),transparent);--yf-muted-foreground:color-mix(in oklab,var(--popover-foreground) 75%,var(--yf-surface-base));background:var(--yf-panel-background);color:var(--popover-foreground);box-shadow:0 6px 24px #00000033,0 1px 4px #0000001f;font-size:12px;line-height:1.4}
    .yomikui-floating-panel *{box-sizing:border-box}
    .yomikui-floating-panel svg{flex-shrink:0}
    .yomikui-floating-panel .yf-header{display:flex;align-items:center;gap:2px;position:sticky;top:0;z-index:1;padding:4px 4px 0;background:var(--yf-panel-background)}
    .yomikui-floating-panel button{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;min-height:30px;padding:5px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:pointer;touch-action:manipulation;transition:background-color .15s,color .15s}
    .yomikui-floating-panel button:not(:disabled):hover{background:color-mix(in oklab,var(--popover-foreground) 10%,transparent);color:var(--popover-foreground)}
    .yomikui-floating-panel button:not(:disabled):active{background:color-mix(in oklab,var(--popover-foreground) 16%,transparent)}
    .yomikui-floating-panel button:disabled{opacity:.4;cursor:default}
    .yomikui-floating-panel button:focus-visible,.yomikui-floating-panel select:focus-visible,.yomikui-floating-panel input:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
    .yomikui-floating-panel .yf-handle{flex:1;justify-content:flex-start;gap:6px;min-height:24px;padding:4px 5px;color:var(--yf-muted-foreground);cursor:grab;touch-action:none;user-select:none}
    .yomikui-floating-panel .yf-title{flex-shrink:0;font-size:11px;font-weight:600;color:var(--foreground)}
    .yomikui-floating-panel .yf-settings-toggle{width:24px;min-height:24px;padding:4px;color:var(--yf-muted-foreground)}
    .yomikui-floating-panel .yf-body{padding:4px 8px 8px}
    .yomikui-floating-panel [hidden]{display:none!important}
    .yomikui-floating-panel .yf-choice-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px;margin-bottom:4px}
    .yomikui-floating-panel .yf-selection-mode{display:flex;gap:2px;padding:2px;border-radius:7px;background:var(--yf-control-background)}
    .yomikui-floating-panel .yf-selection-mode button{min-height:26px;padding:3px 7px;font-size:11px}
    .yomikui-floating-panel .yf-hide-empty{display:flex;align-items:center;gap:4px;min-height:28px;font-size:11px;color:var(--yf-muted-foreground);white-space:nowrap;cursor:pointer}
    .yomikui-floating-panel .yf-hide-empty input{margin:0;accent-color:var(--foreground)}
    .yomikui-floating-panel .yf-targets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
    .yomikui-floating-panel .yf-target{justify-content:flex-start;min-height:32px;padding:5px 6px;background:var(--yf-control-background)}
    .yomikui-floating-panel button[aria-pressed="true"]{background:var(--popover-foreground);color:var(--popover)}
    .yomikui-floating-panel button[aria-pressed="true"]:not(:disabled):hover{background:var(--popover-foreground);color:var(--popover)}
    .yomikui-floating-panel .yf-mark{width:12px;flex-shrink:0;text-align:center}
    .yomikui-floating-panel .yf-count{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums}
    .yomikui-floating-panel .yf-fields{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
    .yomikui-floating-panel label{position:relative;min-width:0}
    .yomikui-floating-panel .yf-sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    .yomikui-floating-panel select{appearance:none;width:100%;min-width:0;height:28px;padding:0 23px 0 8px;border:1px solid transparent;border-radius:6px;background:var(--yf-control-background);color:var(--popover-foreground);font:inherit;font-size:11px;text-overflow:ellipsis;cursor:pointer;transition:border-color .15s}
    .yomikui-floating-panel select:not(:disabled):hover{border-color:var(--border)}
    .yomikui-floating-panel select:disabled{opacity:.5;cursor:default}
    .yomikui-floating-panel option{background:var(--popover);color:var(--popover-foreground)}
    .yomikui-floating-panel label>svg,.yomikui-floating-panel .yf-color-select>svg{position:absolute;right:7px;top:50%;width:12px;height:12px;transform:translateY(-50%);color:var(--yf-muted-foreground);pointer-events:none}
    .yomikui-floating-panel .yf-setting{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--yf-muted-foreground)}
    .yomikui-floating-panel .yf-setting>span:first-child{min-width:4em}
    .yomikui-floating-panel .yf-color-select{position:relative;flex:1;min-width:0}
    .yomikui-floating-panel .yf-transparency{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--yf-muted-foreground)}
    .yomikui-floating-panel .yf-transparency input{appearance:none;flex:1;min-width:0;height:20px;padding:0;background:transparent;cursor:pointer}
    .yomikui-floating-panel .yf-transparency input::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:color-mix(in oklab,var(--yf-muted-foreground) 35%,transparent)}
    .yomikui-floating-panel .yf-transparency input::-webkit-slider-thumb{appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:var(--yf-muted-foreground)}
    .yomikui-floating-panel .yf-transparency-value{width:3.5ch;text-align:right;font-variant-numeric:tabular-nums}
    .yomikui-floating-panel .yf-actions{display:flex;align-items:stretch;gap:4px;margin-top:4px}
    .yomikui-floating-panel .yf-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));flex:1;min-width:0;gap:2px;padding:2px;border-radius:8px;background:var(--yf-control-background)}
    .yomikui-floating-panel .yf-refresh-area{display:flex;align-items:stretch}
    .yomikui-floating-panel .yf-refresh{width:76px;min-height:32px;background:var(--yf-control-background)}
    .yomikui-floating-panel .yf-refresh[aria-busy="true"] svg{animation:yomikui-floating-spin 1s linear infinite}
    @keyframes yomikui-floating-spin{to{transform:rotate(360deg)}}
    @media(pointer:coarse){.yomikui-floating-panel button,.yomikui-floating-panel .yf-target,.yomikui-floating-panel .yf-selection-mode button,.yomikui-floating-panel .yf-hide-empty{min-height:44px}.yomikui-floating-panel .yf-settings-toggle{width:44px;min-height:44px}.yomikui-floating-panel .yf-refresh{min-height:44px}.yomikui-floating-panel select{height:44px;font-size:16px}.yomikui-floating-panel .yf-transparency input{height:28px}}
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

  function Panel({ React, jsx, columns, view, reading, refreshText, refreshDetails, canRefresh, hidden, onRefresh, onCancelRefresh, onNavigate, onWheel, onCancelWheel, workspaceId = 'default', kinds = {}, onVisibleChange }) {
    const [prefs, setPrefs] = React.useState(preferences);
    const [selection, setSelection] = React.useState(() => ({ workspaceId, value: selectionPreferences(), ready: false }));
    const [visible, setVisible] = React.useState(() => new Set());
    const [lastAction, setLastAction] = React.useState('reading');
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const prefsRef = React.useRef(prefs), dirty = React.useRef(false);
    const panelRef = React.useRef(null), handleRef = React.useRef(null), positionRef = React.useRef(null);
    const wheelRef = React.useRef(null);
    const countsRef = React.useRef(null);
    const eligible = columns.filter(readable);
    const available = eligible.length > 0 || canRefresh;
    const targetReady = selection.workspaceId === workspaceId && selection.ready;
    const target = targetReady ? selectedGroups(selection.value) : [];
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
      const disposeWheel = installWheel(panelRef.current, action => wheelRef.current?.(action) === true);
      positionRef.current = position;
      return () => { disposeWheel(); position.dispose(); positionRef.current = null; };
    }, [hidden, available, updatePrefs]);
    useLayoutEffect(() => { positionRef.current?.setPosition(prefs); }, [prefs]);
    React.useEffect(() => {
      let mounted = true;
      loadTarget(workspaceId).then(value => {
        if (mounted) { setSelection({ workspaceId, value, ready: true }); setLastAction('selection'); }
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
    const currentCounts = Object.fromEntries(Object.keys(GROUPS).map(kind => [kind, visibleColumns.filter(column => kinds[column.id] === kind).length]));
    // A reloading frame briefly reports an unknown kind. Keep the controls
    // stationary during the operation; execution still uses live contexts.
    if ((!busy && !reading.busy) || countsRef.current?.workspaceId !== workspaceId) countsRef.current = { workspaceId, counts: currentCounts };
    const displayCounts = countsRef.current.counts;
    const selectedColumns = targetReady ? visibleColumns.filter(column => matchesTarget(column, target, kinds)) : [];
    const refreshCounts = globalThis.YomikuiHomeScroll.REFRESH_KINDS.map(kind => ({
      kind, count: selectedColumns.filter(column => kinds[column.id] === kind).length,
    }));
    const refreshCount = refreshCounts.reduce((total, item) => total + item.count, 0);
    const refreshTargets = refreshCounts.filter(item => item.count).map(item => `${GROUPS[item.kind]} ${item.count}列`).join('・');
    const selected = !targetReady ? '読み込み中' : target.map(kind => GROUPS[kind]).join('・') || '対象未選択';
    const selectionVisible = selectedColumns.length > 0;
    wheelRef.current = action => targetReady && selectionVisible && !busy && !positionRef.current?.drag && onWheel?.({ target, ...action }) === true;
    const selectTarget = patch => {
      if (!targetReady || busy || reading.busy) return;
      onCancelWheel?.();
      const value = selectionPreferences({ ...selection.value, ...patch });
      setSelection({ workspaceId, value, ready: true });
      setLastAction('selection');
      saveTarget(workspaceId, value);
    };
    const icon = name => jsx.jsx('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      children: jsx.jsx('path', { d: {
        top: 'M5 3h14M12 21V7m-6 6 6-6 6 6', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6',
        grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
        refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17',
        settings: 'M10 2h4l1 3 2 1 3-1 2 4-2 2v2l2 2-2 4-3-1-2 1-1 3h-4l-1-3-2-1-3 1-2-4 2-2v-2L2 9l2-4 3 1 2-1z M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8',
      }[name] }),
    });
    const details = reading.results.map(result => `${result.title || '列'}: ${
      result.status === 'moved' ? '移動操作済み' : result.status === 'edge' ? '端に到達' : REASONS[result.reason] || '応答未確認'
    }`).join('\n');
    const showRefresh = busy || (lastAction === 'refresh' && !reading.busy);
    const noSelection = targetReady && !selectionVisible && !busy;
    const statusText = !targetReady ? '対象を読み込み中' : noSelection ? '画面内に閲覧対象の列がありません' : showRefresh ? refreshText : lastAction === 'reading' || reading.busy ? reading.message : '';
    const results = view.results ?? [];
    const feedback = view.phase === 'cancelled' ? '中止済' : results.some(result => ['failed', 'requested'].includes(result.status)) ? '未確認' :
      results.some(result => result.status === 'skipped') ? results.some(result => ['updated', 'reloaded'].includes(result.status)) ? '一部' : '対象外' : results.length ? '完了' : '更新';
    const refreshLabel = busy ? onCancelRefresh ? '中止' : '更新中' : lastAction === 'refresh' && ['cooldown', 'cancelled'].includes(view.phase) ? feedback : '更新';
    const navigate = action => { setLastAction('reading'); onNavigate(action); };
    return jsx.jsxs('section', {
      ref: panelRef, className: 'yomikui-floating-panel', 'data-yomikui-home-refresh': '', 'aria-label': '閲覧・更新パネル', title: 'パネル上のホイール操作で選択中の列をスクロール',
      translate: 'no', lang: 'ja',
      style: { '--yf-surface-base': prefs.color === 'theme' ? 'var(--popover)' : `var(--yf-${prefs.color})`, '--yf-surface-opacity': `${100 - prefs.transparency}%` },
      children: [
        jsx.jsxs('div', { className: 'yf-header', children: [
          jsx.jsxs('button', { ref: handleRef, type: 'button', className: 'yf-handle', title: 'ドラッグして移動（矢印キーでも移動）', 'aria-label': '閲覧・更新パネルを移動。矢印キーでも移動できます', children: [
            icon('grip'), jsx.jsx('span', { className: 'yf-title', children: '閲覧・更新' }),
          ] }),
          jsx.jsx('button', { type: 'button', className: 'yf-settings-toggle', 'aria-label': 'パネル設定', 'aria-expanded': settingsOpen, 'aria-controls': 'yomikui-reading-settings', onClick: () => setSettingsOpen(!settingsOpen), children: icon('settings') }),
        ] }),
        jsx.jsxs('div', { className: 'yf-body', children: [
          jsx.jsxs('div', { className: 'yf-choice-row', children: [
            jsx.jsx('div', { className: 'yf-selection-mode', role: 'group', 'aria-label': '対象の選択方式', children:
              [['single', '切り替え'], ['multiple', '複数選択']].map(([mode, title]) => jsx.jsx('button', {
                type: 'button', 'aria-pressed': targetReady && selection.value.selectionMode === mode, disabled: !targetReady || busy || reading.busy,
                onClick: () => selectTarget({ selectionMode: mode, ...(mode === 'multiple' && !selection.value.multipleReady ? { multiple: [selection.value.single], multipleReady: true } : {}) }), children: title,
              }, mode)),
            }),
            jsx.jsxs('label', { className: 'yf-hide-empty', children: [
              jsx.jsx('input', { type: 'checkbox', checked: prefs.hideEmpty, onChange: event => updatePrefs({ hideEmpty: event.currentTarget.checked }) }), '0列を隠す',
            ] }),
          ] }),
          jsx.jsx('div', { className: 'yf-targets', role: 'group', 'aria-label': '操作する列の表示内容', children: Object.entries(GROUPS).map(([kind, title]) => {
            const count = displayCounts[kind];
            const pressed = target.includes(kind);
            return jsx.jsxs('button', {
              type: 'button', className: 'yf-target', 'data-target': kind, 'aria-pressed': pressed, hidden: prefs.hideEmpty && count === 0,
              disabled: !targetReady || busy || reading.busy || (count === 0 && !(selection.value.selectionMode === 'multiple' && pressed)),
              title: `${title}・画面内${count}列`,
              onClick: () => selectTarget(selection.value.selectionMode === 'multiple' ? { multiple: pressed ? target.filter(group => group !== kind) : [...target, kind] } : { single: kind }),
              children: [jsx.jsx('span', { className: 'yf-mark', 'aria-hidden': true, children: pressed ? '✓' : '' }), title, jsx.jsx('span', { className: 'yf-count', children: `${count}列` })],
            }, kind);
          }) }),
          jsx.jsxs('div', { className: 'yf-actions', role: 'group', 'aria-label': `${selected}への操作`, children: [
            jsx.jsxs('div', { className: 'yf-steps', children: [jsx.jsxs('button', {
              type: 'button', className: 'yf-top', disabled: busy || reading.busy || !selectionVisible,
              'aria-label': '先頭へ', title: `一覧の先頭へ戻る${lastAction === 'reading' && details ? '\n' + details : ''}`, onClick: () => navigate({ target, mode: 'top' }), children: [icon('top'), '先頭'],
            }),
            ...[-1, 1].map(direction => jsx.jsxs('button', {
              type: 'button', className: direction === 1 ? 'yf-down' : 'yf-up', disabled: busy || reading.busy || !selectionVisible,
              title: `${prefs.mode === 'page' ? '画面の約8割' : '投稿ごと'}に${direction === 1 ? '下' : '上'}へ移動${lastAction === 'reading' && details ? '\n' + details : ''}`,
              onClick: () => navigate({ target, direction, mode: prefs.mode }), children: [icon(direction === 1 ? 'down' : 'up'), direction === 1 ? '下へ' : '上へ'],
            }, direction)),
            ] }),
            canRefresh && jsx.jsx('div', { className: 'yf-refresh-area', children:
              jsx.jsx('button', {
                type: 'button', className: 'yf-refresh', translate: 'no',
                disabled: busy ? !onCancelRefresh : reading.busy || !targetReady || refreshCount === 0 || view.phase === 'cooldown' || view.phase === 'cancelled',
                'aria-label': busy ? '更新を中止する' : '選択中の列を更新', 'aria-busy': busy,
                title: busy ? `${refreshText}。クリックで中止` : `${view.phase === 'cooldown' || view.phase === 'cancelled' ? '次の更新まで少しお待ちください。' : ''}${lastAction === 'refresh' && refreshDetails ? refreshDetails + '\n' : ''}${refreshCount ? `選択範囲内の${refreshTargets}を先頭へ戻してから順番に更新します。おすすめ・フォロー中は新着読み込み、累計200件以上の警告がある列と検索結果・話題を検索（トレンド・ニュースなど）は現在のページを再読み込みします。検索語・タブ・絞り込み条件を維持します` : '選択範囲内に更新対象の列がありません'}`,
                onClick: () => { if (busy) onCancelRefresh?.(); else { setLastAction('refresh'); onRefresh({ target }); } }, children: [icon('refresh'), refreshLabel],
              }),
            }),
          ] }),
          jsx.jsx('div', { id: 'yomikui-home-refresh-status', className: 'yf-sr-only', role: 'status', 'aria-live': 'polite', children: statusText }),
          jsx.jsxs('div', { id: 'yomikui-reading-settings', className: 'yf-fields', hidden: !settingsOpen, children: [
            jsx.jsxs('label', { className: 'yf-setting', children: [jsx.jsx('span', { children: '移動方式' }), jsx.jsxs('span', { className: 'yf-color-select', children: [jsx.jsxs('select', { 'aria-label': '移動方式', value: prefs.mode, disabled: busy || reading.busy, onChange: event => updatePrefs({ mode: event.currentTarget.value }), children: [jsx.jsx('option', { value: 'post', children: '投稿ごと' }), jsx.jsx('option', { value: 'page', children: '画面ごと' })] }), icon('down')] })] }),
            jsx.jsxs('label', { className: 'yf-setting', htmlFor: 'yomikui-panel-color', children: [
              jsx.jsx('span', { children: '背景色' }), jsx.jsxs('span', { className: 'yf-color-select', children: [
                jsx.jsx('select', { id: 'yomikui-panel-color', 'aria-label': '背景色', value: prefs.color, onChange: event => updatePrefs({ color: event.currentTarget.value }), children: Object.entries(COLORS).map(([value, title]) => jsx.jsx('option', { value, children: title }, value)) }), icon('down'),
              ] }),
            ] }),
            jsx.jsxs('label', { className: 'yf-transparency', htmlFor: 'yomikui-panel-transparency', title: '背景の透明度（0%で不透明）', children: [
              jsx.jsx('span', { children: '透明度' }),
              jsx.jsx('input', { id: 'yomikui-panel-transparency', type: 'range', min: 0, max: 80, step: 5, value: prefs.transparency, 'aria-label': '背景の透明度', 'aria-valuetext': `${prefs.transparency}%`, onChange: event => updatePrefs({ transparency: Number(event.currentTarget.value) }) }),
              jsx.jsx('span', { className: 'yf-transparency-value', 'aria-hidden': true, children: `${prefs.transparency}%` }),
            ] }),
          ] }),
        ] }),
      ],
    });
  }

  globalThis.YomikuiFloatingControls = Object.freeze({ ReadingController, PanelPosition, Panel, installWheel, visibleColumnIds, preferences, selectionPreferences, loadPreferences, savePreferences, loadTarget, saveTarget, matchesTarget, readingSummary, installStyles });
})();
