import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events } from './helpers.mjs';

const source = readFileSync(new URL('../tweetActions.js', import.meta.url), 'utf8');
const deckSource = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const keys = ['showQuoteList', 'showRetweetList', 'hideViews', 'hideShare'];
const allEnabled = Object.fromEntries(keys.map(key => [key, true]));
const allDisabled = Object.fromEntries(keys.map(key => [key, false]));
const defaultSettings = { showQuoteList: true, showRetweetList: true, hideViews: true, hideShare: true };
const element = (type, props, key) => ({ type, props, key });
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };

function setup(html = '') {
  const clock = new Clock();
  const { document, Event } = parseHTML(`<html><head></head><body>${html}</body></html>`);
  document.hidden = false;
  const window = new Events();
  window.location = { hash: '#yomikui-cidcolumn' };
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    emit(records) { if (this.connected) this.callback(records); }
  }
  const context = vm.createContext({ ...clock.globals(), URL, window, document, MutationObserver });
  vm.runInContext(source, context);
  return { clock, document, window, observers, Event, context, actions: context.YomikuiTweetActions };
}

function nativeTweet(id, { analytics = true, share = 'Share post' } = {}) {
  return `<article data-testid="tweet" id="tweet-${id}">
    <a href="/quoted/status/999/photo/1" id="quoted-media-${id}">Quoted media</a>
    <div data-testid="User-Name"><a href="/author/status/${id}" id="date-${id}"><time>Now</time></a></div>
    <a href="/author/status/${id}/analytics" id="body-link-${id}">A link in the tweet text</a>
    <div role="group" id="actions-${id}">
      <div><button data-testid="reply">Reply</button></div>
      <div><button data-testid="retweet">Repost</button></div>
      <div><button data-testid="like">Like</button></div>
      ${analytics ? `<div data-yomikui-revenue-group="1" id="revenue-group-${id}"><div id="views-${id}"><a href="/author/status/${id}/analytics">123</a></div><div id="revenue-${id}">$0.01</div></div>` : ''}
      <div><button data-testid="bookmark">Bookmark</button></div>
      <div id="share-slot-${id}"><button aria-label="${share}">Share</button></div>
    </div>
  </article>`;
}

test('list routes accept native and Live Feed status paths and reject external URLs', () => {
  const { actions } = setup();
  for (const path of ['/author/status/123', 'https://twitter.com/author/status/123/analytics?x=1', '/i/web/status/123']) {
    assert.match(actions.getListPath(path, 'quotes'), /\/status\/123\/quotes$/);
    assert.match(actions.getListPath(path, 'retweets'), /\/status\/123\/retweets$/);
  }
  for (const path of [null, '', '/author/status/invalid', 'https://example.com/author/status/123', 'javascript:alert(1)']) {
    assert.equal(actions.getListPath(path, 'quotes'), null);
  }
  assert.equal(actions.getListPath('/author/status/123', 'likes'), null);
});

test('native links use the main tweet, preserve column navigation, and leave repost actions intact', () => {
  const { actions, document, Event } = setup(nativeTweet('101') + nativeTweet('202', { analytics: false }));
  const controller = new actions.NativeActionsController();
  controller.update(allEnabled);
  for (const id of ['101', '202']) {
    const group = document.getElementById(`actions-${id}`);
    const links = [...group.querySelectorAll('[data-yomikui-tweet-action] > a')];
    assert.deepEqual(links.map(link => link.getAttribute('href')), [
      `https://x.com/author/status/${id}/quotes#yomikui-cidcolumn`,
      `https://x.com/author/status/${id}/retweets#yomikui-cidcolumn`,
    ]);
    assert.equal(links[0].getAttribute('aria-label'), '引用リツイート一覧');
    assert.equal(links[1].getAttribute('aria-label'), 'リツイート一覧');
    let rowClicks = 0;
    group.addEventListener('click', () => { rowClicks++; });
    links[0].dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(rowClicks, 0);
    assert.ok(group.querySelector('button[data-testid="retweet"]'));
  }
  controller.update(allEnabled);
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action]').length, 4);
  controller.update({ showQuoteList: true, showRetweetList: false });
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action="quotes"]').length, 2);
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action="retweets"]').length, 0);
  controller.update({});
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action]').length, 4);
  assert.match(document.getElementById('yomikui-tweet-action-styles').textContent, /analytics/);
  controller.update(allDisabled);
  assert.equal(document.getElementById('yomikui-tweet-action-styles'), null);
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action]').length, 0);
});

