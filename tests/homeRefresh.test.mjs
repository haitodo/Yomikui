import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events, settle } from './helpers.mjs';

const source = readFileSync(new URL('../homeRefresh.js', import.meta.url), 'utf8');
const scrollSource = readFileSync(new URL('../homeScroll.js', import.meta.url), 'utf8');
const floatingSource = readFileSync(new URL('../floatingControls.js', import.meta.url), 'utf8');
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

function setup(html = home(), { storage = new Map(), path = '/home' } = {}) {
  const clock = new Clock();
  const dom = parseHTML(`<html><head></head><body>${html}</body></html>`);
  const { document } = dom;
  document.hidden = false;
  const window = new Events();
  window.self = window;
  window.top = {};
  const reloads = [];
  window.location = { pathname: path, origin: 'https://x.com', search: '', hash: '', reload: () => reloads.push({ ...window.location }) };
  window.history = { state: null, replaceState(state, _, value) {
    const url = new URL(value, window.location.origin);
    Object.assign(window.location, { pathname: url.pathname, search: url.search, hash: url.hash });
    this.state = state;
  } };
  window.sessionStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  window.scrollTo = () => { throw new Error('A column scroller was supplied'); };
  const messages = [];
  window.parent = { postMessage: (data, origin) => messages.push({ data: clone(data), origin }) };
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.inner = new dom.window.MutationObserver(callback);
      observers.push(this);
    }
    observe(...args) { this.connected = true; this.inner.observe(...args); }
    disconnect() { this.connected = false; this.inner.disconnect(); }
    emit(records) { this.callback(records); }
  }
  const context = vm.createContext({
    ...clock.globals(), window, document, MutationObserver, AbortController, DOMException,
    crypto: { randomUUID }, URL,
    fetch() { throw new Error('Native home refresh must not call an API'); },
  });
  vm.runInContext(scrollSource, context);
  vm.runInContext(floatingSource, context);
  vm.runInContext(source, context);
  const settings = { columnType: 'home', isLiveFeedColumn: false };
  const scroller = { scrollTop: 800 };
  const options = {
    getSettings: () => settings, getScroller: () => scroller,
    getOrigin: () => 'https://x.com', getColumnId: () => 'column1',
  };
  const api = context.YomikuiHomeRefresh;
  return { api, context, window, document, settings, scroller, clock, messages, observers, options, storage, reloads };
}

async function beginNative(env, refresher = new env.api.NativeRefresher(env.options), signal) {
  const pending = refresher.refresh(signal);
  await settle();
  return { pending, refresher };
}

test('refresh uses the manual instant top operation and waits for paint and settling before clicking once', async () => {
  const env = setup(), moves = [];
  env.scroller.scrollTo = options => { moves.push(clone(options)); env.scroller.scrollTop = options.top; };
  env.window.requestAnimationFrame = env.clock.requestAnimationFrame;
  env.window.cancelAnimationFrame = env.clock.cancelAnimationFrame;
  let clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => { clicks++; env.document.getElementById('tweets').innerHTML = tweet('202'); });
  const { pending } = await beginNative(env);
  assert.deepEqual(moves, [{ top: 0, behavior: 'instant' }]);
  await env.clock.advance(200);
  assert.equal(clicks, 0, 'elapsed time alone does not confirm a painted top');
  env.clock.frame(16); await settle();
  assert.equal(clicks, 0);
  env.clock.frame(16); await settle();
  assert.equal((await pending).status, 'updated');
  assert.equal(clicks, 1);
  await env.clock.advance(1400);
  assert.equal(env.clock.frames.size, 0);
  assert.equal(env.clock.timers.size, 0);
});

test('an ignored or rebounding top scroll times out without clicking, retrying or leaking timers', async () => {
  for (const rebounds of [false, true]) {
    const env = setup();
    let moves = 0, clicks = 0;
    env.scroller.scrollTo = () => { moves++; if (rebounds) env.scroller.scrollTop = 0; };
    env.document.addEventListener('click', () => clicks++);
    const { pending } = await beginNative(env);
    if (rebounds) env.clock.setTimeout(() => { env.scroller.scrollTop = 300; }, 100);
    await env.clock.advance(1200);
    assert.deepEqual(clone(await pending), { status: 'skipped', reason: 'scroll-top' });
    assert.equal(clicks, 0);
    assert.equal(moves, 1);
    assert.equal(env.clock.timers.size, 0);
    assert.equal(env.clock.frames.size, 0);
  }
});

test('a late top arrival needs two stable painted frames and a changed route cancels preparation', async () => {
  const env = setup();
  env.scroller.scrollTo = () => {};
  let clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => { clicks++; env.document.getElementById('tweets').innerHTML = tweet('202'); });
  const { pending } = await beginNative(env);
  env.clock.setTimeout(() => { env.scroller.scrollTop = 0; }, 180);
  await env.clock.advance(200);
  assert.equal(clicks, 0);
  await env.clock.advance(8);
  assert.equal((await pending).status, 'updated');
  assert.equal(clicks, 1);
  const changed = setup();
  const operation = await beginNative(changed);
  changed.window.location.search = '?different=1';
  await changed.clock.advance(200);
  assert.equal((await operation.pending).reason, 'target-changed');
  assert.equal(changed.clock.timers.size, 0);
});

test('cancelling top preparation clears both paint callbacks and all deadlines without clicking', async () => {
  const env = setup(), abort = new AbortController();
  env.window.requestAnimationFrame = env.clock.requestAnimationFrame;
  env.window.cancelAnimationFrame = env.clock.cancelAnimationFrame;
  let clicks = 0;
  env.document.addEventListener('click', () => clicks++);
  const { pending } = await beginNative(env, undefined, abort.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  abort.abort(); await rejected;
  assert.equal(clicks, 0);
  assert.equal(env.clock.frames.size, 0);
  assert.equal(env.clock.timers.size, 0);
});

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
  await env.clock.advance(1400);
  assert.equal(env.observers.filter(observer => observer.connected).length, 0);
  assert.equal(env.clock.timers.size, 0);
});

for (const columnType of ['search', 'customUrl', 'following', 'explore', 'notifications', 'bookmarks']) {
  test(`a ${columnType} column navigated to recommendations refreshes according to its current page`, async () => {
    const env = setup();
    env.settings.columnType = columnType;
    let clicks = 0;
    env.document.getElementById('recommended').addEventListener('click', () => {
      clicks++;
      env.document.getElementById('tweets').innerHTML = tweet('202');
    });
    assert.equal(env.context.YomikuiHomeScroll.readingKind(() => env.settings), 'recommended');
    const { pending } = await beginNative(env);
    await env.clock.advance(200);
    assert.equal((await pending).status, 'updated');
    assert.equal(clicks, 1);
  });
}

test('a remembered tab still being restored prevents a refresh of a temporary default tab', async () => {
  const env = setup();
  const refresher = new env.api.NativeRefresher({ ...env.options, isTabRestoring: () => true });
  const result = await refresher.refresh();
  assert.equal(result.reason, 'unavailable');
  assert.equal(env.scroller.scrollTop, 800);
  assert.equal(env.clock.timers.size, 0);
});

