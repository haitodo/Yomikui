import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock } from './helpers.mjs';

const source = readFileSync(new URL('../columnNavigation.js', import.meta.url), 'utf8');
const deck = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');
const iframe = readFileSync(new URL('../contentIframe.js', import.meta.url), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function setup() {
  const clock = new Clock();
  const saved = new Map();
  const context = vm.createContext({
    ...clock.globals(), URL, URLSearchParams, queueMicrotask,
    console: { log() {}, warn() {}, error() {} }, crypto: { randomUUID },
    chrome: { runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      getURL: path => `chrome-extension://yomikui/${path}`,
    } },
    navigationStorage: {
      get: async key => clone(saved.get(key)),
      set: async (key, value) => { saved.set(key, clone(value)); },
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(readFileSync(new URL('../columnLayout.js', import.meta.url), 'utf8'), context);
  const end = deck.indexOf(';var Im=[];');
  assert.ok(end > 0);
  const urlStart = deck.indexOf('function Ave(');
  const urlEnd = deck.indexOf('var Dve=', urlStart);
  assert.ok(urlStart > 0 && urlEnd > urlStart);
  vm.runInContext(deck.slice(0, end) + `;
    Ln = key => navigationStorage.get(key);
    ra = (key, value) => navigationStorage.set(key, value);
    globalThis.runtime = { store: Ut, schema: rw, createColumn: _h, loadWorkspaces: nB };
    ${deck.slice(urlStart, urlEnd)}
    globalThis.buildColumnUrl = kx;
  })();`, context);
  const { store, schema, createColumn, loadWorkspaces } = context.runtime;
  const columns = ['search', 'home', 'customUrl', 'following'].map(type => ({
    ...createColumn(type, '#1d9bf0'), lastPath: '/home', activeTab: 'おすすめ', activeTabPath: '/home',
  }));
  columns[2].customUrl = 'https://x.com/search?q=original&f=live';
  const workspace = (id, items) => ({ id, name: id, columns: items, createdAt: 0, updatedAt: 0 });
  store.setState({
    activeWorkspaceId: 'active', columns,
    columnActiveTabs: Object.fromEntries(columns.map(column => [column.id, column.activeTab])),
    workspaces: [workspace('active', columns), workspace('inactive', [createColumn('home', '#ff0000')])],
  });
  return { context, clock, saved, store, schema, createColumn, loadWorkspaces, api: context.YomikuiColumnNavigation, buildUrl: context.buildColumnUrl };
}

test('reset returns each column to its configured page and persists without changing other settings', async () => {
  const env = setup();
  const original = clone(env.store.getState().columns);
  const untouched = clone(env.store.getState().workspaces[1]);
  for (const [index, pathname, query] of [
    [0, '/search', null], [1, '/home', null], [2, '/search', 'original'], [3, '/search', 'filter:follows'],
  ]) {
    const column = env.store.getState().columns[index];
    env.store.getState().resetColumnPage(column.id);
    const reset = env.store.getState().columns[index];
    assert.deepEqual(clone(reset), { ...original[index], lastPath: null, activeTab: null, activeTabPath: null });
    assert.equal(env.store.getState().columnActiveTabs[column.id], null);
    const url = new URL(env.buildUrl(reset, 'dark'));
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get('q'), query);
    assert.ok(url.hash.includes(`cid${column.id}`));
  }
  await env.clock.advance(280);
  const loaded = await env.loadWorkspaces();
  assert.equal(loaded.workspaces[0].columns[0].rememberLastPage, true);
  assert.ok(loaded.workspaces[0].columns.every(column => column.lastPath === null && column.activeTab === null && column.activeTabPath === null));
  assert.deepEqual(clone(env.store.getState().workspaces[1]), untouched);
  assert.deepEqual(clone(loaded.workspaces[1]), untouched);
});

test('resetting a search result keeps a configured query and tab, returning safe native URL', () => {
  const { store, buildUrl } = setup();
  const id = store.getState().columns[0].id;
  store.getState().updateColumn(id, {
    path: '/search?q=original&f=live', lastPath: '/author/status/123',
    liveFeed: true, liveFeedIntervalSec: 60, hideRetweets: true,
  });
  store.getState().resetColumnPage(id);
  const column = store.getState().columns[0];
  const url = new URL(buildUrl(column, 'dim'));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'original');
  assert.equal(url.searchParams.get('f'), 'live');
  assert.equal(column.liveFeedIntervalSec, 60);
  assert.equal(column.hideRetweets, true);
});

test('the reset UI callback reloads once using freshly reset state instead of the old lastPath', () => {
  const env = setup();
  const column = env.store.getState().columns[0];
  const urls = [];
  const start = deck.indexOf('let resetPage=');
  const end = deck.indexOf('let ue=', start);
  assert.ok(start > 0 && end > start);
  Object.assign(env.context, {
    Ut: env.store, nt: { useCallback: callback => callback }, e: column,
    it: { current: column }, H: () => urls.push(env.buildUrl(env.context.it.current, 'dark')),
  });
  vm.runInContext(deck.slice(start, end) + ';globalThis.resetPage=resetPage;', env.context);
  env.context.resetPage();
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).pathname, '/search');
  assert.equal(env.store.getState().columns[0].lastPath, null);
});

