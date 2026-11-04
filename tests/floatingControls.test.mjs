import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events, settle } from './helpers.mjs';

const source = readFileSync(new URL('../floatingControls.js', import.meta.url), 'utf8');
const scroll = readFileSync(new URL('../homeScroll.js', import.meta.url), 'utf8');
const PREFIX = 'yomikui-home-refresh-';
const clone = value => JSON.parse(JSON.stringify(value));

function setup() {
  const clock = new Clock();
  const { document, window: dom } = parseHTML('<html><body></body></html>');
  document.hidden = false;
  const window = new Events();
  Object.assign(window, { innerWidth: 1000, innerHeight: 800, location: { origin: 'https://x.com' } });
  const saved = {}, writes = [];
  const chrome = { storage: { local: {
    async get(key) { return { [key]: saved[key] }; },
    async set(value) { writes.push(clone(value)); Object.assign(saved, clone(value)); },
  } } };
  const observers = [];
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({ ...clock.globals(), document, window, chrome, ResizeObserver, crypto: { randomUUID } });
  vm.runInContext(scroll, context);
  vm.runInContext(source, context);
  return { clock, document, dom, window, saved, writes, observers, context, api: context.YomikuiFloatingControls };
}

function readingSetup({ quiet = false } = {}) {
  const env = setup();
  const columns = [
    { id: 'one', type: 'home', title: 'One' }, { id: 'two', type: 'home', title: 'Two' },
    { id: 'offscreen', type: 'home' }, { id: 'live', type: 'home', liveFeed: true },
    { id: 'history', type: 'timeline' }, { id: 'following', type: 'following' },
  ];
  const state = { columns, activeWorkspaceId: 'workspace', columnComposing: {} };
  const visible = new Set(['one', 'two', 'live', 'history', 'following']);
  const frames = new Map(), messages = [], views = [], activity = [];
  state.markColumnActivity = id => activity.push(id);
  for (const column of columns) {
    const frame = { postMessage(data, origin) {
      messages.push({ ...clone(data), origin });
      if (!quiet) env.clock.setTimeout(() => env.window.emit('message', {
        source: frame, origin, data: { ...data, type: PREFIX + 'navigated', status: 'moved' },
      }), 10);
    } };
    frames.set(column.id, frame);
  }
  const controller = new env.api.ReadingController({
    getState: () => state,
    getVisibleIds: () => visible,
    getFrame: id => ({ window: frames.get(id), origin: 'https://x.com' }),
    onChange: view => views.push(clone(view)),
  });
  return { ...env, state, visible, frames, messages, views, activity, controller };
}

test('one reading action addresses only visible native columns and includes Following', async () => {
  const env = readingSetup();
  const run = env.controller.move({ direction: 1, mode: 'post' });
  assert.deepEqual(env.messages.map(message => message.columnId), ['one', 'two', 'following']);
  await env.controller.move({ direction: -1, mode: 'page' });
  assert.equal(env.messages.length, 3, 'a rapid second action is not queued');
  await env.clock.advance(300);
  await run;
  assert.equal(env.views.at(-1).message, '移動 3列');
  assert.deepEqual(env.activity, ['one', 'two', 'following']);
  assert.equal(env.clock.timers.size, 0);
  env.controller.dispose();
});

test('returning to the top uses the current all-visible or individual target', async () => {
  const env = readingSetup();
  const all = env.controller.move({ mode: 'top' });
  assert.deepEqual(env.messages.map(message => message.columnId), ['one', 'two', 'following']);
  assert.ok(env.messages.every(message => message.mode === 'top'));
  await env.clock.advance(300);
  await all;
  const selected = env.controller.move({ target: 'two', mode: 'top' });
  assert.deepEqual(env.messages.slice(3).map(message => message.columnId), ['two']);
  await env.clock.advance(300);
  await selected;
  assert.equal(env.views.at(-1).message, '移動 1列');
  env.controller.dispose();
});

test('a chosen column that leaves the screen never falls back to moving other columns', async () => {
  const env = readingSetup();
  env.visible.delete('one');
  await env.controller.move({ target: 'one', direction: 1, mode: 'page' });
  assert.equal(env.messages.length, 0);
  assert.match(env.views.at(-1).message, /画面内/);
  const run = env.controller.move({ target: 'two', direction: -1, mode: 'page' });
  await env.clock.advance(300);
  await run;
  assert.deepEqual(env.messages.map(message => message.columnId), ['two']);
  assert.equal(env.messages[0].direction, -1);
  env.controller.dispose();
});