test('a column leaving the visible area during preparation is not clicked', async () => {
  const env = setup();
  let visible = true, clicks = 0;
  env.document.getElementById('recommended').addEventListener('click', () => clicks++);
  const refresher = new env.api.NativeRefresher({ ...env.options, isVisible: () => visible });
  const { pending } = await beginNative(env, refresher);
  visible = false;
  await env.clock.advance(200);
  assert.equal((await pending).reason, 'hidden');
  assert.equal(clicks, 0);
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
  await env.clock.advance(1400);
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
  assert.equal((await pending).reason, 'target-changed');
  assert.equal(clicks, 0);
});

for (const banner of [null, '35件のポストを表示']) {
  test(`Following refreshes its own selected tab or new-posts banner once: ${banner}`, async () => {
    const env = setup(home({ selected: 'following', banner }));
    env.settings.homeRefreshPosition = 'preserve';
    const clicks = [];
    env.document.getElementById('recommended').addEventListener('click', () => clicks.push('recommended'));
    for (const id of ['following', 'new-posts']) env.document.getElementById(id)?.addEventListener('click', () => {
      clicks.push(id);
      env.document.getElementById('tweets').innerHTML = tweet('202');
    });
    const { pending } = await beginNative(env);
    await env.clock.advance(200);
    assert.deepEqual(clone(await pending), { status: 'updated', method: banner ? 'new-posts' : 'tab' });
    assert.deepEqual(clicks, [banner ? 'new-posts' : 'following']);
    assert.equal(env.scroller.scrollTop, 0, 'recommendation-only position preservation is not applied to Following');
    assert.equal(env.clock.timers.size, 0);
  });
}

const explore = (tab = 'news', { loading = false } = {}) => `<main data-testid="primaryColumn">
  <div role="tablist">${['for_you', 'trending', 'news', 'sports', 'entertainment'].map(id =>
    `<a role="tab" href="/explore/tabs/${id}" aria-selected="${id === tab}">${id}</a>`).join('')}</div>
  ${loading ? '<div role="progressbar"></div>' : '<div data-testid="cellInnerDiv"><a href="/i/trending/123">A trend or news story</a></div>'}
</main>`;
const reloadKey = 'yomikui_page_refresh_v1:column1';
function homeFrameSetup(kind = 'recommended', options = {}) {
  const env = setup(home({ selected: kind, ...options }), options);
  env.tweetCount = options.count ?? 200;
  env.options.getTweetCount = () => env.tweetCount;
  env.send = (data, event = {}) => env.window.emit('message', {
    source: env.window.parent, origin: 'https://x.com', data: {
      type: P + 'request', columnId: 'column1', requestId: 'reload1', target: kind, ...data,
    }, ...event,
  });
  return env;
}

for (const kind of ['recommended', 'following']) {
  test(`${kind} uses the reported cumulative count to switch from native update to one full reload at 200`, async () => {
    for (const count of [199, 200, 260]) {
      const env = homeFrameSetup(kind, { count, banner: '20件のポスト表示' });
      let clicks = 0;
      env.document.getElementById('new-posts').addEventListener('click', () => {
        clicks++;
        env.document.getElementById('tweets').innerHTML = tweet('202');
      });
      const installed = env.api.installFrame(env.options);
      env.send({}, { source: {} });
      env.send({}, { origin: 'https://untrusted.example' });
      assert.equal(env.clock.timers.size, 0);
      env.send(); env.send();
      await settle();
      await env.clock.advance(199);
      assert.equal(env.reloads.length, 0);
      assert.equal(clicks, 0);
      await env.clock.advance(1);
      if (count < 200) {
        assert.equal(env.messages.at(-1).data.status, 'updated');
        assert.equal(clicks, 1);
        assert.equal(env.reloads.length, 0);
        assert.equal(env.storage.size, 0);
      } else {
        assert.equal(env.messages.at(-1).data.type, P + 'reloading');
        assert.equal(env.reloads.length, 1);
        assert.equal(env.reloads[0].pathname, '/home');
        assert.equal(JSON.parse(env.storage.get(reloadKey)).kind, kind);
        assert.equal(clicks, 0, 'a full reload must not also load new posts');
      }
      installed.dispose();
      assert.equal(env.clock.timers.size, 0);
    }
  });

  test(`${kind} full reload waits for the original tab and content without replaying the reload`, async () => {
    const env = homeFrameSetup(kind);
    env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind, path: '/home', origin: 'https://x.com', started: 0 }));
    env.document.body.innerHTML = home({ selected: kind === 'following' ? 'recommended' : 'following' });
    const installed = env.api.installFrame(env.options);
    env.send({ type: P + 'describe' });
    env.send();
    await settle();
    assert.equal(env.messages.at(-1).data.kind, null, 'a temporary default tab must not change the batch target');
    assert.ok(!env.messages.some(message => message.data.type === P + 'result'));
    env.document.getElementById('tabs').innerHTML = tabs(kind);
    env.document.getElementById('tweets').innerHTML = '';
    await settle(); await env.clock.advance(80);
    assert.ok(!env.messages.some(message => message.data.type === P + 'result'), 'the tab alone cannot confirm the reload');
    env.document.getElementById('tweets').innerHTML = tweet('303');
    await settle(); await env.clock.advance(80);
    assert.equal(env.messages.at(-1).data.status, 'reloaded');
    assert.equal(env.messages.at(-2).data.kind, kind, 'publish the restored context before the result');
    assert.equal(env.scroller.scrollTop, 0);
    assert.equal(env.storage.has(reloadKey), false);
    env.send();
    assert.equal(env.messages.at(-1).data.status, 'reloaded');
    assert.equal(env.reloads.length, 0);
    installed.dispose();
    assert.equal(env.clock.timers.size, 0);
    assert.ok(env.observers.every(observer => !observer.connected));
  });
}

test('heavy Home columns still refuse drafts, dialogs, hidden or changed targets, blocked scrolling, storage failure and cancellation', async () => {
  for (const [reason, change] of [
    ['draft', env => env.document.body.insertAdjacentHTML('beforeend', '<textarea data-testid="tweetTextarea_0">A draft</textarea>')],
    ['dialog', env => env.document.body.insertAdjacentHTML('beforeend', '<div role="dialog"></div>')],
    ['hidden', env => env.send({ type: 'yomikui-column-visibility', visible: false })],
    ['target-changed', env => { env.document.getElementById('tabs').innerHTML = tabs('following'); }],
    ['scroll-top', env => { env.scroller.scrollTo = () => {}; }],
    ['reload-unavailable', env => { env.window.sessionStorage.setItem = () => { throw new Error('Storage disabled'); }; }],
    ['cancelled', () => {}],
  ]) {
    const env = homeFrameSetup();
    const installed = env.api.installFrame(env.options);
    change(env);
    env.send();
    if (reason === 'cancelled') env.send({ type: P + 'cancel' });
    await env.clock.advance(1200);
    assert.equal(env.messages.at(-1).data.reason, reason);
    assert.equal(env.reloads.length, 0);
    assert.equal(env.storage.size, 0);
    installed.dispose();
    assert.equal(env.clock.timers.size, 0);
  }
});

