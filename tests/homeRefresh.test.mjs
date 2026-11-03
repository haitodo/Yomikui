import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events, settle } from './helpers.mjs';

const source = readFileSync(new URL('../homeRefresh.js', import.meta.url), 'utf8');
const P = 'yomikui-home-refresh-';
const clone = value => JSON.parse(JSON.stringify(value));
const tweet = id => `<article data-testid="tweet"><a href="/author/status/${id}"><time>Now</time></a></article>`;
const tabs = (selected = 'recommended') => `<div style="display:none"><div role="tablist">
  <a role="tab" href="/home" id="recommended" aria-selected="${selected === 'recommended'}">おすすめ</a>
  <a role="tab" href="/home" id="following" aria-selected="${selected === 'following'}">フォロー中</a>
</div></div>`;
const home = (options = {}) => `<main><div data-testid="primaryColumn">
  <div id="tabs">${options.loading ? '' : tabs(options.selected)}</div>
  ${options.banner ? `<button id="new-posts">${options.banner}</button>` : ''}
  <div id="tweets">${tweet('101')}</div>${options.extra ?? ''}
</div></main>`;

function setup(html = home()) {
  const clock = new Clock();
  const dom = parseHTML(`<html><head></head><body>${html}</body></html>`);
  const { document } = dom;
  document.hidden = false;
  const window = new Events();
  window.self = window;
  window.top = {};
  window.location = { pathname: '/home', origin: 'https://x.com' };
  window.scrollTo = () => { throw new Error('A column scroller was supplied'); };
  const messages = [];
  window.parent = { postMessage: (data, origin) => messages.push({ data: clone(data), origin }) };
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.inner = new dom.window.MutationObserver(callback);
      observers.push(this);
    }
    observe(...args) { this.connected = true; this.inner.observe(...args); }
    disconnect() { this.connected = false; this.inner.disconnect(); }
  }
  const context = vm.createContext({
    ...clock.globals(), window, document, MutationObserver, AbortController, DOMException,
    crypto: { randomUUID }, URL,
    fetch() { throw new Error('Native home refresh must not call an API'); },
  });
  vm.runInContext(source, context);
  const settings = { columnType: 'home', isLiveFeedColumn: false };
  const scroller = { scrollTop: 800 };
  const options = {
    getSettings: () => settings, getScroller: () => scroller,
    getOrigin: () => 'https://x.com', getColumnId: () => 'column1',
  };
  const api = context.YomikuiHomeRefresh;
  return { api, context, window, document, settings, scroller, clock, messages, observers, options };
}

async function beginNative(env, refresher = new env.api.NativeRefresher(env.options), signal) {
  const pending = refresher.refresh(signal);
  await settle();
  return { pending, refresher };
}

test('a CSS-hidden selected recommendation tab refreshes once without exposing the tab bar', async () => {
  const env = setup();
  let clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => {
    clicks++;
    env.document.getElementById('tweets').innerHTML = tweet('202');
  });
  const { pending, refresher } = await beginNative(env);
  await env.clock.advance(200);
  assert.deepEqual(clone(await pending), { status: 'updated', method: 'tab' });
  assert.equal(clicks, 1);
  assert.equal(env.scroller.scrollTop, 0);
  assert.equal(env.document.querySelector('#tabs > div').style.display, 'none');
  assert.equal((await refresher.refresh()).reason, 'cooldown');
  assert.equal(clicks, 1);
  assert.equal(env.observers.filter(observer => observer.connected).length, 0);
  assert.equal(env.clock.timers.size, 0);
});

for (const banner of ['35件のポスト表示', '35件のポストを表示', '３５件のツイートを表示', 'Show 35 posts', 'Show new posts']) {
  test(`an existing native banner is preferred over another fetch: ${banner}`, async () => {
    const env = setup(home({ banner }));
    const clicks = [];
    env.document.getElementById('recommended').addEventListener('click', () => clicks.push('tab'));
    env.document.getElementById('new-posts').addEventListener('click', () => {
      clicks.push('banner');
      env.document.getElementById('tweets').innerHTML = tweet('202');
    });
    const { pending } = await beginNative(env);
    await env.clock.advance(200);
    assert.deepEqual(clone(await pending), { status: 'updated', method: 'new-posts' });
    assert.deepEqual(clicks, ['banner']);
  });
}

