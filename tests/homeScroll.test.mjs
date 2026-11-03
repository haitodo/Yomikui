import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events, settle } from './helpers.mjs';

const source = readFileSync(new URL('../homeScroll.js', import.meta.url), 'utf8');
const post = (id, y) => `<article data-testid="tweet" data-y="${y}"><a href="/author/status/${id}"><time>Now</time></a></article>`;

function setup(mode) {
  const clock = new Clock();
  const { document, window: dom } = parseHTML(`<html><body><main data-testid="primaryColumn">
    <div id="header" style="display:none"><div role="tab" aria-selected="true">おすすめ</div></div>
    <button id="new">35件のポストを表示</button><div id="posts">${post('101', 100)}${post('102', 300)}</div>
  </main></body></html>`);
  const window = new Events();
  window.location = { pathname: '/home' };
  window.innerHeight = 600;
  const scroller = { scrollTop: 100 };
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = Number(this.getAttribute('data-y') ?? 0) - scroller.scrollTop;
    return { top, bottom: top + 150, height: 150 };
  };
  const settings = { columnType: 'home', homeRefreshPosition: mode };
  const context = vm.createContext({ ...clock.globals(), window, document, MutationObserver: dom.MutationObserver });
  vm.runInContext(source, context);
  const api = context.YomikuiHomeScroll;
  const tracker = new api.Tracker({ getSettings: () => settings, getScroller: () => scroller });
  return { api, tracker, settings, scroller, document, window, clock, context };
}

async function prepend(env) {
  env.document.querySelector('[data-y="100"]').setAttribute('data-y', '600');
  env.document.querySelector('[data-y="300"]').setAttribute('data-y', '800');
  env.document.getElementById('posts').insertAdjacentHTML('afterbegin', post('202', 100));
  await settle();
  await env.clock.advance(0);
}

test('standard mode returns to the newest post after insertion and late X scroll corrections', async () => {
  const env = setup();
  env.tracker.request(env.tracker.begin());
  await prepend(env);
  assert.equal(env.scroller.scrollTop, 0);
  env.scroller.scrollTop = 500;
  env.window.emit('scroll');
  await env.clock.advance(0);
  assert.equal(env.scroller.scrollTop, 0);
  await env.clock.advance(1300);
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.tracker.job, null);
});

test('preserve mode follows the same visible post across prep scrolling and new content heights', async () => {
  const env = setup('preserve');
  const job = env.tracker.begin();
  env.scroller.scrollTop = 0; // The native refresh prepares its hidden tab at the top.
  env.tracker.request(job);
  await prepend(env);
  assert.equal(env.scroller.scrollTop, 600);
  assert.equal(env.document.querySelector('[data-y="600"]').getBoundingClientRect().top, 0);
  env.document.querySelector('[data-y="600"]').setAttribute('data-y', '700');
  env.document.getElementById('posts').appendChild(env.document.createElement('div'));
  await settle();
  await env.clock.advance(0);
  assert.equal(env.scroller.scrollTop, 700);
  await env.clock.advance(1300);
  assert.equal(env.clock.timers.size, 0);
});

test('a removed anchor falls back to the previous scroll position', async () => {
  const env = setup('preserve');
  const job = env.tracker.begin();
  env.scroller.scrollTop = 0;
  env.tracker.request(job);
  env.document.getElementById('posts').innerHTML = post('202', 100);
  await settle();
  await env.clock.advance(0);
  assert.equal(env.scroller.scrollTop, 100);
  env.tracker.cancel();
  assert.equal(env.clock.timers.size, 0);
});

for (const input of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
  test(`user ${input} cancels pending position adjustments`, async () => {
    const env = setup();
    env.tracker.request(env.tracker.begin());
    env.window.emit(input, { key: 'PageDown' });
    await prepend(env);
    assert.equal(env.scroller.scrollTop, 100);
    assert.equal(env.clock.timers.size, 0);
    assert.equal(env.tracker.job, null);
  });
}

test('cancellation, setting changes and switching to Following release all tracking', async () => {
  for (const cause of ['abort', 'mode', 'following']) {
    const env = setup();
    const abort = new AbortController();
    env.tracker.request(env.tracker.begin(abort.signal));
    if (cause === 'abort') abort.abort();
    if (cause === 'mode') env.settings.homeRefreshPosition = 'preserve';
    if (cause === 'following') env.document.querySelector('[role="tab"]').textContent = 'フォロー中';
    await prepend(env);
    assert.equal(env.scroller.scrollTop, 100);
    assert.equal(env.clock.timers.size, 0);
    assert.equal(env.tracker.job, null);
  }
});

test('an unchanged refresh restores preserve mode and expires without idle polling', async () => {
  const env = setup('preserve');
  const job = env.tracker.begin();
  env.scroller.scrollTop = 0;
  env.tracker.request(job);
  await env.clock.advance(6100);
  assert.equal(env.scroller.scrollTop, 100);
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.tracker.job, null);
});

test('hidden native tab layout is restored even if its click throws', () => {
  const env = setup();
  const header = env.document.getElementById('header');
  const before = header.getAttribute('style');
  env.window.getComputedStyle = element => ({ display: element.style.display || 'flex' });
  const tab = env.document.querySelector('[role="tab"]');
  tab.click = () => {
    assert.equal(header.style.display, 'flex');
    assert.equal(header.style.visibility, 'hidden');
    throw new Error('Native click failed');
  };
  assert.throws(() => env.api.clickWithHeaderLayout(tab), /Native click failed/);
  assert.equal(header.getAttribute('style'), before);
});

test('native banner detection accepts descriptive accessibility labels and skips hidden pills', () => {
  const env = setup();
  const banner = env.document.getElementById('new');
  banner.setAttribute('aria-label', '新しいポストがあります。ピリオドキーを押してください。');
  assert.equal(env.api.isNewPostsButton(banner), true);
  banner.checkVisibility = () => false;
  assert.equal(env.api.isNewPostsButton(banner), false);
});

test('the column control defaults to standard, saves preserve mode, and excludes other feeds', () => {
  const env = setup();
  const changes = [];
  const element = (type, props) => ({ type, props });
  const props = { column: { id: 'home', type: 'home' }, onChange: value => changes.push(value), jsx: { jsx: element, jsxs: element }, t: key => key };
  const tree = env.api.SettingsControl(props);
  const select = tree.props.children.find(node => node.type === 'select');
  assert.equal(select.props.value, 'top');
  select.props.onChange({ currentTarget: { value: 'preserve' } });
  assert.equal(changes[0].homeRefreshPosition, 'preserve');
  assert.equal(env.api.SettingsControl({ ...props, column: { ...props.column, liveFeed: true } }), null);
  assert.equal(env.api.SettingsControl({ ...props, column: { ...props.column, type: 'search' } }), null);
  assert.equal(env.api.getMode({ homeRefreshPosition: 'invalid' }), 'top');
});