test('native text-only tweet counts arrive through the shipped response consumer and update without media', async () => {
  const { actions, context, document, clock, window } = setup(nativeTweet('101'));
  actions.updateNative(allEnabled);
  const bundle = readFileSync(new URL('../contentIframe.js', import.meta.url), 'utf8');
  const start = bundle.indexOf('function xX(e,t){');
  const end = bundle.indexOf('var _H=', start);
  // The existing media extractor returns nothing for a text-only tweet.
  context.bH = () => [];
  vm.runInContext(bundle.slice(start, end) + ';globalThis.consume = xX;', context);
  const payload = (quotes, retweets) => JSON.stringify({ data: { tweetResult: { result: {
    rest_id: '101', legacy: { id_str: '101', quote_count: quotes, retweet_count: retweets },
    quoted_status_result: { result: { legacy: { id_str: '999', quote_count: 99, retweet_count: 100 } } },
  } } } });
  const counter = kind => document.querySelector(`[data-yomikui-tweet-action="${kind}"] [data-yomikui-action-count]`);
  assert.equal(counter('quotes'), null);
  context.consume('TweetDetail', payload(3, 5));
  await clock.advance(80);
  assert.equal(counter('quotes').textContent, '3');
  assert.equal(counter('retweets').textContent, '5');
  assert.equal(document.querySelector('[data-yomikui-tweet-action="quotes"] a').getAttribute('aria-label'), '引用リツイート一覧 3');
  context.consume('TweetDetail', payload(3, 5));
  assert.equal(clock.timers.size, 0, 'unchanged counts must not schedule a DOM update');
  window.emit('yomikui-frame-column-visibility', { detail: { visible: false } });
  context.consume('TweetDetail', payload(0, 1));
  assert.equal(clock.timers.size, 0, 'hidden columns must not schedule updates');
  window.emit('yomikui-frame-column-visibility', { detail: { visible: true } });
  assert.equal(counter('quotes'), null);
  assert.equal(counter('retweets').textContent, '1');
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action]').length, 2, 'zero counts retain the list buttons');
});

test('native repost counts follow X text changes and clear cached counts on recycled tweets', async () => {
  const { actions, document, observers, clock } = setup(nativeTweet('101'));
  actions.captureResponse({ legacy: { id_str: '101', quote_count: 2, retweet_count: 3 } });
  const controller = new actions.NativeActionsController();
  controller.update(allEnabled);
  const button = document.querySelector('[data-testid="retweet"]');
  button.innerHTML = '<span data-testid="app-text-transition-container">4</span>';
  const text = button.firstChild.firstChild;
  const observer = observers.at(-1);
  observer.emit([{ type: 'childList', target: button, addedNodes: [button.firstChild] }]);
  await clock.advance(80);
  const counter = kind => document.querySelector(`[data-yomikui-tweet-action="${kind}"] [data-yomikui-action-count]`);
  assert.equal(counter('quotes').textContent, '2');
  assert.equal(counter('retweets').textContent, '4');
  text.data = '1.2万';
  observer.emit([{ type: 'characterData', target: text }]);
  await clock.advance(80);
  assert.equal(counter('retweets').textContent, '1.2万');
  button.firstChild.textContent = '';
  observer.emit([{ type: 'childList', target: button.firstChild, addedNodes: [] }]);
  document.querySelector('#views-101 a').setAttribute('href', '/other/status/202/analytics');
  observer.emit([{ type: 'attributes', target: document.querySelector('#views-101 a') }]);
  await clock.advance(80);
  assert.equal(counter('quotes'), null);
  assert.equal(counter('retweets'), null);
});