function exploreSetup(tab = 'news', options = {}) {
  const env = setup(explore(tab, options), { ...options, path: `/explore/tabs/${tab}` });
  env.settings.columnType = 'explore';
  env.send = (data, event = {}) => env.window.emit('message', {
    source: env.window.parent, origin: 'https://x.com', data: {
      type: P + 'request', columnId: 'column1', requestId: 'reload1', target: 'explore', ...data,
    }, ...event,
  });
  return env;
}

const searchPage = (query, { loading = false, content = tweet('202') } = {}) => `<main data-testid="primaryColumn">
  <div role="tablist"><a role="tab" aria-selected="true" href="/search${query.replaceAll('&', '&amp;')}">Selected search tab</a></div>
  ${loading ? '<div role="progressbar"></div>' : content}
</main>`;
function searchSetup(query = '?q=cat%20dog&src=typed_query&f=live&pf=on&lf=on', options = {}) {
  const env = setup(searchPage(query, options), { ...options, path: '/search' });
  env.window.location.search = query;
  env.settings.columnType = 'search';
  env.send = (data, event = {}) => env.window.emit('message', {
    source: env.window.parent, origin: 'https://x.com', data: {
      type: P + 'request', columnId: 'column1', requestId: 'reload1', target: 'search', ...data,
    }, ...event,
  });
  return env;
}

for (const [kind, create] of [['explore', exploreSetup], ['search', searchSetup]]) {
  test(`${kind} never reloads when top preparation stalls or the route changes`, async () => {
    for (const changed of [false, true]) {
      const env = create();
      env.scroller.scrollTo = () => {};
      const installed = env.api.installFrame(env.options);
      env.send();
      if (changed) env.window.location.search += '&changed=1';
      await env.clock.advance(1200);
      assert.equal(env.reloads.length, 0);
      assert.equal(env.messages.at(-1).data.reason, changed ? 'target-changed' : 'scroll-top');
      assert.equal(env.storage.size, 0);
      installed.dispose();
      assert.equal(env.clock.timers.size, 0);
    }
  });
}

for (const tab of ['for_you', 'trending', 'news', 'sports', 'entertainment']) {
  test(`Explore reload preserves the current ${tab} URL and completes after the replacement document renders`, async () => {
    const env = exploreSetup(tab);
    Object.assign(env.window.location, { search: '?test=1', hash: '#yomikui-cidcolumn1' });
    env.settings.columnType = 'search'; // A column navigated away from its configured page.
    let clicks = 0;
    env.document.addEventListener('click', () => clicks++);
    const installed = env.api.installFrame(env.options);
    env.send({}, { source: {} });
    env.send({}, { origin: 'https://untrusted.example' });
    assert.equal(env.reloads.length, 0);
    env.send();
    env.send();
    await env.clock.advance(199);
    assert.equal(env.reloads.length, 0, 'the reload waits for top preparation');
    await env.clock.advance(1);
    assert.equal(env.reloads.length, 1);
    assert.equal(env.reloads[0].pathname, `/explore/tabs/${tab}`);
    assert.equal(env.reloads[0].search, '?test=1');
    assert.equal(env.reloads[0].hash, '#yomikui-cidcolumn1');
    assert.equal(env.messages.at(-1).data.type, P + 'reloading');
    assert.equal(clicks, 0, 'Explore refresh does not cycle through tabs');
    env.document.hidden = true;
    env.document.dispatchEvent(new env.document.defaultView.Event('visibilitychange'));
    env.window.emit('pagehide');
    assert.ok(env.storage.has(reloadKey), 'the deliberate unload must retain its one-shot receipt');

    const replacement = exploreSetup(tab, { storage: env.storage, loading: true });
    replacement.window.location.search = '?test=1';
    await replacement.clock.advance(env.clock.now);
    const resumed = replacement.api.installFrame(replacement.options);
    replacement.send();
    await settle();
    assert.equal(replacement.reloads.length, 0, 'a repeated request must not reload the replacement document');
    assert.equal(replacement.messages.length, 0, 'rendering must be confirmed before completing');
    replacement.document.body.innerHTML = explore(tab);
    await settle();
    await replacement.clock.advance(80);
    assert.equal(replacement.messages.at(-1).data.status, 'reloaded');
    assert.equal(replacement.messages.at(-1).data.method, 'reload');
    assert.equal(replacement.scroller.scrollTop, 0);
    assert.equal(replacement.storage.has(reloadKey), false);
    replacement.send();
    assert.equal(replacement.messages.at(-1).data.status, 'reloaded');
    assert.equal(replacement.reloads.length, 0);
    resumed.dispose();
    installed.dispose();
    assert.equal(replacement.clock.timers.size, 0);
    assert.ok(replacement.observers.every(observer => !observer.connected));
  });
}

for (const [filter, content, columnType] of [
  ['', tweet('202'), 'home'],
  ['live', tweet('303'), 'following'],
  ['user', '<div data-testid="UserCell">A matching account</div>', 'search'],
  ['media', '<div data-testid="cellInnerDiv"><a href="/author/status/202/photo/1"><img alt="A matching photo"></a></div>', 'customUrl'],
  ['list', '<div data-testid="cellInnerDiv"><a href="/i/lists/123">A matching list</a></div>', 'explore'],
]) {
  test(`search ${filter || 'top'} reload preserves its query, filters and current tab across document replacement`, async () => {
    const q = filter === 'live' ? 'filter:follows' : '#猫 & filter:links';
    const query = `?q=${encodeURIComponent(q)}&src=typed_query${filter ? `&f=${filter}` : ''}&pf=on&lf=on`;
    const env = searchSetup(query, { content });
    env.settings.columnType = columnType;
    env.window.location.hash = '#yomikui-cidcolumn1';
    let clicks = 0;
    env.document.addEventListener('click', () => clicks++);
    const installed = env.api.installFrame(env.options);
    env.send({}, { source: {} });
    env.send({}, { origin: 'https://untrusted.example' });
    assert.equal(env.reloads.length, 0);
    env.send();
    env.send();
    await env.clock.advance(200);
    assert.equal(env.reloads.length, 1);
    assert.equal(env.reloads[0].pathname, '/search');
    assert.equal(env.reloads[0].search, query);
    assert.equal(env.reloads[0].hash, '#yomikui-cidcolumn1');
    assert.equal(clicks, 0);
    assert.equal(JSON.parse(env.storage.get(reloadKey)).kind, 'search');
    assert.equal(env.messages.at(-1).data.type, P + 'reloading');
    env.window.emit('pagehide');
    assert.ok(env.storage.has(reloadKey));

    const replacement = searchSetup(query, { storage: env.storage, loading: true });
    await replacement.clock.advance(env.clock.now);
    const resumed = replacement.api.installFrame({ ...replacement.options, isTabRestoring: () => true });
    replacement.send();
    await settle();
    assert.equal(replacement.reloads.length, 0, 'duplicate requests do not reload the replacement document');
    assert.deepEqual(replacement.messages, [], 'the search results must render before completing');
    replacement.document.body.innerHTML = searchPage(query, { content });
    await settle();
    await replacement.clock.advance(80);
    assert.equal(replacement.messages.at(-1).data.status, 'reloaded');
    assert.equal(replacement.messages.at(-1).data.method, 'reload');
    assert.equal(replacement.scroller.scrollTop, 0);
    assert.equal(replacement.window.location.search, query);
    assert.equal(replacement.storage.has(reloadKey), false);
    replacement.send();
    assert.equal(replacement.messages.at(-1).data.status, 'reloaded');
    assert.equal(replacement.reloads.length, 0);
    resumed.dispose();
    installed.dispose();
    assert.equal(replacement.clock.timers.size, 0);
    assert.ok(replacement.observers.every(observer => !observer.connected));
  });
}

