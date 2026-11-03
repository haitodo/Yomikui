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
  controller.update({ showQuoteList: true });
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action="quotes"]').length, 2);
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action="retweets"]').length, 0);
  controller.update({});
  assert.equal(document.querySelectorAll('[data-yomikui-tweet-action]').length, 0);
  assert.equal(document.getElementById('yomikui-tweet-action-styles'), null);
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
  controller.update({ hideViews: true, hideShare: true });
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

test('column controls toggle all four settings independently and expose accessible labels', () => {
  const { actions } = setup();
  const changes = [];
  const tree = actions.SettingsControls({ column: { showQuoteList: true }, onChange: change => changes.push(clone(change)), Switch: 'Switch', Label: 'Label', jsx, t: key => key });
  for (const [index, row] of tree.props.children.entries()) {
    const [label, toggle] = row.props.children;
    assert.equal(toggle.props['aria-label'], label.props.label);
    assert.equal(toggle.props.checked, index === 0);
    toggle.props.onCheckedChange(index !== 0);
  }
  assert.deepEqual(changes, keys.map((key, index) => ({ [key]: index !== 0 })));
});

for (const entry of [
  { file: 'contentIframe.js', component: 'oq', memo: 'SF', hooks: 'dt', state: 'Ho', defaults: 'w4', receive: 'WL', theme: 'YL', poll: 'P1', normalizeHandle: 'nq', date: 'ap', nickname: 'Ac', media: 'Ka', frame: 'iq', thread: 'tF', pointer: 'sp', count: 'op', revenue: 'eq', placeholders: ['GZ', 'wp', 'YZ', 'XZ', 'Ec', 'S4', 'rF'] },
  { file: 'liveFeedShell.js', component: 'RH', memo: 'b$', hooks: 'et', state: 'Yi', defaults: 'Tm', receive: 'KS', theme: 'jS', poll: 'V6', normalizeHandle: 'OH', date: 'Ed', nickname: 'pl', media: 'Zo', frame: 'CH', thread: 'GS', pointer: 'Dd', count: 'Td', revenue: 'LH', placeholders: ['kH', 'Bd', 'TH', 'EH', 'hl', 'Om', 'YS'] },
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
    const render = () => context.renderTweet({
      tweet: { tweetId: '123', authorHandle: '@author', authorName: 'Author', text: 'Tweet', mediaUrls: [], viewCount: 42 },
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
    assert.equal(enabledTree.some(node => node.props?.title === '42 Views'), false);
    context.receive({});
    const disabledTree = nodes(render());
    assert.equal(disabledTree.some(node => node.props?.title === '42 Views'), true);
    assert.equal(actions.ListLinks(disabledTree.find(node => node.type === actions.ListLinks).props).props.children.length, 0);
    assert.equal(notifications, 2);
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
    assert.equal(column[key], false);
    assert.equal(schema.parse(legacy)[key], false);
    assert.equal(schema.parse({ ...legacy, [key]: 'invalid' })[key], false);
  }
  const workspace = { id: 'workspace', name: 'workspace', columns: [column], createdAt: 0, updatedAt: 0 };
  store.setState({ activeWorkspaceId: workspace.id, columns: [column], workspaces: [workspace] });
  store.getState().updateColumn(column.id, allEnabled);
  await clock.advance(280);
  const loaded = (await loadWorkspaces()).workspaces[0].columns[0];
  for (const key of keys) assert.equal(loaded[key], true);
  store.getState().duplicateColumn(column.id);
  for (const key of keys) assert.equal(store.getState().columns[1][key], true);
});

test('shared actions load before each UI entry point and translations are available in the bundled fallback', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const bundle of ['contentDeck.js', 'contentIframe.js']) {
    const scripts = manifest.content_scripts.find(entry => entry.js.includes(bundle)).js;
    assert.ok(scripts.indexOf('tweetActions.js') >= 0 && scripts.indexOf('tweetActions.js') < scripts.indexOf(bundle));
  }
  const shell = readFileSync(new URL('../liveFeedShell.html', import.meta.url), 'utf8');
  assert.ok(shell.indexOf('tweetActions.js') < shell.indexOf('liveFeedShell.js'));
  const { actions } = setup();
  const messages = JSON.parse(readFileSync(new URL('../_locales/ja/messages.json', import.meta.url), 'utf8'));
  for (const { label, description } of actions.SETTINGS) {
    for (const key of [label, description]) {
      assert.ok(messages[key]?.message);
      assert.ok(deckSource.includes(JSON.stringify({ [key]: messages[key] }).slice(1, -1)));
    }
  }
});