test('reading skips composing or unmounted columns without trying to mount or retry them', async () => {
  const env = readingSetup();
  env.state.columnComposing.one = true;
  env.frames.delete('two');
  const run = env.controller.move({ direction: 1, mode: 'post' });
  await env.clock.advance(300);
  await run;
  assert.deepEqual(env.messages.map(message => message.columnId), ['following']);
  assert.deepEqual(env.views.at(-1).results.map(result => result.status), ['skipped', 'skipped', 'moved']);
  env.controller.dispose();
});

test('spoofed navigation results are ignored and a missing frame response has a bounded timeout', async () => {
  const env = readingSetup({ quiet: true });
  const run = env.controller.move({ target: 'one', direction: 1, mode: 'post' });
  const response = { source: env.frames.get('one'), origin: 'https://x.com', data: { ...env.messages[0], type: PREFIX + 'navigated', status: 'moved' } };
  for (const event of [
    { ...response, source: {} }, { ...response, origin: 'https://evil.example' },
    { ...response, data: { ...response.data, columnId: 'two' } },
    { ...response, data: { ...response.data, requestId: 'stale' } },
    { ...response, data: { ...response.data, status: 'invented' } },
  ]) env.window.emit('message', event);
  assert.equal(env.views.at(-1).busy, true);
  await env.clock.advance(1200);
  await run;
  assert.equal(env.views.at(-1).results[0].reason, 'timeout');
  assert.equal(env.messages.length, 1);
  assert.equal(env.clock.timers.size, 0);
  env.controller.dispose();
});

for (const cause of ['workspace', 'hidden', 'pagehide', 'dispose']) {
  test(`reading cancellation on ${cause} releases all deadlines`, async () => {
    const env = readingSetup({ quiet: true });
    const run = env.controller.move({ direction: 1, mode: 'post' });
    if (cause === 'workspace') { env.state.activeWorkspaceId = 'new'; env.controller.syncState(); }
    if (cause === 'hidden') { env.document.hidden = true; env.document.dispatchEvent(new env.dom.Event('visibilitychange')); }
    if (cause === 'pagehide') env.window.emit('pagehide');
    if (cause === 'dispose') env.controller.dispose();
    await run;
    assert.equal(env.clock.timers.size, 0);
    assert.equal(env.controller.pending.size, 0);
    env.controller.dispose();
    assert.ok([...env.window.listeners.values()].every(listeners => listeners.length === 0));
  });
}

test('rack visibility excludes the preload margin, clipped rows and zero-size columns', () => {
  const env = setup();
  const rack = env.document.createElement('div');
  rack.className = 'rd-rack';
  rack.getBoundingClientRect = () => ({ left: 60, right: 900, top: 20, bottom: 800 });
  const bounds = [
    ['left', 0, 50, 20, 800], ['visible', 60, 400, 20, 800],
    ['partial', 850, 1100, 20, 800], ['preloaded', 1000, 1300, 20, 800],
    ['below', 60, 400, 810, 1000], ['empty', 400, 400, 20, 800],
    ['rounding-sliver', 899.96, 1200, 20, 800],
  ];
  for (const [id, left, right, top, bottom] of bounds) {
    const element = env.document.createElement('div');
    element.setAttribute('data-column-id', id);
    element.getBoundingClientRect = () => ({ left, right, top, bottom, width: right - left, height: bottom - top });
    rack.appendChild(element);
  }
  env.document.body.appendChild(rack);
  assert.deepEqual([...env.api.visibleColumnIds()], ['visible', 'partial']);
});

function positionSetup() {
  const env = setup();
  const panel = env.document.createElement('section');
  const handle = env.document.createElement('button');
  panel.appendChild(handle);
  env.document.body.appendChild(panel);
  let panelHeight = 280;
  Object.defineProperty(panel, 'offsetWidth', { get: () => Math.min(286, env.window.innerWidth - 16) });
  Object.defineProperty(panel, 'offsetHeight', { get: () => panelHeight });
  handle.focus = () => {};
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  const commits = [];
  const position = new env.api.PanelPosition({ panel, handle, position: {}, onCommit: value => commits.push(clone(value)) });
  const emit = (type, fields) => {
    const event = new env.dom.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, fields);
    handle.dispatchEvent(event);
  };
  const pointer = (type, x, y, id = 1) => emit(type, { clientX: x, clientY: y, pointerId: id, button: 0 });
  return { ...env, panel, handle, commits, position, emit, pointer, setHeight: value => { panelHeight = value; } };
}

test('panel dragging clamps to the viewport, shields frames and saves only a completed drag', () => {
  const env = positionSetup();
  assert.equal(env.panel.style.left, '706px');
  env.pointer('pointerdown', 710, 520);
  assert.equal(env.document.body.children.length, 2, 'the drag shield covers underlying frames');
  env.pointer('pointermove', 712, 521);
  env.pointer('pointerup', 712, 521);
  assert.equal(env.commits.length, 0);
  assert.equal(env.document.body.children.length, 1);
  env.pointer('pointerdown', 710, 520);
  env.pointer('pointermove', -5000, -5000);
  env.pointer('pointerup', -5000, -5000);
  assert.equal(env.panel.style.left, '8px');
  assert.equal(env.panel.style.top, '8px');
  assert.deepEqual(env.commits, [{ x: 0, y: 0 }]);
  env.position.dispose();
});