test('an empty search result is a completed reload, including the default Top tab and equivalent query encodings', async () => {
  const query = '?q=cat%20dog&f=top&pf=on';
  const env = searchSetup(query, { content: '<div data-testid="emptyState">No results found</div>' });
  env.document.querySelector('[role="tab"]').setAttribute('href', '/search?q=cat+dog');
  env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind: 'search', path: '/search' + query, origin: 'https://x.com', started: 0 }));
  const installed = env.api.installFrame(env.options);
  await settle();
  assert.equal(env.messages.at(-1).data.status, 'reloaded');
  assert.equal(env.reloads.length, 0);
  assert.equal(env.clock.timers.size, 0);
  installed.dispose();
});

for (const href of ['/search?q=different&f=live', '/search?q=cat+dog&f=user']) {
  test(`search reload waits for the matching query and tab instead of confirming stale content: ${href}`, async () => {
    const env = searchSetup();
    const path = env.window.location.pathname + env.window.location.search;
    env.document.querySelector('[role="tab"]').setAttribute('href', href);
    env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind: 'search', path, origin: 'https://x.com', started: 0 }));
    const installed = env.api.installFrame(env.options);
    await settle();
    assert.deepEqual(env.messages, []);
    env.document.querySelector('[role="tab"]').setAttribute('href', '/search?q=cat+dog&f=live');
    await settle();
    await env.clock.advance(80);
    assert.equal(env.messages.at(-1).data.status, 'reloaded');
    assert.equal(env.window.location.pathname + env.window.location.search, path);
    assert.equal(env.reloads.length, 0);
    installed.dispose();
  });
}

test('changing the search query while awaiting the replacement document does not confirm a different result', async () => {
  const env = searchSetup(undefined, { loading: true });
  const path = env.window.location.pathname + env.window.location.search;
  env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind: 'search', path, origin: 'https://x.com', started: 0 }));
  const installed = env.api.installFrame(env.options);
  env.window.location.search = '?q=different&f=live';
  env.document.body.innerHTML = searchPage(env.window.location.search);
  await settle();
  await env.clock.advance(80);
  assert.equal(env.messages.at(-1).data.status, 'requested');
  assert.equal(env.messages.at(-1).data.reason, 'target-changed');
  assert.equal(env.reloads.length, 0);
  assert.equal(env.clock.timers.size, 0);
  installed.dispose();
});

for (const [kind, create] of [['Explore', exploreSetup], ['Search', searchSetup]]) {
  test(`${kind} refuses drafts, dialogs, hidden columns, mismatched targets and unavailable storage`, async () => {
    for (const [reason, change] of [
      ['draft', env => env.document.body.insertAdjacentHTML('beforeend', '<textarea data-testid="tweetTextarea_0">A draft</textarea>')],
      ['dialog', env => env.document.body.insertAdjacentHTML('beforeend', '<div role="dialog">A dialog</div>')],
      ['hidden', env => env.send({ type: 'yomikui-column-visibility', visible: false })],
      ['target-changed', env => { env.window.location.pathname = '/home'; env.document.body.innerHTML = home(); }],
      ['reload-unavailable', env => { env.window.sessionStorage.setItem = () => { throw new Error('Storage disabled'); }; }],
    ]) {
      const env = create();
      const installed = env.api.installFrame(env.options);
      change(env);
      env.send();
      await env.clock.advance(200);
      assert.equal(env.messages.at(-1).data.reason, reason);
      assert.equal(env.reloads.length, 0);
      installed.dispose();
    }
  });
}

test('Explore receipts are scoped to a column and origin, expire, and never cause a second reload', async () => {
  for (const invalid of [{ origin: 'https://untrusted.example' }, { started: -21000 }, { started: 1 }, { id: '' }, { kind: 'recommended' }, { kind: undefined }, { path: '/search?q=test' }]) {
    const env = exploreSetup();
    env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind: 'explore', path: '/explore/tabs/news', origin: 'https://x.com', started: 0, ...invalid }));
    const installed = env.api.installFrame(env.options);
    await settle();
    assert.deepEqual(env.messages, []);
    assert.deepEqual(env.reloads, []);
    assert.equal(env.storage.has(reloadKey), false);
    assert.equal(env.clock.timers.size, 0);
    installed.dispose();
  }
  const env = exploreSetup();
  env.storage.set('yomikui_page_refresh_v1:other-column', JSON.stringify({ id: 'other', kind: 'explore', path: '/explore/tabs/news', origin: 'https://x.com', started: 0 }));
  const installed = env.api.installFrame(env.options);
  await settle();
  assert.deepEqual(env.messages, []);
  installed.dispose();
});

for (const [kind, create] of [['explore', exploreSetup], ['search', searchSetup]]) {
  test(`${kind} reloads that never render are reported as unconfirmed and release observers`, async () => {
    const env = create(undefined, { loading: true });
    const path = env.window.location.pathname + env.window.location.search;
    env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind, path, origin: 'https://x.com', started: 0 }));
    const installed = env.api.installFrame(env.options);
    await env.clock.advance(20000);
    assert.equal(env.messages.at(-1).data.status, 'requested');
    assert.equal(env.messages.at(-1).data.method, 'reload');
    assert.equal(env.reloads.length, 0);
    assert.ok(env.observers.every(observer => !observer.connected));
    assert.equal(env.clock.timers.size, 0);
    installed.dispose();
  });
}

test('Explore root and trailing-slash URLs resume without switching their current tab', async () => {
  for (const path of ['/explore', '/explore/', '/explore/tabs/trending/']) {
    const env = exploreSetup(path.includes('trending') ? 'trending' : 'for_you');
    env.window.location.pathname = path;
    env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind: 'explore', path, origin: 'https://x.com', started: 0 }));
    const installed = env.api.installFrame(env.options);
    await settle();
    assert.equal(env.messages.at(-1).data.status, 'reloaded');
    assert.equal(env.reloads.length, 0);
    installed.dispose();
  }
});

for (const [kind, create] of [['explore', exploreSetup], ['search', searchSetup]]) {
  test(`${kind} pages reached through SPA navigation retain column bootstrap settings when reloaded`, async () => {
    const env = create();
    env.window.location.hash = '#yomikui-cidcolumn1-ctsearch-hb1';
    const installed = env.api.installFrame(env.options);
    env.window.location.hash = '';
    env.window.location.search += (env.window.location.search ? '&' : '?') + 'source=test';
    const path = env.window.location.pathname, query = env.window.location.search;
    env.send();
    await env.clock.advance(200);
    assert.equal(env.reloads.length, 1);
    assert.equal(env.reloads[0].pathname, path);
    assert.equal(env.reloads[0].search, query);
    assert.equal(env.reloads[0].hash, '#yomikui-cidcolumn1-ctsearch-hb1');
    installed.dispose();
  });
}