test('tab scope survives reload and a same-named tab on a different page updates its scope', async () => {
  const { store, schema, clock, loadWorkspaces } = setup();
  const id = store.getState().columns[0].id;
  store.getState().setColumnActiveTab(id, 'おすすめ', '/search');
  assert.equal(store.getState().columns[0].activeTabPath, '/search');
  await clock.advance(280);
  assert.equal((await loadWorkspaces()).workspaces[0].columns[0].activeTabPath, '/search');
  const { activeTabPath, ...legacy } = store.getState().columns[0];
  assert.equal(schema.parse(legacy).activeTabPath, null);
  assert.equal(schema.parse({ ...legacy, activeTabPath: 42 }).activeTabPath, null);
  const before = store.getState();
  store.getState().setColumnActiveTab('missing', '最新', '/search');
  store.getState().resetColumnPage('missing');
  assert.equal(store.getState(), before);
});

function frameSetup() {
  const { document, window } = parseHTML(`<main data-testid="primaryColumn">
    <button role="tab" id="recommended" aria-selected="true">おすすめ</button>
    <button role="tab" id="following" aria-selected="false">フォロー中</button>
  </main>`);
  const clock = new Clock();
  const intervals = new Map();
  const setInterval = (callback, delay) => {
    const id = {};
    const tick = () => {
      callback();
      if (intervals.has(id)) intervals.set(id, clock.setTimeout(tick, delay));
    };
    intervals.set(id, clock.setTimeout(tick, delay));
    return id;
  };
  const clearInterval = id => { clock.clearTimeout(intervals.get(id)); intervals.delete(id); };
  const messages = [];
  window.location = { href: 'https://x.com/home' };
  window.parent = { postMessage: (data, origin) => messages.push({ data: clone(data), origin }) };
  const context = vm.createContext({
    ...clock.globals(), document, window, URL, setInterval, clearInterval, Le: () => 'https://x.com',
  });
  vm.runInContext(source, context);
  const start = iframe.indexOf('var xv=null');
  const end = iframe.indexOf('var gS=', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(iframe.slice(start, end) + ';globalThis.tabs={restore:hS,report:TB,click:vS};', context);
  const clicks = [];
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => {
    clicks.push(tab.id);
    for (const other of document.querySelectorAll('[role="tab"]')) other.setAttribute('aria-selected', String(other === tab));
  });
  return { clock, document, window, context, messages, clicks, intervals, tabs: context.tabs };
}