test('count capture handles repost originals and missing/invalid fields while keeping the cache bounded', () => {
  const { actions } = setup();
  actions.captureResponse({ tweet: { legacy: { id_str: '100', quote_count: 0, retweet_count: '1,234' },
    retweeted_status_result: { result: { legacy: { id_str: '101', quote_count: '5', retweet_count: 9 } } },
  } });
  assert.deepEqual(clone(actions.getCounts('100')), { quoteCount: 0, repostCount: 1234 });
  assert.deepEqual(clone(actions.getCounts('101')), { quoteCount: 5, repostCount: 9 });
  actions.captureResponse({ legacy: { id_str: '101', quote_count: -1, retweet_count: null } });
  assert.deepEqual(clone(actions.getCounts('101')), { quoteCount: 5, repostCount: 9 });
  actions.captureResponse(Array.from({ length: 1000 }, (_, index) => ({ id_str: String(index + 1000), quote_count: 1 })));
  assert.equal(actions.getCounts('100'), undefined);
  assert.equal(actions.getCounts('101'), undefined);
  assert.equal(actions.getCounts('1000').quoteCount, 1);
});

test('mutations handle new tweets, recycled IDs and action-row replacement without duplicate links', async () => {
  const { actions, document, observers, clock } = setup(nativeTweet('101'));
  const controller = new actions.NativeActionsController();
  controller.update(allEnabled);
  const observer = observers.at(-1);
  const analytics = document.querySelector('#views-101 a');
  analytics.setAttribute('href', '/someone_else/status/303/analytics');
  observer.emit([{ type: 'attributes', target: analytics }]);
  await clock.advance(80);
  assert.match(document.querySelector('[data-yomikui-tweet-action="quotes"] a').href, /someone_else\/status\/303\/quotes/);
  const group = document.getElementById('actions-101');
  group.querySelectorAll('[data-yomikui-tweet-action]').forEach(slot => slot.remove());
  observer.emit([{ type: 'childList', target: group, addedNodes: [] }]);
  await clock.advance(80);
  assert.equal(group.querySelectorAll('[data-yomikui-tweet-action]').length, 2);
  const container = document.createElement('div');
  container.innerHTML = nativeTweet('404');
  document.body.appendChild(container);
  observer.emit([{ type: 'childList', target: document.body, addedNodes: [container] }]);
  await clock.advance(80);
  assert.match(document.querySelector('#actions-404 [data-yomikui-tweet-action="retweets"] a').href, /404\/retweets/);
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action]').length, 4);
});

test('native observation stops in hidden columns and resumes with current tweet IDs', async () => {
  const { actions, document, window, observers, clock, Event } = setup(nativeTweet('101'));
  const controller = new actions.NativeActionsController();
  controller.update(allEnabled);
  observers.at(-1).emit([{ type: 'attributes', target: document.getElementById('date-101') }]);
  window.emit('yomikui-frame-column-visibility', { detail: { visible: false } });
  assert.equal(observers.at(-1).connected, false);
  assert.equal(clock.timers.size, 0);
  document.querySelector('#views-101 a').setAttribute('href', '/author/status/505/analytics');
  window.emit('yomikui-frame-column-visibility', { detail: { visible: true } });
  assert.match(document.querySelector('[data-yomikui-tweet-action="quotes"] a').href, /505\/quotes/);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(observers.at(-1).connected, false);
  await clock.advance(1000);
  controller.update({ ...allDisabled, hideViews: true, hideShare: true });
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(observers.at(-1).connected, false, 'hiding native buttons requires no observer');
});