for (const [kind, create] of [['explore', exploreSetup], ['search', searchSetup]]) {
  test(`cancelling a ${kind} operation clears its receipt or its replacement-document observer`, async () => {
    for (const resuming of [false, true]) {
      const env = create(undefined, { loading: resuming });
      const path = env.window.location.pathname + env.window.location.search;
      if (resuming) env.storage.set(reloadKey, JSON.stringify({ id: 'reload1', kind, path, origin: 'https://x.com', started: 0 }));
      const installed = env.api.installFrame(env.options);
      if (!resuming) env.send();
      env.send({ type: P + 'cancel' });
      await settle();
      assert.equal(env.messages.at(-1).data.reason, 'cancelled');
      assert.equal(env.storage.has(reloadKey), false);
      assert.equal(env.clock.timers.size, 0);
      assert.ok(env.observers.every(observer => !observer.connected));
      installed.dispose();
    }
  });
}

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
  send({ target: 'invented' });
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

function readingFrameSetup() {
  const env = setup();
  env.window.innerHeight = 600;
  Object.assign(env.scroller, {
    clientHeight: 600, scrollHeight: 2200, getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    scrollTo({ top }) { this.scrollTop = top; },
  });
  const post = env.document.querySelector('article');
  post.getBoundingClientRect = () => ({ top: 1000 - env.scroller.scrollTop, height: 180, bottom: 1180 - env.scroller.scrollTop });
  const installed = env.api.installFrame(env.options);
  env.send = (data, event = {}) => env.window.emit('message', {
    source: env.window.parent, origin: 'https://x.com', data: { columnId: 'column1', requestId: 'read1', ...data }, ...event,
  });
  return { ...env, installed };
}

test('native reading validates commands and deduplicates repeated steps', () => {
  const env = readingFrameSetup();
  const data = { type: P + 'navigate', direction: 1, mode: 'post' };
  env.send(data, { source: {} });
  env.send(data, { origin: 'https://evil.example' });
  env.send({ ...data, columnId: 'another' });
  env.send({ ...data, direction: 10 });
  env.send({ ...data, mode: 'automatic' });
  assert.equal(env.scroller.scrollTop, 800);
  assert.equal(env.messages.length, 0);
  env.send(data);
  assert.equal(env.scroller.scrollTop, 1000);
  assert.equal(env.messages.at(-1).data.status, 'moved');
  env.send(data);
  assert.equal(env.scroller.scrollTop, 1000);
  env.installed.dispose();
  assert.equal(env.clock.timers.size, 0);
});

test('a trusted top command returns once without refreshing or replaying a duplicate request', () => {
  const env = readingFrameSetup();
  const data = { type: P + 'navigate', mode: 'top' };
  let clicks = 0;
  env.document.addEventListener('click', () => clicks++);
  env.send(data, { source: {} });
  env.send(data, { origin: 'https://evil.example' });
  assert.equal(env.scroller.scrollTop, 800);
  assert.equal(env.messages.length, 0);
  env.send(data);
  assert.equal(env.scroller.scrollTop, 0);
  assert.equal(env.messages.at(-1).data.status, 'moved');
  env.scroller.scrollTop = 400;
  env.send(data);
  assert.equal(env.scroller.scrollTop, 400, 'a duplicate must not reset a later reading position');
  assert.equal(clicks, 0);
  env.installed.dispose();
});

test('continuous wheel messages validate the sender, amount and current group and do not reply per frame', () => {
  const env = readingFrameSetup();
  const data = { type: P + 'scroll', mode: 'wheel', deltaY: 120, deltaMode: 0, group: 'recommended' };
  let clicks = 0;
  env.document.addEventListener('click', () => clicks++);
  env.send(data, { source: {} });
  env.send(data, { origin: 'https://evil.example' });
  env.send({ ...data, columnId: 'another' });
  env.send({ ...data, deltaY: NaN });
  env.send({ ...data, deltaMode: 3 });
  env.send({ ...data, mode: 'top' });
  env.send({ ...data, type: P + 'navigate' });
  assert.equal(env.scroller.scrollTop, 800);
  env.send(data);
  assert.equal(env.scroller.scrollTop, 920);
  env.send(data);
  assert.equal(env.scroller.scrollTop, 920, 'duplicate delivery does not apply the delta twice');
  env.send({ ...data, deltaY: -20, requestId: 'up' });
  assert.equal(env.scroller.scrollTop, 900);
  env.document.getElementById('recommended').setAttribute('aria-selected', 'false');
  env.document.getElementById('following').setAttribute('aria-selected', 'true');
  env.send({ ...data, requestId: 'changed' });
  assert.equal(env.scroller.scrollTop, 900);
  env.send({ ...data, group: 'following', requestId: 'following' });
  assert.equal(env.scroller.scrollTop, 1020);
  env.send({ type: 'yomikui-column-visibility', visible: false });
  env.send({ ...data, group: 'following', requestId: 'hidden' });
  assert.equal(env.scroller.scrollTop, 1020);
  assert.equal(env.messages.length, 0);
  assert.equal(clicks, 0);
  env.installed.dispose();
});

test('offscreen native frames reject reading commands', () => {
  const env = readingFrameSetup();
  env.send({ type: 'yomikui-column-visibility', visible: false });
  env.send({ type: P + 'navigate', direction: 1, mode: 'post' });
  assert.equal(env.messages.at(-1).data.reason, 'hidden');
  assert.equal(env.scroller.scrollTop, 800);
  env.send({ type: P + 'navigate', mode: 'top', requestId: 'top' });
  assert.equal(env.messages.at(-1).data.reason, 'hidden');
  assert.equal(env.scroller.scrollTop, 800);
  env.installed.dispose();
});

test('native frames recheck the selected group at execution time', () => {
  const env = readingFrameSetup();
  env.document.getElementById('recommended').setAttribute('aria-selected', 'false');
  env.document.getElementById('following').setAttribute('aria-selected', 'true');
  env.send({ type: P + 'navigate', mode: 'top', group: 'recommended', requestId: 'stale' });
  assert.equal(env.scroller.scrollTop, 800);
  assert.equal(env.messages.at(-1).data.reason, 'target-changed');
  env.send({ type: P + 'navigate', mode: 'top', group: 'following', requestId: 'following' });
  assert.equal(env.scroller.scrollTop, 0);
  env.scroller.scrollTop = 800;
  env.window.location.pathname = '/search';
  env.send({ type: P + 'navigate', mode: 'top', group: 'following', requestId: 'old-page' });
  assert.equal(env.scroller.scrollTop, 800);
  env.send({ type: P + 'navigate', mode: 'top', group: 'search', requestId: 'search' });
  assert.equal(env.scroller.scrollTop, 0, 'the displayed search page wins over the saved home column type');
  env.scroller.scrollTop = 800;
  const messages = env.messages.length;
  env.send({ type: P + 'navigate', mode: 'top', group: 'invented', requestId: 'invalid' });
  assert.equal(env.scroller.scrollTop, 800);
  assert.equal(env.messages.length, messages);
  env.installed.dispose();
});