test('tweet text and unrelated buttons cannot impersonate a new-posts banner', async () => {
  const env = setup(home({ extra: '<button id="other">Show probable spam</button><article data-testid="tweet"><button id="fake">Show 35 posts</button></article>' }));
  let wrongClicks = 0;
  for (const id of ['fake', 'other']) env.document.getElementById(id).addEventListener('click', () => wrongClicks++);
  env.document.getElementById('recommended').addEventListener('click', () => {
    env.document.getElementById('tweets').innerHTML = tweet('202');
  });
  const { pending } = await beginNative(env);
  await env.clock.advance(200);
  assert.equal((await pending).method, 'tab');
  assert.equal(wrongClicks, 0);
});

test('unchanged posts are reported as unconfirmed and never trigger a second click', async () => {
  const env = setup();
  let clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => clicks++);
  const { pending } = await beginNative(env);
  await env.clock.advance(5200);
  assert.deepEqual(clone(await pending), { status: 'requested', method: 'tab' });
  assert.equal(clicks, 1);
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.observers.filter(observer => observer.connected).length, 0);
});

test('an empty X composer with placeholder and accessibility labels does not block a visible new-posts banner', async () => {
  const env = setup(home({ banner: '35件のポストを表示', extra: `
    <div data-testid="tweetTextarea_0_label">ポストのテキスト</div>
    <div data-testid="tweetTextarea_0RichTextInputContainer">
      <div class="public-DraftEditorPlaceholder-root">いまどうしてる？</div>
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"><div><br></div></div>
    </div>
    <div data-testid="attachments"></div>` }));
  let clicks = 0;
  env.document.getElementById('new-posts').addEventListener('click', () => {
    clicks++;
    env.document.getElementById('tweets').innerHTML = tweet('202');
  });
  const { pending } = await beginNative(env);
  await env.clock.advance(200);
  assert.deepEqual(clone(await pending), { status: 'updated', method: 'new-posts' });
  assert.equal(clicks, 1);
});

test('a real draft inside the X rich-text wrapper still prevents a refresh', async () => {
  const env = setup(home({ banner: '35件のポストを表示', extra: `
    <div data-testid="tweetTextarea_0RichTextInputContainer">
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">未送信のポスト</div>
    </div>` }));
  let clicks = 0;
  env.document.getElementById('new-posts').addEventListener('click', () => clicks++);
  const result = await new env.api.NativeRefresher(env.options).refresh();
  assert.equal(result.reason, 'draft');
  assert.equal(clicks, 0);
});

for (const scenario of [
  { reason: 'following', html: home({ selected: 'following' }) },
  { reason: 'draft', html: home({ extra: '<div data-testid="tweetTextarea_0" contenteditable="true">Unsent post</div>' }) },
  { reason: 'draft', html: home({ extra: '<div data-testid="attachments"><img alt="Unsent photo"></div>' }) },
  { reason: 'dialog', html: home({ extra: '<div role="dialog">A composer</div>' }) },
  { reason: 'not-home', change: env => { env.window.location.pathname = '/author/status/123'; } },
  { reason: 'not-home', change: env => { env.settings.isLiveFeedColumn = true; } },
  { reason: 'hidden', change: env => { env.document.hidden = true; } },
]) {
  test(`an ineligible native frame is skipped without scrolling or clicking: ${scenario.reason}`, async () => {
    const env = setup(scenario.html);
    scenario.change?.(env);
    let clicks = 0;
    env.document.getElementById('recommended').addEventListener('click', () => clicks++);
    const result = await new env.api.NativeRefresher(env.options).refresh();
    assert.equal(result.reason, scenario.reason);
    assert.equal(env.scroller.scrollTop, 800);
    assert.equal(clicks, 0);
    assert.equal(env.clock.timers.size, 0);
  });
}

test('tabs that render after frame startup are awaited and all observation is bounded', async () => {
  const env = setup(home({ loading: true }));
  const { pending } = await beginNative(env);
  env.document.getElementById('tabs').innerHTML = tabs();
  env.document.getElementById('recommended').addEventListener('click', () => {
    env.document.getElementById('tweets').innerHTML = tweet('202');
  });
  await settle();
  await env.clock.advance(280);
  assert.equal((await pending).status, 'updated');
  assert.equal(env.clock.timers.size, 0);
  const missing = setup(home({ loading: true }));
  const waiting = await beginNative(missing);
  await missing.clock.advance(4000);
  assert.equal((await waiting.pending).reason, 'unavailable');
  assert.equal(missing.observers.filter(observer => observer.connected).length, 0);
});