test('hide rules collapse only footer views and share slots, preserving other actions and revenue', () => {
  const { actions, document } = setup(nativeTweet('101') + nativeTweet('202', { share: 'ポストを共有' }));
  const combinedSlot = document.createElement('div');
  combinedSlot.id = 'combined-slot';
  combinedSlot.innerHTML = '<button data-testid="bookmark">Bookmark</button><button data-testid="share">Share</button>';
  document.getElementById('actions-202').appendChild(combinedSlot);
  const css = actions.getNativeCss({ hideViews: true, hideShare: true });
  const hidden = new Set();
  for (const match of css.matchAll(/([^{}]+)\{[^{}]*display: none/g)) {
    for (const element of document.querySelectorAll(match[1].trim())) hidden.add(element);
  }
  assert.equal(hidden.has(combinedSlot), false, 'a slot containing bookmark and share must retain bookmark');
  assert.ok(hidden.has(combinedSlot.querySelector('[data-testid="share"]')));
  for (const id of ['101', '202']) {
    assert.ok(hidden.has(document.getElementById(`views-${id}`)));
    assert.ok(hidden.has(document.getElementById(`share-slot-${id}`)));
    for (const name of ['actions', 'revenue-group', 'revenue', 'body-link', 'quoted-media']) {
      assert.equal(hidden.has(document.getElementById(`${name}-${id}`)), false, `${name} must remain visible`);
    }
    for (const button of document.querySelectorAll('[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="bookmark"]')) assert.equal(hidden.has(button), false);
  }
  assert.equal(actions.getNativeCss({}), '');
});

test('Live Feed list links navigate inside the column and preserve modified-click browser behavior', () => {
  const { actions } = setup();
  const opened = [];
  const tree = actions.ListLinks({ settings: allEnabled, statusPath: '/author/status/123', onOpenTweet: path => opened.push(path), color: '#777', jsx });
  const links = tree.props.children;
  assert.equal(links.length, 2);
  let prevented = false;
  let stopped = false;
  links[0].props.onClick({ button: 0, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
  assert.equal(stopped && prevented, true);
  assert.deepEqual(opened, ['/author/status/123/quotes']);
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    links[1].props.onClick({ button: 0, ...modifiers, stopPropagation() {}, preventDefault() { assert.fail('modified clicks should use the link href'); } });
  }
  assert.equal(opened.length, 1);
  assert.equal(links[1].props.href, 'https://x.com/author/status/123/retweets');
  assert.equal(actions.ListLinks({ settings: {}, statusPath: '/author/status/123', jsx }).props.children.length, 0);
});

test('list links show numbers to the right only for known counts of at least one', () => {
  const { actions } = setup();
  const render = counts => actions.ListLinks({ settings: allEnabled, statusPath: '/author/status/123', jsx, metaFontPx: 15, ...counts }).props.children;
  const links = render({ quoteCount: 1, repostCount: 12345 });
  assert.equal(links[0].props.children[0].type, 'svg');
  assert.equal(links[0].props.children[1].props.children, '1');
  assert.equal(links[0].props.children[1].props.style.fontSize, 15);
  assert.equal(links[1].props.children[1].props.children, '12.3K');
  for (const value of [undefined, null, 0, '0', -1, NaN, 'unknown', 0.5]) {
    for (const link of render({ quoteCount: value, repostCount: value })) {
      assert.equal(link.props.children[1], null);
    }
  }
  assert.equal(render({ quoteCount: 0, repostCount: 2 })[1].props.children[1].props.children, '2');
});

test('column controls toggle all four settings independently and expose accessible labels', () => {
  const { actions } = setup();
  const changes = [];
  const tree = actions.SettingsControls({ column: { showRetweetList: false }, onChange: change => changes.push(clone(change)), Switch: 'Switch', Label: 'Label', jsx, t: key => key });
  for (const [index, row] of tree.props.children.entries()) {
    const [label, toggle] = row.props.children;
    assert.equal(toggle.props['aria-label'], label.props.label);
    assert.equal(toggle.props.checked, index !== 1);
    toggle.props.onCheckedChange(index !== 0);
  }
  assert.deepEqual(changes, keys.map((key, index) => ({ [key]: index !== 0 })));
});

for (const entry of [
  { file: 'contentIframe.js', component: 'oq', memo: 'SF', hooks: 'dt', state: 'Ho', defaults: 'w4', receive: 'WL', theme: 'YL', poll: 'P1', normalizeHandle: 'nq', date: 'ap', nickname: 'Ac', media: 'Ka', frame: 'iq', thread: 'tF', pointer: 'sp', count: 'op', revenue: 'eq', rawCount: 'fs', countParser: 'aY', afterParser: 'lY', placeholders: ['GZ', 'wp', 'YZ', 'XZ', 'Ec', 'S4', 'rF'] },
]) {
  test(`${entry.file} applies received preferences to its shipped Live Feed renderer`, () => {
    const { actions, context, window } = setup();
    const bundle = readFileSync(new URL(`../${entry.file}`, import.meta.url), 'utf8');
    const defaults = { ...actions.normalizeSettings(), accountLabels: {}, accountNicknames: {}, pollLabels: {}, deckTheme: 'dark' };
    const hooks = { useRef: () => ({}), useState: value => [value, () => {}], useEffect() {}, useCallback: callback => callback };
    Object.assign(context, {
      G: jsx,
      defaultSettings: defaults,
      [entry.hooks]: hooks,
      [entry.theme]: () => 'dark',
      [entry.poll]: value => value,
      [entry.normalizeHandle]: handle => handle.replace(/^@/, ''),
      [entry.date]: () => 'Now',
      [entry.nickname]: (_settings, _handle, name) => name,
      [entry.media]: () => [],
      [entry.frame]: () => ({}),
      [entry.thread]: () => [],
      [entry.pointer]: () => ({ openTweetPointerHandlers: {}, onOpenTweetClick() {} }),
      [entry.count]: String,
      [entry.revenue]: String,
      CustomEvent: class { constructor(type) { this.type = type; } },
      ...Object.fromEntries(entry.placeholders.map(name => [name, name])),
    });
    const receiverStart = bundle.indexOf(`function ${entry.receive}(e){`);
    const receiverEnd = bundle.indexOf('}function ', receiverStart) + 1;
    assert.ok(receiverStart > 0 && receiverEnd > receiverStart);
    vm.runInContext(`var ${entry.state} = null, ${entry.defaults} = defaultSettings; ${bundle.slice(receiverStart, receiverEnd)};
      globalThis.receive = ${entry.receive}; globalThis.readSettings = () => ${entry.state};`, context);
    let notifications = 0;
    window.addEventListener('yomikui-live-feed-settings-changed', () => { notifications++; });
    context.receive(allEnabled);
    for (const key of keys) assert.equal(context.readSettings()[key], true);
    const start = bundle.indexOf(`var ${entry.component}=`) + `var ${entry.component}=`.length;
    const end = bundle.indexOf(`,${entry.memo}=${entry.hooks}.default.memo(${entry.component})`, start);
    assert.ok(start > 0 && end > start);
    vm.runInContext(`globalThis.renderTweet = (${bundle.slice(start, end)});`, context);
    const parserStart = bundle.indexOf(`function ${entry.rawCount}(e){if(e==null)return 0;`);
    const parserEnd = bundle.indexOf(`function ${entry.afterParser}(`, parserStart);
    assert.ok(parserStart > 0 && parserEnd > parserStart);
    vm.runInContext(bundle.slice(parserStart, parserEnd) + `;globalThis.parseCounts = ${entry.countParser};`, context);
    const render = (counts = { quote_count: 3, retweet_count: 4 }) => context.renderTweet({
      tweet: { tweetId: '123', authorHandle: '@author', authorName: 'Author', text: 'Tweet', mediaUrls: [], viewCount: 42, ...context.parseCounts(counts) },
      theme: { fonts: { textPx: 15, metaPx: 13, lineHeightPx: 20 } },
      settings: context.readSettings(), onOpenTweet() {},
    });
    const nodes = tree => {
      if (!tree || typeof tree !== 'object') return [];
      const children = tree.props?.children;
      return [tree, ...(Array.isArray(children) ? children : [children]).flatMap(nodes)];
    };
    const enabledTree = nodes(render());
    const links = enabledTree.find(node => node.type === actions.ListLinks);
    assert.equal(actions.ListLinks(links.props).props.children.filter(Boolean).length, 2);
    assert.deepEqual(Array.from(actions.ListLinks(links.props).props.children, link => link.props.children[1].props.children), ['3', '4']);
    const zeroTree = nodes(render({ quote_count: 0, retweet_count: 0 }));
    assert.ok(actions.ListLinks(zeroTree.find(node => node.type === actions.ListLinks).props).props.children.every(link => link.props.children[1] === null));
    assert.equal(enabledTree.some(node => node.props?.title === '42 Views'), false);
    context.receive({});
    assert.equal(nodes(render()).some(node => node.props?.title === '42 Views'), false, 'views are hidden by default');
    assert.equal(actions.ListLinks(nodes(render()).find(node => node.type === actions.ListLinks).props).props.children.filter(Boolean).length, 2, 'list links are shown by default');
    context.receive(allDisabled);
    const disabledTree = nodes(render());
    assert.equal(disabledTree.some(node => node.props?.title === '42 Views'), true);
    assert.equal(actions.ListLinks(disabledTree.find(node => node.type === actions.ListLinks).props).props.children.length, 0);
    assert.equal(notifications, 3);
  });
}

test('legacy column defaults and persisted workspace settings survive schema validation and reload', async () => {
  const { context, clock } = setup();
  const saved = new Map();
  Object.assign(context, {
    crypto: { randomUUID },
    console: { log() {}, warn() {}, error() {} },
    chrome: { runtime: { getManifest: () => ({ version: '0.1.0' }) } },
    queueMicrotask,
    settingsStorage: {
      get: async key => saved.has(key) ? clone(saved.get(key)) : undefined,
      set: async (key, value) => saved.set(key, clone(value)),
    },
  });
  vm.runInContext(readFileSync(new URL('../columnLayout.js', import.meta.url), 'utf8'), context);
  const end = deckSource.indexOf(';var Im=[];');
  assert.ok(end > 0);
  vm.runInContext(deckSource.slice(0, end) + `;
    Ln = key => globalThis.settingsStorage.get(key);
    ra = (key, value) => globalThis.settingsStorage.set(key, value);
    globalThis.runtime = { store: Ut, schema: rw, createColumn: _h, loadWorkspaces: nB };
  })();`, context);
  const { store, schema, createColumn, loadWorkspaces } = context.runtime;
  const column = createColumn('home', '#1d9bf0');
  const legacy = { ...column };
  for (const key of keys) delete legacy[key];
  for (const key of keys) {
    assert.equal(column[key], defaultSettings[key]);
    assert.equal(schema.parse(legacy)[key], defaultSettings[key]);
    assert.equal(schema.parse({ ...legacy, [key]: 'invalid' })[key], defaultSettings[key]);
    assert.equal(schema.parse({ ...legacy, [key]: false })[key], false, 'explicit saved settings must be preserved');
  }
  const workspace = { id: 'workspace', name: 'workspace', columns: [column], createdAt: 0, updatedAt: 0 };
  store.setState({ activeWorkspaceId: workspace.id, columns: [column], workspaces: [workspace] });
  store.getState().updateColumn(column.id, allDisabled);
  await clock.advance(280);
  const loaded = (await loadWorkspaces()).workspaces[0].columns[0];
  for (const key of keys) assert.equal(loaded[key], false);
  store.getState().updateColumn(column.id, allEnabled);
  await clock.advance(280);
  const reloaded = (await loadWorkspaces()).workspaces[0].columns[0];
  for (const key of keys) assert.equal(reloaded[key], true);
  store.getState().duplicateColumn(column.id);
  for (const key of keys) assert.equal(store.getState().columns[1][key], true);
});

test('shared actions load before each UI entry point and translations are available in the bundled fallback', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const bundle of ['contentDeck.js', 'contentIframe.js']) {
    const scripts = manifest.content_scripts.find(entry => entry.js.includes(bundle)).js;
    assert.ok(scripts.indexOf('tweetActions.js') >= 0 && scripts.indexOf('tweetActions.js') < scripts.indexOf(bundle));
  }
  const { actions } = setup();
  const messages = JSON.parse(readFileSync(new URL('../_locales/ja/messages.json', import.meta.url), 'utf8'));
  for (const { label, description } of actions.SETTINGS) {
    for (const key of [label, description]) {
      assert.ok(messages[key]?.message);
      assert.ok(deckSource.includes(JSON.stringify({ [key]: messages[key] }).slice(1, -1)));
    }
  }
});