test('only tabs saved on the current page are restored; legacy unscoped state and search URLs do not click tabs', async () => {
  for (const [url, scope, expected] of [
    ['https://x.com/home', '/home', ['following']],
    ['https://x.com/home', '/search', []],
    ['https://x.com/home', null, []],
    ['https://x.com/search?q=term&f=live', '/search', []],
  ]) {
    const env = frameSetup();
    env.window.location.href = url;
    env.tabs.restore('フォロー中', scope);
    await env.clock.advance(16000);
    assert.deepEqual(env.clicks, expected);
    assert.equal(env.intervals.size, 0);
  }
});

test('restoration stops on navigation and a user tab click cancels a pending restore', async () => {
  const navigated = frameSetup();
  navigated.tabs.restore('フォロー中', '/home');
  navigated.window.location.href = 'https://x.com/author';
  await navigated.clock.advance(500);
  assert.deepEqual(navigated.clicks, []);
  assert.equal(navigated.intervals.size, 0);

  const clicked = frameSetup();
  clicked.tabs.restore('フォロー中', '/home');
  clicked.tabs.click(clicked.document.getElementById('recommended'), { getColumnId: () => 'search-column' });
  await clicked.clock.advance(1000);
  assert.deepEqual(clicked.clicks, []);
  assert.equal(clicked.intervals.size, 0);
  assert.deepEqual(clicked.messages, [{
    data: { type: 'yomikui-tab-change', columnId: 'search-column', tab: 'おすすめ', path: '/home' },
    origin: 'https://x.com',
  }]);
});

test('a delayed tab report cannot save the tab of a newly navigated page', async () => {
  const env = frameSetup();
  env.tabs.click(env.document.getElementById('recommended'), { getColumnId: () => 'column' });
  env.window.location.href = 'https://x.com/search?q=other';
  await env.clock.advance(500);
  assert.deepEqual(env.messages, []);
});

test('headers and sidebar retain the column identity and custom names', () => {
  const { api } = setup();
  assert.equal(api.displayTitle({ title: 'Search' }, '最新', '検索', 'Search'), '検索 · 最新');
  assert.equal(api.displayTitle({ title: 'Home' }, 'おすすめ', 'ホーム', 'Home'), 'ホーム · おすすめ');
  assert.equal(api.displayTitle({ title: '調査用' }, '最新', '検索', 'Search'), '調査用');
  assert.equal(api.displayTitle({ title: 'Search' }, null, '検索', 'Search'), '検索');
  assert.ok(deck.includes('Ui=globalThis.YomikuiColumnNavigation.displayTitle(e,b,tt,ht)'));
  assert.ok(deck.includes('gr=globalThis.YomikuiColumnNavigation.displayTitle(H,d[H.id]??H.activeTab,me,Sn)'));
});

test('reset button is labelled, keyboard accessible, and uses the dashboard action handler', () => {
  const { api } = setup();
  const element = (type, props) => ({ type, props });
  let resets = 0;
  const props = {
    column: { type: 'search' }, onReset: () => { resets++; }, Button: 'button',
    jsx: { jsx: element, jsxs: element }, t: () => 'この列の初期ページに戻る',
  };
  const button = api.ResetButton(props);
  assert.equal(button.type, 'button');
  assert.equal(button.props.type, 'button');
  assert.equal(button.props['aria-label'], 'この列の初期ページに戻る');
  button.props.onClick();
  assert.equal(resets, 1);
  for (const type of ['timeline', 'chat']) assert.equal(api.ResetButton({ ...props, column: { type } }), null);
  assert.ok(deck.includes('YomikuiColumnNavigation.ResetButton,{column:e,onReset:resetPage'));
});

test('shared navigation loads before both entry points and the button label is available in the bundled locale', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const bundle of ['contentDeck.js', 'contentIframe.js']) {
    const scripts = manifest.content_scripts.find(entry => entry.js.includes(bundle)).js;
    assert.ok(scripts.indexOf('columnNavigation.js') >= 0 && scripts.indexOf('columnNavigation.js') < scripts.indexOf(bundle));
  }
  const messages = JSON.parse(readFileSync(new URL('../_locales/ja/messages.json', import.meta.url), 'utf8'));
  assert.ok(deck.includes(JSON.stringify({ column_reset_page: messages.column_reset_page }).slice(1, -1)));
  assert.ok(deck.includes(JSON.stringify({ column_copy_url: messages.column_copy_url }).slice(1, -1)));
  assert.ok(deck.includes(JSON.stringify({ column_copy_url_copied: messages.column_copy_url_copied }).slice(1, -1)));
});