test('user tab changes during preparation prevent the pending recommendation click', async () => {
  const env = setup();
  let clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => clicks++);
  const { pending } = await beginNative(env);
  env.document.getElementById('recommended').setAttribute('aria-selected', 'false');
  env.document.getElementById('following').setAttribute('aria-selected', 'true');
  await env.clock.advance(200);
  assert.equal((await pending).reason, 'following');
  assert.equal(clicks, 0);
});

test('cancellation releases readiness observers and timers without clicking', async () => {
  const env = setup(home({ loading: true }));
  const abort = new AbortController();
  const { pending } = await beginNative(env, undefined, abort.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  abort.abort();
  await rejection;
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.observers.filter(observer => observer.connected).length, 0);
});

test('the frame protocol validates sender, origin, column and target, and deduplicates requests', async () => {
  const env = setup();
  let clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => {
    clicks++;
    env.document.getElementById('tweets').innerHTML = tweet('202');
  });
  const installed = env.api.installFrame(env.options);
  const data = { type: P + 'request', requestId: 'request1', columnId: 'column1', target: 'recommended' };
  const send = (changes = {}, event = {}) => env.window.emit('message', {
    source: env.window.parent, origin: 'https://x.com', data: { ...data, ...changes }, ...event,
  });
  send({}, { source: {} });
  send({}, { origin: 'https://untrusted.example' });
  send({ columnId: 'another' });
  send({ target: 'following' });
  assert.equal(env.messages.length, 0);
  send({ type: P + 'probe' });
  assert.equal(env.messages.at(-1).data.type, P + 'ready');
  assert.equal(clicks, 0);
  send();
  send();
  await settle();
  await env.clock.advance(200);
  assert.equal(env.messages.at(-1).data.status, 'updated');
  send();
  assert.equal(clicks, 1);
  assert.equal(env.messages.at(-1).data.status, 'updated');
  send({ requestId: 'request2' });
  await settle();
  assert.equal(env.messages.at(-1).data.reason, 'cooldown');
  installed.dispose();
  assert.equal(env.clock.timers.size, 0);
});

function batchSetup({ columns, quiet, late } = {}) {
  const env = setup();
  const state = {
    activeWorkspaceId: 'workspace1',
    columns: columns ?? [{ id: 'home1', type: 'home' }, { id: 'home2', type: 'home' }],
    columnComposing: {}, markColumnActivity: id => activity.push(id),
  };
  const activity = [];
  const messages = [];
  const mounts = [];
  const views = [];
  const frames = new Map();
  for (const column of state.columns) {
    const frame = { postMessage(data, origin) {
      messages.push({ ...clone(data), origin });
      if (quiet?.(column.id, data.type)) return;
      if (data.type === P + 'probe') {
        env.window.emit('message', { source: frame, origin, data: { ...data, type: P + 'ready' } });
      } else if (data.type === P + 'request') {
        env.clock.setTimeout(() => env.window.emit('message', { source: frame, origin, data: { ...data, type: P + 'result', status: 'updated', method: 'tab' } }), 30);
      }
    } };
    frames.set(column.id, frame);
  }
  const unavailable = new Set(late ?? []);
  const batch = new env.api.BatchRefresher({
    getState: () => state,
    getFrame: id => unavailable.has(id) ? null : { window: frames.get(id), origin: 'https://x.com' },
    setMounted(ids) {
      mounts.push([...ids]);
      for (const id of ids) if (unavailable.has(id)) env.clock.setTimeout(() => unavailable.delete(id), 150);
    },
    onChange: value => views.push(clone(value)),
  });
  return { ...env, batch, state, activity, messages, mounts, frames, views };
}

