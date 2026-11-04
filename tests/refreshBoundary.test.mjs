import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events, settle } from './helpers.mjs';

const scrollSource = readFileSync(new URL('../homeScroll.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../refreshBoundary.js', import.meta.url), 'utf8');
const TWEET = 'article[data-testid="tweet"]';
const ATTRIBUTE = 'data-yomikui-refresh-boundary';
const post = (id, inner = '') => `<article data-testid="tweet"><a href="/author/status/${id}"><time>Now</time></a>${inner}</article>`;
const home = content => `<main data-testid="primaryColumn"><div role="tablist">
  <a role="tab" id="recommended" aria-selected="true">おすすめ</a>
  <a role="tab" id="following" aria-selected="false">フォロー中</a>
  </div><div id="posts">${content}</div></main>`;

function setup(content = post('101')) {
  const clock = new Clock();
  const { document, window: dom } = parseHTML(`<html><head></head><body>${home(content)}</body></html>`);
  document.hidden = false;
  const window = new Events();
  window.location = { pathname: '/home', search: '' };
  window.navigation = new Events();
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.inner = new dom.MutationObserver(callback); observers.push(this); }
    observe(...args) { this.connected = true; this.inner.observe(...args); }
    disconnect() { this.connected = false; this.inner.disconnect(); }
  }
  // Landmark placement must not measure or move any post or scroller.
  dom.HTMLElement.prototype.getBoundingClientRect = () => { throw new Error('Unexpected layout read'); };
  const settings = { columnType: 'home' };
  const context = vm.createContext({ ...clock.globals(), document, window, MutationObserver, Event: dom.Event });
  vm.runInContext(scrollSource, context);
  vm.runInContext(source, context);
  const boundary = new context.YomikuiRefreshBoundary({ getSettings: () => settings });
  const markers = () => [...document.querySelectorAll('.yomikui-refresh-boundary')];
  const markedId = () => document.querySelector(`[${ATTRIBUTE}]`)?.getAttribute(ATTRIBUTE);
  const flush = async () => { await settle(); await clock.advance(80); };
  return { clock, document, window, context, settings, boundary, markers, markedId, observers, flush };
}

test('a landmark waits for its exact post, follows virtualized elements and repairs a removed decoration', async () => {
  const env = setup();
  const snapshot = env.boundary.snapshot('recommended');
  env.boundary.set(snapshot);
  env.document.getElementById('posts').innerHTML = post('202');
  await env.flush();
  assert.equal(env.markers().length, 0, 'never guess a boundary at a different post');
  env.document.getElementById('posts').insertAdjacentHTML('beforeend', post('101'));
  await env.flush();
  assert.equal(env.markedId(), '101');
  const article = env.markers()[0].parentElement;
  assert.equal(env.markers()[0].getAttribute('role'), 'separator');
  assert.equal(env.markers()[0].getAttribute('aria-label'), '更新前の先頭');
  env.markers()[0].remove();
  await env.flush();
  assert.equal(env.markers()[0].parentElement, article);
  article.remove();
  await env.flush();
  assert.equal(article.hasAttribute(ATTRIBUTE), false);
  assert.equal(env.markers().length, 0);
  env.document.getElementById('posts').appendChild(article);
  await env.flush();
  assert.equal(env.markedId(), '101');
  assert.equal(env.markers().length, 1);
  env.boundary.dispose();
});

test('a reused tweet node loses its landmark as soon as its own post ID changes', async () => {
  const env = setup(post('101', '<div><a href="/quoted/status/999"><time>Quote</time></a></div>'));
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  const article = env.document.querySelector(TWEET);
  article.querySelector('time').closest('a').setAttribute('href', '/author/status/202');
  await env.flush();
  assert.equal(env.markers().length, 0);
  assert.equal(article.hasAttribute(ATTRIBUTE), false);
  env.document.getElementById('posts').insertAdjacentHTML('beforeend', post('303', '<div><a href="/quoted/status/101"><time>Quote</time></a></div>'));
  await env.flush();
  assert.equal(env.markers().length, 0, 'a quote of the old post is not the old timeline entry');
  article.querySelector('time').closest('a').setAttribute('href', '/author/status/101');
  await env.flush();
  assert.equal(env.markedId(), '101');
  env.boundary.dispose();
});

test('replacing the page wrapper still discovers the landmark, and duplicates never add another one', async () => {
  const env = setup();
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  env.document.body.innerHTML = `<section>${home(post('202') + post('101'))}</section>`;
  await env.flush();
  assert.equal(env.markedId(), '101');
  const first = env.markers()[0].parentElement;
  env.document.getElementById('posts').insertAdjacentHTML('beforeend', post('101'));
  await env.flush();
  assert.equal(env.markers().length, 1);
  assert.equal(env.markers()[0].parentElement, first);
  env.boundary.dispose();
});