test('cleanUrl cleans yomikui internal query and hash while preserving search and custom anchors', () => {
  const { api } = setup();
  assert.equal(api.cleanUrl('https://x.com/home?yomikui=test#yomikui-cid1-hb0'), 'https://x.com/home');
  assert.equal(
    api.cleanUrl('https://x.com/search?q=test&f=live&yomikui=123#yomikui-cid1'),
    'https://x.com/search?q=test&f=live'
  );
  assert.equal(
    api.cleanUrl('https://x.com/user/status/123#photo1'),
    'https://x.com/user/status/123#photo1'
  );
  assert.equal(
    api.cleanUrl('chrome-extension://yomikui/liveFeedShell.html?fp=%2Fhome&fs=%3Ff%3Dlive#yomikui-cid1'),
    'https://x.com/home?f=live'
  );
  assert.equal(
    api.cleanUrl('chrome-extension://yomikui/liveFeedShell.html?cu=https%3A%2F%2Fx.com%2Fi%2Flists%2F123#yomikui-cid1'),
    'https://x.com/i/lists/123'
  );
  assert.equal(api.cleanUrl('/i/bookmarks'), 'https://x.com/i/bookmarks');
  assert.equal(api.cleanUrl('/i/history/likes'), 'https://x.com/i/history/likes');
});

test('getColumnUrl prioritizes current iframe location and falls back to column settings', () => {
  const { api } = setup();
  const column = {
    id: 'col-1',
    type: 'search',
    path: '/search?q=fallback',
    lastPath: '/search?q=remembered',
    rememberLastPage: true,
  };
  const mockIframe = {
    contentWindow: {
      location: {
        href: 'https://x.com/user/status/98765?yomikui=abc#yomikui-cidcol-1',
      },
    },
  };
  // 1. Live iframe href
  assert.equal(api.getColumnUrl(column, mockIframe), 'https://x.com/user/status/98765');
  assert.equal(api.getColumnUrl(column, { current: mockIframe }), 'https://x.com/user/status/98765');

  // 2. Fallback to remembered lastPath
  assert.equal(api.getColumnUrl(column, null), 'https://x.com/search?q=remembered');

  // 3. Fallback when rememberLastPage is false
  assert.equal(api.getColumnUrl({ ...column, rememberLastPage: false }, null), 'https://x.com/search?q=fallback');

  // 4. CustomUrl column fallback
  const customCol = { id: 'col-2', type: 'customUrl', customUrl: 'https://x.com/i/bookmarks' };
  assert.equal(api.getColumnUrl(customCol, null), 'https://x.com/i/bookmarks');

  // 5. Likes column fallback
  const likesCol = { id: 'col-3', type: 'likes', path: '/i/history/likes' };
  assert.equal(api.getColumnUrl(likesCol, null), 'https://x.com/i/history/likes');
});