test('Escape, lost capture and disposal cancel dragging without persisting a partial move', () => {
  for (const cause of ['escape', 'capture', 'dispose']) {
    const env = positionSetup();
    const before = env.panel.style.left;
    env.pointer('pointerdown', 710, 520);
    env.pointer('pointermove', 100, 100);
    if (cause === 'escape') env.emit('keydown', { key: 'Escape' });
    if (cause === 'capture') env.pointer('lostpointercapture', 100, 100);
    if (cause === 'dispose') env.position.dispose();
    assert.equal(env.panel.style.left, before);
    assert.equal(env.commits.length, 0);
    assert.equal(env.document.body.children.length, 1);
    env.position.dispose();
    assert.ok(env.observers.every(observer => observer.disconnected));
  }
});

test('keyboard movement and viewport or panel resizing keep controls reachable', () => {
  const env = positionSetup();
  env.emit('keydown', { key: 'ArrowLeft', shiftKey: false });
  assert.equal(env.panel.style.left, '696px');
  assert.equal(env.commits.length, 1);
  env.window.innerWidth = 320;
  env.window.innerHeight = 400;
  env.window.emit('resize');
  assert.ok(parseFloat(env.panel.style.left) + env.panel.offsetWidth <= 312);
  assert.ok(parseFloat(env.panel.style.top) + env.panel.offsetHeight <= 392);
  env.setHeight(180);
  env.observers[0].callback();
  assert.equal(env.panel.style.top, '212px');
  env.position.dispose();
});

test('a dragged header stays in place when folding or status text changes the panel height', () => {
  const env = positionSetup();
  env.pointer('pointerdown', 710, 520);
  env.pointer('pointermove', 400, 300);
  env.pointer('pointerup', 400, 300);
  const original = { left: env.panel.style.left, top: env.panel.style.top };
  env.setHeight(180);
  env.observers[0].callback();
  assert.equal(env.panel.style.left, original.left);
  assert.equal(env.panel.style.top, original.top);
  env.position.dispose();
  const reloaded = new env.api.PanelPosition({ panel: env.panel, handle: env.handle, position: env.commits.at(-1), onCommit() {} });
  assert.equal(env.panel.style.top, original.top);
  reloaded.dispose();
});

test('panel preferences persist locally in order and normalize invalid values', async () => {
  const env = setup();
  assert.deepEqual(clone(await env.api.loadPreferences()), { x: 1, y: 1, collapsed: false, mode: 'post' });
  const first = env.api.savePreferences({ x: -20, y: 3, collapsed: true, mode: 'page' });
  const last = env.api.savePreferences({ x: .4, y: .2, collapsed: false, mode: 'post' });
  await Promise.all([first, last]);
  assert.deepEqual(env.writes[0].yomikui_floating_controls_v1, { x: 0, y: 1, collapsed: true, mode: 'page' });
  assert.deepEqual(clone(await env.api.loadPreferences()), { x: .4, y: .2, collapsed: false, mode: 'post' });
});

function panelTree(env, {
  collapsed = false, phase = 'idle', reading = false, target = 'all', mode = 'post', lastAction = 'reading',
  readingMessage = '', refreshText = '', onNavigate = () => {}, onRefresh = () => {},
} = {}) {
  const states = [env.api.preferences({ collapsed, mode }), target, new Set(['one']), lastAction];
  const react = {
    useState: () => [states.shift(), () => {}], useRef: current => ({ current }), useCallback: fn => fn,
    useEffect() {}, useLayoutEffect() {},
  };
  const element = (type, props) => ({ type, props });
  const tree = env.api.Panel({
    React: react, jsx: { jsx: element, jsxs: element },
    columns: [{ id: 'one', type: 'home', title: 'Home' }],
    view: { phase, done: 0, total: 1 }, reading: { busy: reading, results: [], message: readingMessage },
    canRefresh: true, refreshText, onRefresh, onNavigate,
  });
  const nodes = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of [node.props?.children].flat()) visit(child);
  };
  visit(tree);
  return nodes;
}