test('one user action updates every native home sequentially, including an unmounted offscreen column', async () => {
  const env = batchSetup({
    columns: [
      { id: 'home1', type: 'home' }, { id: 'search', type: 'search' },
      { id: 'live', type: 'home', liveFeed: true }, { id: 'home2', type: 'home' },
      { id: 'draft', type: 'home' },
    ], late: ['home2'],
  });
  env.state.columnComposing.draft = true;
  const run = env.batch.run();
  await env.batch.run();
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1']);
  await env.clock.advance(1500);
  await run;
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1', 'home2']);
  assert.equal(env.views.at(-1).total, 3);
  assert.deepEqual(env.views.at(-1).results.map(item => item.status), ['updated', 'updated', 'skipped']);
  assert.equal(env.views.at(-1).results.at(-1).reason, 'draft');
  assert.ok(env.mounts.every(ids => ids.length <= 1));
  assert.deepEqual(env.mounts.at(-1), []);
  assert.deepEqual(env.activity, ['home1', 'home2']);
  const sent = env.messages.length;
  await env.batch.run();
  assert.equal(env.messages.length, sent, 'cooldown prevents another batch');
  await env.clock.advance(5000);
  assert.equal(env.clock.timers.size, 0, 'the idle control has no polling timers');
  env.batch.dispose();
});

test('spoofed and stale result messages cannot advance the batch', async () => {
  const env = batchSetup({ quiet: () => true });
  const run = env.batch.run();
  const request = env.messages[0];
  const valid = { source: env.frames.get('home1'), origin: 'https://x.com', data: { ...request, type: P + 'ready' } };
  env.window.emit('message', { ...valid, source: {} });
  env.window.emit('message', { ...valid, origin: 'https://untrusted.example' });
  env.window.emit('message', { ...valid, data: { ...valid.data, columnId: 'home2' } });
  env.window.emit('message', { ...valid, data: { ...valid.data, requestId: 'stale' } });
  assert.equal(env.messages.length, 1);
  env.window.emit('message', valid);
  assert.equal(env.messages[1].type, P + 'request');
  env.window.emit('message', { ...valid, data: { ...valid.data, type: P + 'result', status: 'invented' } });
  assert.equal(env.views.at(-1).done, 0);
  env.batch.cancel();
  await run;
  env.batch.dispose();
  assert.equal(env.clock.timers.size, 0);
});

test('saved and recently selected Following tabs are skipped before mounting a frame', async () => {
  const env = batchSetup({ columns: [
    { id: 'home1', type: 'home', activeTab: 'フォロー中' },
    { id: 'home2', type: 'home', activeTab: 'おすすめ' },
    { id: 'home3', type: 'home', activeTab: 'For you' },
  ] });
  env.state.columnActiveTabs = { home2: 'Following' };
  const run = env.batch.run();
  await env.clock.advance(1000);
  await run;
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home3']);
  assert.deepEqual(env.views.at(-1).results.map(item => item.status), ['skipped', 'skipped', 'updated']);
  assert.deepEqual(env.mounts.filter(ids => ids.length), [['home3']]);
  env.batch.dispose();
});

test('a frame that never becomes ready times out without blocking remaining columns', async () => {
  const env = batchSetup({ quiet: id => id === 'home1' });
  const run = env.batch.run();
  await env.clock.advance(13000);
  await run;
  assert.equal(env.views.at(-1).results[0].reason, 'timeout');
  assert.equal(env.views.at(-1).results[1].status, 'updated');
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home2']);
  env.batch.dispose();
  assert.equal(env.clock.timers.size, 0);
});

test('a request timeout sends cancellation and continues without repeating the update', async () => {
  const env = batchSetup({ quiet: (id, type) => id === 'home1' && type === P + 'request' });
  const run = env.batch.run();
  await env.clock.advance(12000);
  await run;
  assert.equal(env.views.at(-1).results[0].reason, 'timeout');
  assert.equal(env.views.at(-1).results[0].status, 'failed');
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1', 'home2']);
  assert.equal(env.messages.filter(item => item.type === P + 'cancel').length, 1);
  env.batch.dispose();
});

for (const cause of ['workspace', 'hidden', 'pagehide']) {
  test(`changing ${cause} cancels the active operation and leaves queued columns alone`, async () => {
    const env = batchSetup({ quiet: (id, type) => type === P + 'request' });
    const run = env.batch.run();
    if (cause === 'workspace') {
      env.state.activeWorkspaceId = 'workspace2';
      env.batch.syncState();
    } else if (cause === 'hidden') {
      env.document.hidden = true;
      env.document.dispatchEvent(new (parseHTML('<html></html>').Event)('visibilitychange'));
    } else env.window.emit('pagehide');
    await run;
    assert.equal(env.views.at(-1).phase, 'cancelled');
    assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1']);
    assert.deepEqual(env.mounts.at(-1), []);
    env.batch.dispose();
    assert.equal(env.clock.timers.size, 0);
  });
}