test('CopyUrlButton copies URL, displays success feedback, and is wired in contentDeck', async () => {
  const { api, context } = setup();
  const element = (type, props) => ({ type, props });
  const column = { id: 'col-1', type: 'home', path: '/home' };
  const mockIframe = {
    contentWindow: {
      location: {
        href: 'https://x.com/home?yomikui=1#yomikui-cid1',
      },
    },
  };

  let stateVal = false;
  let copiedState = false;
  const useState = init => {
    stateVal = init;
    return [stateVal, next => { stateVal = typeof next === 'function' ? next(stateVal) : next; copiedState = stateVal; }];
  };
  let effectCleanup = null;
  const useEffect = (effect, deps) => {
    effectCleanup?.();
    effectCleanup = effect();
  };

  let copiedText = null;
  let copyCallbackResult = null;
  const t = key => {
    if (key === 'column_copy_url') return 'この列のURLをコピー';
    if (key === 'column_copy_url_copied') return 'URLをコピーしました';
    return key;
  };

  context.navigator = {
    clipboard: {
      writeText: async text => { copiedText = text; },
    },
  };

  const btnInitial = api.CopyUrlButton({
    column,
    iframeRef: { current: mockIframe },
    onCopy: (url, success) => { copyCallbackResult = { url, success }; },
    Button: 'button',
    jsx: { jsx: element, jsxs: element },
    t,
    useState,
    useEffect,
  });

  assert.equal(btnInitial.type, 'button');
  assert.equal(btnInitial.props.type, 'button');
  assert.equal(btnInitial.props['aria-label'], 'この列のURLをコピー');
  assert.equal(btnInitial.props.title, 'この列のURLをコピー');
  assert.ok(btnInitial.props.className.includes('rd-column-action-copy-url'));
  assert.ok(!btnInitial.props.className.includes('text-emerald-500'));

  // Trigger copy click
  await btnInitial.props.onClick();
  assert.equal(copiedText, 'https://x.com/home');
  assert.deepEqual(copyCallbackResult, { url: 'https://x.com/home', success: true });
  assert.equal(copiedState, true);

  // Re-render in copied state
  const btnCopied = api.CopyUrlButton({
    column,
    iframeRef: { current: mockIframe },
    Button: 'button',
    jsx: { jsx: element, jsxs: element },
    t,
    useState: () => [true, () => {}],
    useEffect,
  });
  assert.equal(btnCopied.props['aria-label'], 'URLをコピーしました');
  assert.equal(btnCopied.props.title, 'URLをコピーしました');
  assert.ok(btnCopied.props.className.includes('text-emerald-500'));
  // Rendered child should be a checkmark polyline
  assert.equal(btnCopied.props.children.props.children.type, 'polyline');

  assert.ok(deck.includes('YomikuiColumnNavigation.CopyUrlButton,{column:e,iframeRef:Pt'));
});

test('column duplicate action button uses Columns2 icon distinct from copy URL icon', () => {
  // Ensure the duplicate column action button in contentDeck uses a distinct Columns2 icon
  // instead of the overlapping-rectangles copy icon used by CopyUrlButton
  assert.ok(deck.includes('className:"rd-column-action-duplicate shrink-0"'));
  assert.ok(deck.includes('(0,Ze.jsx)(DuplicateColumnIcon,{size:14})'));

  // DuplicateColumnIcon renders a 2-column layout icon (Columns2: rect 18x18 divided by M12 3v18)
  assert.ok(deck.includes('DuplicateColumnIcon=({size:e=20,className:t})=>'));
  assert.ok(deck.includes('width:"18",height:"18",x:"3",y:"3",rx:"2"'));
  assert.ok(deck.includes('d:"M12 3v18"'));

  // Verify that the duplicate action does NOT share the copy icon (Gw) with CopyUrlButton
  assert.doesNotMatch(
    deck,
    /className:"rd-column-action-duplicate shrink-0"[^}]+children:\(0,Ze\.jsx\)\(Gw,/
  );
});

test('likes column is supported with heart icon, default path, and translations in contentDeck', () => {
  // Ensure "likes" is registered in column definitions with /i/history/likes and heart icon
  assert.ok(deck.includes('likes:{label:"Likes",defaultPath:"/i/history/likes",icon:"heart"}'));

  // Ensure heart icon is defined with Feather/Lucide path and registered in Lc
  assert.ok(deck.includes('HeartColumnIcon=({size:e=20,className:t})=>'));
  assert.ok(deck.includes('d:"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"'));
  assert.ok(deck.includes('heart:HeartColumnIcon'));

  // Ensure "likes" is included in column addition menu after bookmarks
  assert.ok(deck.includes('"bookmarks","likes","customUrl"'));

  // Ensure "likes" is accepted in Zod schema
  assert.ok(deck.includes('gue=Re.enum(["home","following","notifications","explore","search","post","grok","chat","bookmarks","likes","customUrl","timeline"])'));

  // Ensure translation key is in bundled fallback translations
  assert.ok(deck.includes('"column_type_likes":{"message":"いいね"}'));

  // Ensure translation key exists in messages.json
  const messages = JSON.parse(readFileSync(new URL('../_locales/ja/messages.json', import.meta.url), 'utf8'));
  assert.equal(messages.column_type_likes?.message, 'いいね');
});