test('reading context tracks tabs and routes, ignores ordinary posts, and pauses in hidden columns', async () => {
  const env = readingFrameSetup();
  env.window.navigation = new Events();
  const describe = { type: P + 'describe' };
  env.send(describe, { source: {} });
  env.send(describe, { origin: 'https://evil.example' });
  env.send({ ...describe, columnId: 'another' });
  assert.equal(env.messages.length, 0);
  env.send(describe);
  assert.equal(env.messages.at(-1).data.kind, 'recommended');
  env.document.getElementById('recommended').setAttribute('aria-selected', 'false');
  env.document.getElementById('following').setAttribute('aria-selected', 'true');
  await settle(); env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, 'following');
  const messages = env.messages.length;
  env.document.getElementById('tweets').innerHTML += tweet('202');
  await settle();
  assert.equal(env.clock.frames.size, 0, 'ordinary post insertions do not rescan the page');
  assert.equal(env.messages.length, messages);
  env.window.location.pathname = '/search';
  env.window.navigation.emit('currententrychange');
  env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, 'search');
  env.send({ type: 'yomikui-column-visibility', visible: false });
  assert.equal(env.messages.at(-1).data.kind, null);
  assert.ok(env.observers.every(observer => !observer.connected));
  env.window.location.pathname = '/home';
  env.document.getElementById('following').setAttribute('aria-selected', 'false');
  env.document.getElementById('recommended').setAttribute('aria-selected', 'true');
  await settle();
  assert.equal(env.clock.frames.size, 0);
  env.send({ type: 'yomikui-column-visibility', visible: true });
  assert.equal(env.messages.at(-1).data.kind, 'recommended');
  env.window.location.pathname = '/someone/status/123';
  env.window.navigation.emit('currententrychange');
  env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, null);
  env.installed.dispose();
  assert.equal(env.clock.frames.size, 0);
  assert.ok(env.observers.every(observer => !observer.connected));
  assert.ok([...env.window.navigation.listeners.values()].every(listeners => listeners.length === 0));
});

test('reading context discovers late tabs and a replaced page, and releases work while the tab is hidden', async () => {
  const env = setup(home({ loading: true }));
  const installed = env.api.installFrame(env.options);
  env.window.emit('message', { source: env.window.parent, origin: 'https://x.com', data: { type: P + 'describe', columnId: 'column1' } });
  assert.equal(env.messages.at(-1).data.kind, null);
  env.document.getElementById('tabs').innerHTML = tabs();
  await settle(); env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, 'recommended');
  const selected = env.document.getElementById('recommended');
  const observer = env.observers.at(-1);
  selected.innerHTML = '<span>Loading</span>';
  // Linkedom reports the observed root as a child-list target and does not
  // emit native characterData records. Supply the browser's record shape.
  observer.emit([{ type: 'childList', target: selected, addedNodes: [...selected.childNodes], removedNodes: [] }]);
  await settle(); env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, 'other');
  selected.firstChild.firstChild.data = 'おすすめ';
  observer.emit([{ type: 'characterData', target: selected.firstChild.firstChild, addedNodes: [], removedNodes: [] }]);
  await settle(); env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, 'recommended', 'late text hydration updates the group');
  env.document.body.innerHTML = home({ selected: 'following' });
  await settle(); env.clock.frame(16);
  assert.equal(env.messages.at(-1).data.kind, 'following');
  env.document.hidden = true;
  env.document.dispatchEvent(new env.document.defaultView.Event('visibilitychange'));
  assert.equal(env.messages.at(-1).data.kind, null);
  assert.ok(env.observers.every(observer => !observer.connected));
  env.document.hidden = false;
  env.document.dispatchEvent(new env.document.defaultView.Event('visibilitychange'));
  assert.equal(env.messages.at(-1).data.kind, 'following');
  installed.dispose();
  assert.equal(env.clock.frames.size, 0);
  assert.equal(env.clock.timers.size, 0);
});

test('reading cannot interrupt a native refresh but cancels its remaining scroll correction afterwards', async () => {
  const env = readingFrameSetup();
  env.document.getElementById('recommended').addEventListener('click', () => {
    env.document.querySelector('article a').setAttribute('href', '/author/status/202');
  });
  env.send({ type: P + 'request', target: 'recommended', requestId: 'refresh1' });
  env.send({ type: P + 'navigate', direction: 1, mode: 'post', requestId: 'too-early' });
  assert.equal(env.messages.at(-1).data.reason, 'busy');
  env.send({ type: P + 'scroll', mode: 'wheel', deltaY: 120, deltaMode: 0, requestId: 'wheel-too-early' });
  assert.equal(env.scroller.scrollTop, 800, 'wheel input cannot interrupt refresh preparation');
  await settle();
  await env.clock.advance(200);
  assert.equal(env.messages.at(-1).data.status, 'updated');
  env.send({ type: P + 'navigate', direction: 1, mode: 'page' });
  assert.equal(env.scroller.scrollTop, 480);
  await env.clock.advance(6500);
  assert.equal(env.scroller.scrollTop, 480, 'the refresh tracker must not snap a reading action back to the top');
  env.installed.dispose();
  assert.equal(env.clock.timers.size, 0);
});

function batchSetup({ columns, quiet, offscreen = [], currentKinds = {} } = {}) {
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
  const kinds = new Map(state.columns.map(column => [column.id, currentKinds[column.id] ?? (column.type === 'home' ? 'recommended' : column.type === 'search' || column.type === 'following' ? 'search' : column.type === 'explore' ? 'explore' : 'other')]));
  const visible = new Set(state.columns.filter(column => !offscreen.includes(column.id)).map(column => column.id));
  for (const column of state.columns) {
    const frame = { postMessage(data, origin) {
      if (data.type === P + 'describe') {
        env.window.emit('message', { source: frame, origin, data: { type: P + 'context', columnId: column.id, kind: kinds.get(column.id) } });
        return;
      }
      messages.push({ ...clone(data), origin });
      if (quiet?.(column.id, data.type)) return;
      if (data.type === P + 'probe') {
        env.window.emit('message', { source: frame, origin, data: { ...data, type: P + 'ready' } });
      } else if (data.type === P + 'request') {
        const reload = ['explore', 'search'].includes(data.target);
        if (reload) env.window.emit('message', { source: frame, origin, data: { ...data, type: P + 'reloading' } });
        env.clock.setTimeout(() => env.window.emit('message', { source: frame, origin, data: { ...data, type: P + 'result', status: reload ? 'reloaded' : 'updated', method: reload ? 'reload' : 'tab' } }), 30);
      }
    } };
    frames.set(column.id, frame);
  }
  const getFrame = id => frames.has(id) ? { window: frames.get(id), origin: 'https://x.com' } : null;
  const reader = new env.context.YomikuiFloatingControls.ReadingController({
    getState: () => state, getFrame, getVisibleIds: () => visible, onChange() {},
  });
  const batch = new env.api.BatchRefresher({
    getState: () => state,
    getFrame,
    getTargets: target => {
      const kinds = reader.kinds();
      return reader.selectedColumns(target).map(column => ({ ...column, refreshKind: kinds[column.id] }));
    },
    setMounted: ids => mounts.push([...ids]),
    onChange: value => views.push(clone(value)),
  });
  const report = (id, kind) => {
    kinds.set(id, kind);
    env.window.emit('message', { source: frames.get(id), origin: 'https://x.com', data: { type: P + 'context', columnId: id, kind } });
  };
  return { ...env, batch, reader, state, activity, messages, mounts, frames, views, visible, report };
}