test('the next refresh replaces the previous landmark, and an empty feed clears it', async () => {
  const env = setup();
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  env.document.getElementById('posts').insertAdjacentHTML('afterbegin', post('202'));
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  assert.equal(env.markedId(), '202');
  assert.equal(env.markers().length, 1);
  env.document.getElementById('posts').innerHTML = '';
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  assert.equal(env.markers().length, 0);
  assert.ok(env.observers.every(observer => !observer.connected));
  assert.equal(env.clock.timers.size, 0);
  env.boundary.dispose();
});

test('hidden columns and tabs release observation and timers and rediscover the post on return', async () => {
  const env = setup();
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  for (const column of [true, false]) {
    if (column) env.boundary.setVisible(false);
    else { env.document.hidden = true; env.document.dispatchEvent(new env.context.Event('visibilitychange')); }
    assert.equal(env.markers().length, 0);
    assert.equal(env.clock.timers.size, 0);
    assert.ok(env.observers.every(observer => !observer.connected));
    env.document.getElementById('posts').innerHTML = post('202') + post('101');
    if (column) env.boundary.setVisible(true);
    else { env.document.hidden = false; env.document.dispatchEvent(new env.context.Event('visibilitychange')); }
    await env.flush();
    assert.equal(env.markedId(), '101');
  }
  env.boundary.dispose();
  assert.ok(env.observers.every(observer => !observer.connected));
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.markers().length, 0);
});

for (const change of ['tab', 'query', 'page']) {
  test(`changing the ${change} clears the landmark instead of moving it to another feed`, async () => {
    const env = setup();
    env.boundary.set(env.boundary.snapshot('recommended'));
    await env.flush();
    if (change === 'tab') {
      env.document.getElementById('recommended').setAttribute('aria-selected', 'false');
      env.document.getElementById('following').setAttribute('aria-selected', 'true');
    } else {
      if (change === 'query') env.window.location.search = '?different=1';
      else env.window.location.pathname = '/author/status/101';
      env.window.navigation.emit('navigatesuccess');
    }
    await env.flush();
    assert.equal(env.markers().length, 0);
    assert.ok(env.observers.every(observer => !observer.connected));
    env.window.location = { pathname: '/home', search: '' };
    env.document.getElementById('recommended').setAttribute('aria-selected', 'true');
    env.window.emit('popstate');
    await env.flush();
    assert.equal(env.markers().length, 0, 'leaving the feed expires the previous landmark');
    env.boundary.dispose();
  });
}

test('scrolling does no landmark work, busy DOM updates are batched, and idle time needs no polling', async () => {
  const env = setup(post('101') + post('202'));
  const root = env.document.querySelector('[data-testid="primaryColumn"]');
  const queryAll = root.querySelectorAll.bind(root);
  let scans = 0;
  root.querySelectorAll = selector => { if (selector === TWEET) scans++; return queryAll(selector); };
  env.boundary.set(env.boundary.snapshot('recommended'));
  await env.flush();
  assert.equal(scans, 1);
  for (let i = 0; i < 100; i++) env.window.emit('scroll');
  assert.equal(env.clock.timers.size, 0);
  const other = root.querySelectorAll(TWEET)[1];
  const baseline = scans;
  for (let i = 0; i < 100; i++) other.appendChild(env.document.createElement('span'));
  await settle();
  assert.equal(env.clock.timers.size, 1);
  await env.clock.advance(80);
  assert.equal(scans, baseline, 'changes do not rescan the full timeline');
  assert.equal(env.clock.timers.size, 0);
  await env.clock.advance(60000);
  assert.equal(env.clock.timers.size, 0);
  assert.equal(scans, baseline);
  assert.equal(env.markers().length, 1);
  env.boundary.dispose();
});

test('invalid snapshots and non-post content create no landmark or background work', () => {
  const env = setup('<a href="/i/trending/123">News</a>');
  assert.equal(env.boundary.snapshot('recommended'), null);
  for (const entry of [null, {}, { id: 'not-an-id', path: '/home', kind: 'recommended' },
    { id: '101', path: '/search?q=other', kind: 'recommended' },
    { id: '101', path: '/home', kind: 'unknown' }]) env.boundary.set(entry);
  assert.equal(env.markers().length, 0);
  assert.equal(env.clock.timers.size, 0);
  assert.ok(env.observers.every(observer => !observer.connected));
  env.boundary.dispose();
});

test('native frames load the landmark helper after scroll utilities and before refresh installation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const frame = manifest.content_scripts.find(entry => entry.js?.includes('contentIframe.js'));
  assert.ok(frame.js.indexOf('refreshBoundary.js') > frame.js.indexOf('homeScroll.js'));
  assert.ok(frame.js.indexOf('refreshBoundary.js') < frame.js.indexOf('homeRefresh.js'));
});