test('isInputActive detects form inputs, contenteditable, and search/text roles', () => {
  const { api } = setup();
  const { document } = parseHTML('<!doctype html><html><body>' +
    '<div id="plain">Plain text</div>' +
    '<input id="inp" type="text" />' +
    '<textarea id="txt"></textarea>' +
    '<select id="sel"></select>' +
    '<div id="ce" contenteditable="true">Editable</div>' +
    '<div id="tb" role="textbox">Textbox</div>' +
    '<div data-testid="tweetTextarea_0"><span id="nested">Reply</span></div>' +
    '</body></html>');

  assert.equal(api.isInputActive(document), false);

  document.activeElement = document.getElementById('inp');
  assert.equal(api.isInputActive(document), true);

  document.activeElement = document.getElementById('txt');
  assert.equal(api.isInputActive(document), true);

  document.activeElement = document.getElementById('sel');
  assert.equal(api.isInputActive(document), true);

  document.activeElement = document.getElementById('ce');
  assert.equal(api.isInputActive(document), true);

  document.activeElement = document.getElementById('tb');
  assert.equal(api.isInputActive(document), true);

  document.activeElement = document.getElementById('nested');
  assert.equal(api.isInputActive(document), true);

  document.activeElement = document.getElementById('plain');
  assert.equal(api.isInputActive(document), false);
});

test('installDeckHoverFocus focuses column iframe on hover and routes mouse back button', () => {
  const { api } = setup();
  const { document, window, Event, CustomEvent } = parseHTML('<!doctype html><html><body>' +
    '<div class="rd-column" id="col1"><div class="rd-column-header">Header 1</div><iframe id="frame1"></iframe></div>' +
    '<div class="rd-column" id="col2"><div class="rd-column-header">Header 2</div><iframe id="frame2"></iframe></div>' +
    '</body></html>');

  const frame1 = document.getElementById('frame1');
  const frame2 = document.getElementById('frame2');
  let frame1Focused = 0;
  let frame2Focused = 0;
  frame1.focus = () => { frame1Focused++; document.activeElement = frame1; };
  frame2.focus = () => { frame2Focused++; document.activeElement = frame2; };

  const messages = [];
  frame1.contentWindow = { postMessage: (msg) => messages.push({ target: 'frame1', msg }) };
  frame2.contentWindow = { postMessage: (msg) => messages.push({ target: 'frame2', msg }) };

  const cleanup = api.installDeckHoverFocus(document);

  const makeEvent = (type, target, props = {}) => {
    const ev = new CustomEvent(type, { bubbles: true, cancelable: true });
    Object.assign(ev, props);
    // Linkedom dispatchEvent sets target to the dispatched element
    target.dispatchEvent(ev);
    return ev;
  };

  // 1. Pointer over col1 triggers focus on frame1
  const header1 = document.querySelector('#col1 .rd-column-header');
  makeEvent('pointerover', header1, { buttons: 0 });
  assert.equal(frame1Focused, 1);

  // Duplicate hover over same column does not refocus
  makeEvent('pointerover', header1, { buttons: 0 });
  assert.equal(frame1Focused, 1);

  // Hover over col2 triggers focus on frame2
  const header2 = document.querySelector('#col2 .rd-column-header');
  makeEvent('pointerover', header2, { buttons: 0 });
  assert.equal(frame2Focused, 1);

  // Dragging (buttons !== 0) suppresses focus change
  makeEvent('pointerover', header1, { buttons: 1 });
  assert.equal(frame1Focused, 1);

  // 2. Mouse back button (button === 3) prevents default and sends yomikui-go-back to column iframe
  const backEv = makeEvent('pointerdown', header2, { button: 3 });
  assert.equal(backEv.defaultPrevented, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, 'frame2');
  assert.equal(messages[0].msg?.type, 'yomikui-go-back');

  // Cleanup removes listeners
  cleanup();
  makeEvent('pointerover', header1, { buttons: 0 });
  assert.equal(frame1Focused, 1);
});

