(function () {
  if (window.__yomikuiXTransactionBridgeInstalled) return;
  window.__yomikuiXTransactionBridgeInstalled = true;

  const REQUEST = 'yomikui-x-transaction-request';
  const RESPONSE = 'yomikui-x-transaction-response';
  const ANIMATIONS = 'svg[id^="loading-x-anim-"]';
  const BOOKMARK_PATH = /^\/i\/api\/graphql\/[\w-]+\/(CreateBookmark|DeleteBookmark)$/;
  const snapshots = new Map();

  // X の初期化完了後や Yomikui のマウント時にブートストラップ用 SVG が削除されるため、事前にページのデータを退避して保持する
  function collect(root, nodes) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.matches?.(ANIMATIONS)) nodes.add(root);
    for (const node of root.querySelectorAll(ANIMATIONS)) nodes.add(node);
  }
  function capture(nodes) {
    for (const node of nodes) {
      if (node.querySelector('path[d]')) snapshots.set(node.id, node.cloneNode(true));
    }
  }
  const initial = new Set();
  collect(document, initial);
  capture(initial);
  const observer = new MutationObserver(records => {
    const nodes = new Set();
    for (const record of records) {
      const animation = record.target.closest?.(ANIMATIONS);
      if (animation) nodes.add(animation);
      for (const node of record.addedNodes) collect(node, nodes);
      for (const node of record.removedNodes) collect(node, nodes);
    }
    capture(nodes);
  });
  if (document.readyState === 'loading') {
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'd'],
    });
    document.addEventListener('DOMContentLoaded', () => {
      const nodes = new Set();
      collect(document, nodes);
      capture(nodes);
      observer.disconnect();
    }, { once: true });
  }

  let nativeGenerator;
  function getGenerator() {
    if (nativeGenerator) return nativeGenerator;
    const chunks = window.webpackChunk_twitter_responsive_web;
    if (!Array.isArray(chunks)) throw new Error('X runtime unavailable');
    let runtime;
    // X が読み込み済みのランタイムを利用（eval やトークンの直書き、モジュール ID の固定値化、外部スクリプト読み込みを回避）
    chunks.push([[`yomikui-transaction-${crypto.randomUUID()}`], {}, value => { runtime = value; }]);
    if (!runtime?.m) throw new Error('X runtime not ready');
    const pathNormalizer = /\.split\((["'])\?\1\)\[0\]\.trim\(\)/;
    for (const id of Object.keys(runtime.m)) {
      const factory = runtime.m[id];
      const source = Function.prototype.toString.call(factory);
      if (!source.includes('x-client-transaction-id') || !pathNormalizer.test(source)) continue;
      const exports = runtime(id);
      const candidate = Object.values(exports).find(value =>
        typeof value === 'function' && pathNormalizer.test(Function.prototype.toString.call(value)));
      if (candidate) {
        nativeGenerator = candidate;
        return candidate;
      }
    }
    throw new Error('X transaction generator unavailable');
  }

  async function generate(path, method) {
    const holder = document.createElement('div');
    holder.hidden = true;
    holder.setAttribute('aria-hidden', 'true');
    for (const [id, snapshot] of snapshots) {
      if (!document.getElementById(id)) holder.appendChild(snapshot.cloneNode(true));
    }
    if (holder.childElementCount) document.body.appendChild(holder);
    try {
      const token = await getGenerator()('https://x.com', path, method);
      if (typeof token !== 'string' || token.length < 16 || token.length > 512 || atob(token).startsWith('e:')) {
        throw new Error('X transaction generation failed');
      }
      return token;
    } finally {
      holder.remove();
    }
  }

  // トークン生成を直列化し、X の初期化中に並行リクエストでブートストラップ用ノードが削除されるのを防止
  let pending = Promise.resolve();
  window.addEventListener(REQUEST, event => {
    const { requestId, path, method } = event.detail ?? {};
    if (typeof requestId !== 'string' || requestId.length > 100 ||
        typeof path !== 'string' || !BOOKMARK_PATH.test(path) || method !== 'POST') return;
    pending = pending.then(async () => {
      let token = null;
      try { token = await generate(path, method); } catch { /* エラー時は安全側に倒し、取得済みトークンの再利用は行わない */ }
      window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { requestId, token } }));
    });
  });
})();
