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

test('resetting a search result keeps a configured query and tab, including Live Feed settings', () => {
  const { store, buildUrl } = setup();
  const id = store.getState().columns[0].id;
  store.getState().updateColumn(id, {
    path: '/search?q=original&f=live', lastPath: '/author/status/123',
    liveFeed: true, liveFeedIntervalSec: 60, hideRetweets: true,
  });
  store.getState().resetColumnPage(id);
  const column = store.getState().columns[0];
  const url = new URL(buildUrl(column, 'dim'));
  assert.equal(url.protocol, 'chrome-extension:');
  assert.equal(url.pathname, '/liveFeedShell.html');
  assert.equal(url.searchParams.get('fp'), '/search');
  assert.equal(url.searchParams.get('fs'), '?q=original&f=live');
  assert.equal(column.liveFeedIntervalSec, 60);
  assert.equal(column.hideRetweets, true);
  assert.ok(url.hash.includes('lf1'));
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
});