test('installFrameHoverFocus focuses window on frame pointer activity and back button', () => {
  const { api } = setup();
  const { document, window, CustomEvent } = parseHTML('<!doctype html><html><body><div id="content">Tweet</div></body></html>');

  let windowFocused = 0;
  window.focus = () => { windowFocused++; hasFocus = true; };
  let hasFocus = false;
  document.hasFocus = () => hasFocus;

  const cleanup = api.installFrameHoverFocus(document, window);

  const makeWindowEvent = (type, props = {}) => {
    const ev = new CustomEvent(type, { bubbles: true, cancelable: true });
    Object.assign(ev, props);
    window.dispatchEvent(ev);
    return ev;
  };

  // 1. Pointer move focuses window when not already focused
  makeWindowEvent('pointermove', { buttons: 0 });
  assert.equal(windowFocused, 1);
  assert.equal(hasFocus, true);

  // Already focused: subsequent moves do not call window.focus()
  makeWindowEvent('pointermove', { buttons: 0 });
  assert.equal(windowFocused, 1);

  // If focus was lost, moving again refocuses
  hasFocus = false;
  makeWindowEvent('pointermove', { buttons: 0 });
  assert.equal(windowFocused, 2);

  // Dragging does not focus
  hasFocus = false;
  makeWindowEvent('pointermove', { buttons: 1 });
  assert.equal(windowFocused, 2);

  // Mouse back button (button === 3) focuses frame immediately if not focused
  makeWindowEvent('pointerdown', { button: 3 });
  assert.equal(windowFocused, 3);

  // Cleanup removes listeners
  cleanup();
  hasFocus = false;
  makeWindowEvent('pointermove', { buttons: 0 });
  assert.equal(windowFocused, 3);
});

test('extractAccountInfo extracts account details from SideNav button and falls back cleanly', () => {
  const { api } = setup();

  // Case 1: SideNav_AccountSwitcher_Button exists with avatar and handle
  {
    const { document } = parseHTML(`
      <!DOCTYPE html><html><body>
        <button data-testid="SideNav_AccountSwitcher_Button">
          <div>
            <img src="https://pbs.twimg.com/profile_images/123/avatar_normal.jpg" alt="Alice Wonderland" />
            <div>
              <span>Alice Wonderland</span>
              <span>@alicew</span>
            </div>
          </div>
        </button>
      </body></html>
    `);
    const info = api.extractAccountInfo(document);
    assert.deepEqual({ ...info }, {
      screenName: 'alicew',
      name: 'Alice Wonderland',
      avatarUrl: 'https://pbs.twimg.com/profile_images/123/avatar_bigger.jpg',
    });
  }

  // Case 2: Fallback to AppTabBar_Profile_Link
  {
    const { document } = parseHTML(`
      <!DOCTYPE html><html><body>
        <a data-testid="AppTabBar_Profile_Link" href="/bob_builder">Profile</a>
        <a href="/bob_builder"><img src="https://pbs.twimg.com/profile_images/456/pic_normal.png" /></a>
      </body></html>
    `);
    const info = api.extractAccountInfo(document);
    assert.deepEqual({ ...info }, {
      screenName: 'bob_builder',
      name: 'bob_builder',
      avatarUrl: 'https://pbs.twimg.com/profile_images/456/pic_bigger.png',
    });
  }

  // Case 3: Empty document returns null
  {
    const { document } = parseHTML(`<!DOCTYPE html><html><body><div>No user</div></body></html>`);
    assert.equal(api.extractAccountInfo(document), null);
  }
});