test('one user action updates visible supported pages sequentially and leaves offscreen columns alone', async () => {
  const env = batchSetup({
    columns: [
      { id: 'home1', type: 'home' }, { id: 'search', type: 'search' },
      { id: 'live', type: 'home', liveFeed: true }, { id: 'home2', type: 'home' },
      { id: 'draft', type: 'home' },
    ], offscreen: ['home2'],
  });
  env.state.columnComposing.draft = true;
  const run = env.batch.run();
  await env.batch.run();
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1']);
  await env.clock.advance(1500);
  await run;
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => item.columnId), ['home1', 'search']);
  assert.equal(env.views.at(-1).total, 3);
  assert.deepEqual(env.views.at(-1).results.map(item => item.status), ['updated', 'reloaded', 'skipped']);
  assert.equal(env.views.at(-1).results.at(-1).reason, 'draft');
  assert.deepEqual(env.mounts, []);
  assert.deepEqual(env.activity, ['home1', 'search']);
  const sent = env.messages.length;
  await env.batch.run();
  assert.equal(env.messages.length, sent, 'cooldown prevents another batch');
  await env.clock.advance(5000);
  assert.equal(env.clock.timers.size, 0, 'the idle control has no polling timers');
  env.batch.dispose();
});

test('a multiple-group refresh snapshots its scope, visits each visible column once and skips changed kinds', async () => {
  for (const changeNext of [false, true]) {
    const env = batchSetup({ columns: [
      { id: 'home', type: 'home' }, { id: 'search', type: 'search' }, { id: 'explore', type: 'explore' }, { id: 'offscreen', type: 'home' },
    ], offscreen: ['offscreen'] });
    const target = ['recommended', 'search', 'recommended'];
    const run = env.batch.run({ target });
    target.splice(0, target.length, 'explore');
    if (changeNext) env.report('search', 'following');
    await env.clock.advance(1000); await run;
    assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => message.columnId), changeNext ? ['home'] : ['home', 'search']);
    if (changeNext) assert.equal(env.views.at(-1).results.at(-1).reason, 'target-changed');
    env.batch.dispose();
  }
});

test('one batch dispatches each visible current page to its own refresh strategy in order', async () => {
  const env = batchSetup({ columns: [
    { id: 'recommendations', type: 'home' }, { id: 'following-tab', type: 'home' },
    { id: 'news', type: 'customUrl' }, { id: 'keyword-search', type: 'search' },
    { id: 'following-search', type: 'following' }, { id: 'offscreen', type: 'explore' },
    { id: 'offscreen-search', type: 'search' },
  ], currentKinds: { 'following-tab': 'following', news: 'explore' }, offscreen: ['offscreen', 'offscreen-search'] });
  const run = env.batch.run();
  assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => message.target), ['recommended']);
  await env.clock.advance(2500);
  await run;
  assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => [message.columnId, message.target]), [
    ['recommendations', 'recommended'], ['following-tab', 'following'], ['news', 'explore'], ['keyword-search', 'search'], ['following-search', 'search'],
  ]);
  assert.deepEqual(env.views.at(-1).results.map(result => result.status), ['updated', 'updated', 'reloaded', 'reloaded', 'reloaded']);
  assert.equal(env.api.summary(env.views.at(-1)), '表示更新 2列 ／ 再読み込み 3列');
  assert.deepEqual(env.mounts, []);
  env.batch.dispose();
});

for (const kind of ['explore', 'search', 'recommended', 'following']) {
  test(`${kind} reload tolerates its unloading context but waits for a trusted completion before advancing`, async () => {
    const env = batchSetup({ columns: [{ id: 'news', type: 'home' }, { id: 'home', type: 'home' }], currentKinds: { news: kind }, quiet: (id, type) => id === 'news' && type === P + 'request' });
    const run = env.batch.run({ target: 'all' });
    const request = env.messages.find(message => message.type === P + 'request');
    const emit = (type, status, changes = {}) => env.window.emit('message', {
      source: env.frames.get('news'), origin: 'https://x.com', data: { ...request, type: P + type, status, method: 'reload' }, ...changes,
    });
    emit('result', 'reloaded');
    assert.equal(env.views.at(-1).done, 0, 'completion requires the reload-start acknowledgement');
    emit('reloading');
    env.report('news', null);
    env.batch.syncState();
    await env.clock.advance(12000);
    assert.equal(env.views.at(-1).done, 0);
    assert.equal(env.messages.filter(message => message.type === P + 'request').length, 1);
    emit('result', 'reloaded', { source: {} });
    emit('result', 'reloaded', { origin: 'https://untrusted.example' });
    assert.equal(env.views.at(-1).done, 0);
    env.report('news', kind);
    emit('result', 'reloaded');
    await settle();
    await env.clock.advance(1000);
    await run;
    assert.deepEqual(env.views.at(-1).results.map(result => result.status), ['reloaded', 'updated']);
    env.batch.dispose();
    assert.equal(env.clock.timers.size, 0);
  });

  for (const change of ['offscreen', 'page', 'frame', 'workspace']) {
    test(`${kind} reload is cancelled on ${change} without replaying it`, async () => {
      const env = batchSetup({ columns: [{ id: 'news', type: 'home' }, { id: 'home', type: 'home' }], currentKinds: { news: kind }, quiet: (id, type) => id === 'news' && type === P + 'request' });
      const run = env.batch.run();
      const request = env.messages.find(message => message.type === P + 'request');
      env.window.emit('message', { source: env.frames.get('news'), origin: 'https://x.com', data: { ...request, type: P + 'reloading' } });
      env.report('news', null);
      if (change === 'offscreen') env.visible.delete('news');
      if (change === 'page') env.report('news', kind === 'explore' ? 'search' : 'explore');
      if (change === 'frame') env.frames.set('news', { postMessage() {} });
      if (change === 'workspace') env.state.activeWorkspaceId = 'other';
      env.batch.syncState();
      await settle();
      await env.clock.advance(1000);
      await run;
      assert.equal(env.views.at(-1).results[0].status, 'skipped');
      assert.equal(env.messages.filter(message => message.type === P + 'request' && message.columnId === 'news').length, 1);
      assert.equal(env.messages.filter(message => message.type === P + 'request' && message.columnId === 'home').length, change === 'workspace' ? 0 : 1);
      env.batch.dispose();
      assert.equal(env.clock.timers.size, 0);
    });
  }
}

test('changing the next Home tab during an all-visible batch does not silently refresh the new tab', async () => {
  const env = batchSetup();
  const run = env.batch.run();
  env.report('home2', 'following');
  await env.clock.advance(1000);
  await run;
  assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => message.columnId), ['home1']);
  assert.equal(env.views.at(-1).results[1].reason, 'target-changed');
  env.batch.dispose();
});