test('collapsed controls retain top, step actions and the separate all-home refresh', () => {
  const env = setup();
  const actions = [];
  let refreshed = 0;
  const nodes = panelTree(env, { collapsed: true, target: 'one', mode: 'page', onNavigate: action => actions.push(clone(action)), onRefresh: () => refreshed++ });
  const byClass = name => nodes.find(node => node.props?.className === name);
  assert.equal(byClass('yf-fields').props.hidden, true);
  for (const name of ['yf-top', 'yf-up', 'yf-down', 'yf-refresh']) assert.equal(byClass(name).props.disabled, false);
  byClass('yf-top').props.onClick();
  byClass('yf-down').props.onClick();
  assert.deepEqual(actions, [{ target: 'one', mode: 'top' }, { target: 'one', direction: 1, mode: 'page' }]);
  assert.equal(byClass('yf-refresh').props['aria-label'], 'ホームを一括更新', 'the icon-only refresh keeps an accessible name');
  byClass('yf-refresh').props.onClick();
  assert.equal(refreshed, 1);
  assert.match(byClass('yf-refresh').props.title, /ホーム列全体/);
});

test('one status line shows the latest operation and keeps full results available as a tooltip', () => {
  const env = setup();
  const refresh = panelTree(env, { lastAction: 'refresh', phase: 'cooldown', readingMessage: '移動 1列', refreshText: '表示更新 1列' });
  const refreshed = refresh.filter(node => node.props?.role === 'status');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].props.children, '表示更新 1列');
  assert.equal(refreshed[0].props.title, '表示更新 1列');
  const moving = panelTree(env, { lastAction: 'refresh', reading: true, readingMessage: '1列を移動中', refreshText: '表示更新 1列' });
  const moved = moving.filter(node => node.props?.role === 'status');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].props.children, '1列を移動中');
});

test('reading controls are disabled while refreshing; refresh cooldown still permits reading', () => {
  const env = setup();
  const running = panelTree(env, { phase: 'running' });
  assert.ok(running.filter(node => ['yf-top', 'yf-up', 'yf-down', 'yf-refresh'].includes(node.props?.className)).every(node => node.props.disabled));
  const cooldown = panelTree(env, { phase: 'cooldown' });
  assert.equal(cooldown.find(node => node.props?.className === 'yf-up').props.disabled, false);
  assert.equal(cooldown.find(node => node.props?.className === 'yf-top').props.disabled, false);
  assert.equal(cooldown.find(node => node.props?.className === 'yf-refresh').props.disabled, true);
  const moving = panelTree(env, { reading: true });
  assert.equal(moving.find(node => node.props?.className === 'yf-top').props.disabled, true);
  assert.equal(moving.find(node => node.props?.className === 'yf-refresh').props.disabled, true);
  const offscreen = panelTree(env, { target: 'offscreen' });
  assert.equal(offscreen.find(node => node.props?.className === 'yf-top').props.disabled, true);
});

test('the floating helper is included before the dashboard and is safe to load twice', () => {
  const env = setup();
  vm.runInContext(source, env.context);
  assert.equal(env.context.YomikuiFloatingControls, env.api);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const entry = manifest.content_scripts.find(script => script.js.includes('contentDeck.js'));
  assert.ok(entry.js.indexOf('floatingControls.js') > entry.js.indexOf('homeScroll.js'));
  assert.ok(entry.js.indexOf('floatingControls.js') < entry.js.indexOf('contentDeck.js'));
});

test('panel CSS survives the shipped dashboard stylesheet cleanup without duplicate styles', async () => {
  const env = setup();
  const deck = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');
  const start = deck.indexOf('function swe(){');
  const end = deck.indexOf('function lwe(){', start);
  assert.ok(start > 0 && end > start);
  Object.assign(env.context, {
    P4: 'Yomikui', owe() {}, Hee: '#yomikui-root { display: flex; }',
    MutationObserver: env.dom.MutationObserver,
    chrome: { runtime: { getURL: value => value } },
  });
  vm.runInContext(deck.slice(start, end), env.context);
  const maintenance = env.context.swe();
  const core = env.document.getElementById('yomikui-styles');
  const original = core.textContent;
  try {
    assert.equal(env.api.installStyles(), true);
    assert.ok(core.textContent.startsWith(original));
    assert.match(core.textContent, /#yomikui-root \.yomikui-floating-panel\{position:fixed/);
    const installed = core.textContent;
    env.api.installStyles();
    assert.equal(core.textContent, installed, 'mounting again must not duplicate the rules');
    const separate = env.document.createElement('style');
    separate.textContent = '.unprotected { position: fixed; }';
    env.document.body.appendChild(separate);
    env.document.head.appendChild(env.document.createElement('meta'));
    await settle();
    assert.equal(separate.isConnected, false, 'the real cleanup must run in this test');
    assert.equal(core.isConnected, true);
    assert.equal(core.textContent, installed);
    assert.equal(env.document.querySelectorAll('style').length, 1);
  } finally {
    maintenance.headObserver.disconnect();
    maintenance.titleObserver?.disconnect();
  }
});