test('disposing during a running batch clears timers and temporary mounts', async () => {
  const env = batchSetup({ quiet: () => true, late: ['home1'] });
  const run = env.batch.run();
  env.batch.dispose();
  await run;
  // The fixture's delayed mount completion is independent of the controller.
  await env.clock.advance(150);
  assert.equal(env.clock.timers.size, 0);
  assert.deepEqual(env.mounts.at(-1), []);
});

test('a late native frame-ready event allows a new readiness probe but only one update', async () => {
  let ready = false;
  const env = batchSetup({ quiet: (id, type) => !ready && type === P + 'probe' });
  const run = env.batch.run();
  ready = true;
  env.window.emit('message', { source: env.frames.get('home1'), origin: 'https://x.com', data: { type: 'yomikui-frame-ready', columnId: 'home1' } });
  await env.clock.advance(1000);
  await run;
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1', 'home2']);
  env.batch.dispose();
});

test('the shipped dashboard renders one floating control and keeps its target frame mounted', () => {
  const env = setup();
  const deck = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');
  const start = deck.indexOf('hY=()=>');
  const end = deck.indexOf(';var Wee=', start);
  assert.ok(start > 0 && end > start);
  const columns = [{ id: 'offscreen', type: 'home', title: 'Home', accentColor: '#123' }];
  const store = selector => selector({ initialized: true, columns, theme: 'dark' });
  store.getState = () => ({ columns });
  const element = (type, props) => ({ type, props });
  const react = {
    useState: initial => [typeof initial === 'function' ? new Set(['offscreen']) : initial, () => {}],
    useRef: current => ({ current }), useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
  };
  Object.assign(env.context, {
    Ut: store, rr: value => value, Ke: react, vt: { jsx: element, jsxs: element, Fragment: 'Fragment' },
    en: () => key => key, rg: () => [], L0e: () => true, gY() {}, n$: () => false, T0e: 2,
  });
  for (const name of ['PW', '_f', 'hf', 'pf', 'ZR', 'Cm', 'k1', 'UA', 'SW', 'eK', 'ym']) env.context[name] = name;
  vm.runInContext('globalThis.render = ' + deck.slice(start + 'hY='.length, end) + ';', env.context);
  const tree = env.context.render();
  const nodes = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) visit(child);
  };
  visit(tree);
  const controls = nodes.filter(node => node.type === env.api.FloatingControl);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].props.store, store);
  assert.equal(nodes.find(node => node.type === 'UA').props.keepMounted, true);
});

test('the shipped native initializer installs the refresher with the actual column accessors', () => {
  const env = setup();
  const bundle = readFileSync(new URL('../contentIframe.js', import.meta.url), 'utf8');
  const start = bundle.indexOf('function startNativeHomeRefresh()');
  const end = bundle.indexOf('function EO(', start);
  assert.ok(start > 0 && end > start);
  Object.assign(env.context, { je: env.settings, _Q: () => env.scroller, Uh: 'https://x.com', ln: 'column1' });
  vm.runInContext(bundle.slice(start, end) + 'startNativeHomeRefresh();', env.context);
  env.window.emit('message', { source: env.window.parent, origin: 'https://x.com', data: { type: P + 'probe', columnId: 'column1', requestId: 'probe' } });
  assert.equal(env.messages.at(-1).data.type, P + 'ready');
  assert.match(bundle, /HO\(\),startFrameMaintenance\(\),startNativeHomeRefresh\(\)/);
});

test('the helper is loaded before each bundle and is safe to load twice in the top frame', () => {
  const env = setup();
  vm.runInContext(source, env.context);
  assert.equal(env.context.YomikuiHomeRefresh, env.api);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const bundle of ['contentDeck.js', 'contentIframe.js']) {
    const entry = manifest.content_scripts.find(script => script.js.includes(bundle));
    assert.ok(entry.js.indexOf('homeRefresh.js') >= 0);
    assert.ok(entry.js.indexOf('homeRefresh.js') < entry.js.indexOf(bundle));
  }
  assert.equal(env.api.summary({ phase: 'idle', results: [{ status: 'requested' }] }), '操作済み・表示変化未確認 1列');
  assert.equal(env.api.summary({ phase: 'idle', results: [
    { status: 'skipped', reason: 'draft' }, { status: 'skipped', reason: 'draft' },
  ] }), 'スキップ 2列（投稿を入力中）');
});