test('scrolling and updating recommendations select the same visible columns regardless of their initial type', async () => {
  const env = batchSetup({ columns: [
    { id: 'search-to-home', type: 'search', activeTab: '最新' },
    { id: 'home-to-search', type: 'home', activeTab: 'おすすめ' },
    { id: 'url-to-home', type: 'customUrl' },
    { id: 'offscreen', type: 'home' },
    { id: 'live', type: 'home', liveFeed: true },
  ], currentKinds: { 'search-to-home': 'recommended', 'home-to-search': 'search', 'url-to-home': 'recommended' }, offscreen: ['offscreen'] });
  const selected = Array.from(env.reader.selectedColumns('group:recommended'), column => column.id);
  assert.deepEqual(selected, ['search-to-home', 'url-to-home']);
  const run = env.batch.run({ target: 'group:recommended' });
  await env.clock.advance(1000);
  await run;
  assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => message.columnId), selected);
  assert.deepEqual(env.mounts, []);
  env.batch.dispose();
});

test('refresh honors an individual selection, never falls back from an empty group, and rechecks queued columns', async () => {
  const individual = batchSetup();
  const one = individual.batch.run({ target: 'home2' });
  await individual.clock.advance(1000);
  await one;
  assert.deepEqual(individual.messages.filter(message => message.type === P + 'request').map(message => message.columnId), ['home2']);
  individual.batch.dispose();

  const empty = batchSetup();
  await empty.batch.run({ target: 'group:search' });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.batch.view.phase, 'idle');
  empty.batch.dispose();

  const changed = batchSetup();
  const run = changed.batch.run({ target: 'group:recommended' });
  changed.report('home2', 'search');
  await changed.clock.advance(1000);
  await run;
  assert.deepEqual(changed.messages.filter(message => message.type === P + 'request').map(message => message.columnId), ['home1']);
  assert.equal(changed.views.at(-1).results[1].reason, 'target-changed');
  changed.batch.dispose();
});

test('a readiness reply cannot refresh a column that has left the selected group or viewport', async () => {
  for (const change of [env => env.report('home1', 'search'), env => env.visible.delete('home1')]) {
    const env = batchSetup({ quiet: (id, type) => id === 'home1' && type === P + 'probe' });
    const run = env.batch.run();
    const probe = env.messages[0];
    change(env);
    env.window.emit('message', { source: env.frames.get('home1'), origin: 'https://x.com', data: { ...probe, type: P + 'ready' } });
    await settle();
    await env.clock.advance(1000);
    await run;
    assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => message.columnId), ['home2']);
    assert.equal(env.views.at(-1).results[0].reason, 'target-changed');
    env.batch.dispose();
  }
});

test('the floating control enables search-origin columns and forwards the selected target to the actual refresher', async () => {
  const env = batchSetup({ columns: [
    { id: 'search1', type: 'search' }, { id: 'search2', type: 'search' },
  ], currentKinds: { search1: 'recommended', search2: 'recommended' } });
  const api = env.context.YomikuiFloatingControls;
  env.context.YomikuiFloatingControls = { ...api, ReadingController: class extends api.ReadingController {
    constructor(options) { super({ ...options, getVisibleIds: () => env.visible }); }
  } };
  const cleanups = [];
  const React = {
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useRef: current => ({ current }), useCallback: fn => fn,
    useEffect: fn => cleanups.push(fn()),
  };
  const store = { getState: () => env.state, subscribe: () => () => {} };
  const element = (type, props) => ({ type, props });
  const panel = env.api.FloatingControl({
    React, jsx: { jsx: element }, store, columns: env.state.columns, frames: { current: env.frames },
    origins: { current: new Map() }, onMountChange() {}, hidden: false,
  });
  assert.equal(panel.props.canRefresh, true);
  panel.props.onRefresh({ target: 'search2' });
  await env.clock.advance(1000);
  assert.deepEqual(env.messages.filter(message => message.type === P + 'request').map(message => message.columnId), ['search2']);
  cleanups.reverse().forEach(cleanup => cleanup?.());
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

test('current tabs override stale saved labels and both selected Home tabs are refreshed', async () => {
  const env = batchSetup({ columns: [
    { id: 'home1', type: 'home', activeTab: 'フォロー中' },
    { id: 'home2', type: 'home', activeTab: 'おすすめ' },
    { id: 'home3', type: 'home', activeTab: 'For you' },
  ], currentKinds: { home1: 'following', home2: 'following', home3: 'recommended' } });
  env.state.columnActiveTabs = { home2: 'Following' };
  const run = env.batch.run();
  await env.clock.advance(1500);
  await run;
  assert.deepEqual(env.messages.filter(item => item.type === P + 'request').map(item => [item.columnId, item.target]), [['home1', 'following'], ['home2', 'following'], ['home3', 'recommended']]);
  assert.deepEqual(env.views.at(-1).results.map(item => item.status), ['updated', 'updated', 'updated']);
  assert.deepEqual(env.mounts, []);
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
    assert.deepEqual(env.mounts, []);
    env.batch.dispose();
    assert.equal(env.clock.timers.size, 0);
  });
}

test('disposing during a running batch clears request deadlines', async () => {
  const env = batchSetup({ quiet: () => true });
  const run = env.batch.run();
  env.batch.dispose();
  await run;
  assert.equal(env.clock.timers.size, 0);
  assert.deepEqual(env.mounts, []);
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
  Object.assign(env.context, { je: env.settings, _Q: () => env.scroller, Uh: 'https://x.com', ln: 'column1', frameMaintenance: { count: 200 }, ru: null });
  vm.runInContext(bundle.slice(start, end) + 'startNativeHomeRefresh();', env.context);
  env.window.emit('message', { source: env.window.parent, origin: 'https://x.com', data: { type: P + 'probe', columnId: 'column1', requestId: 'probe' } });
  assert.equal(env.messages.at(-1).data.type, P + 'ready');
  assert.match(bundle, /HO\(\),startFrameMaintenance\(\),startNativeHomeRefresh\(\)/);
});

test('the shipped initializer reads the live maintenance count instead of the mounted tweet elements', async () => {
  const env = setup();
  const bundle = readFileSync(new URL('../contentIframe.js', import.meta.url), 'utf8');
  const start = bundle.indexOf('function startNativeHomeRefresh()');
  const end = bundle.indexOf('function EO(', start);
  const maintenance = { count: 199 };
  Object.assign(env.context, { je: env.settings, _Q: () => env.scroller, Uh: 'https://x.com', ln: 'column1', frameMaintenance: maintenance, ru: null });
  vm.runInContext(bundle.slice(start, end) + 'startNativeHomeRefresh();', env.context);
  maintenance.count = 200;
  env.window.emit('message', { source: env.window.parent, origin: 'https://x.com', data: { type: P + 'request', columnId: 'column1', requestId: 'reload1', target: 'recommended' } });
  await env.clock.advance(200);
  assert.equal(env.reloads.length, 1);
  assert.equal(env.messages.at(-1).data.type, P + 'reloading');
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
