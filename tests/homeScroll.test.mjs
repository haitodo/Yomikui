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

function readingSetup() {
  const env = setup();
  env.document.hidden = false;
  Object.assign(env.scroller, {
    clientHeight: 600, scrollHeight: 2000,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    scrollTo({ top }) { this.scrollTop = top; },
  });
  env.navigate = (direction = 1, mode = 'post', beforeMove) => env.api.navigate({
    getSettings: () => env.settings, getScroller: () => env.scroller, direction, mode, beforeMove,
  });
  env.wheel = (deltaY, deltaMode = 0, beforeMove) => env.api.navigate({
    getSettings: () => env.settings, getScroller: () => env.scroller, mode: 'wheel', deltaY, deltaMode, beforeMove,
  });
  return env;
}

test('reading steps align a post and go back to a partially read post before its predecessor', () => {
  const env = readingSetup();
  assert.equal(env.navigate().status, 'moved');
  assert.equal(env.scroller.scrollTop, 300);
  env.scroller.scrollTop = 350;
  env.navigate(-1);
  assert.equal(env.scroller.scrollTop, 300);
  env.navigate(-1);
  assert.equal(env.scroller.scrollTop, 100);
});

test('reading a tall post uses overlapping screenfuls in both directions', () => {
  const env = readingSetup();
  env.document.querySelector('[data-y="300"]').setAttribute('data-y', '1400');
  env.navigate();
  assert.equal(env.scroller.scrollTop, 580);
  env.navigate();
  assert.equal(env.scroller.scrollTop, 1060);
  env.navigate(-1);
  assert.equal(env.scroller.scrollTop, 580);
  assert.ok(env.scroller.scrollTop > 100);
});

test('page reading uses the visible scroller height, accounts for offsets, and clamps at edges', () => {
  const env = readingSetup();
  env.scroller.getBoundingClientRect = () => ({ top: 50, bottom: 650 });
  env.navigate(1, 'page');
  assert.equal(env.scroller.scrollTop, 540, '550 visible pixels advance by 80%');
  env.scroller.scrollTop = 1390;
  env.navigate(1, 'page');
  assert.equal(env.scroller.scrollTop, 1400);
  assert.equal(env.navigate(1, 'page').status, 'edge');
  env.scroller.scrollTop = 10;
  env.navigate(-1, 'page');
  assert.equal(env.scroller.scrollTop, 0);
});

test('wheel input keeps fractional pixel amounts, applies immediately, and clamps at the ends', () => {
  const env = readingSetup();
  const moves = [];
  env.scroller.scrollTo = options => { moves.push({ ...options }); env.scroller.scrollTop = options.top; };
  assert.equal(env.wheel(.25).status, 'moved');
  assert.equal(env.scroller.scrollTop, 100.25);
  env.wheel(120);
  assert.equal(env.scroller.scrollTop, 220.25);
  env.wheel(-45.5);
  assert.equal(env.scroller.scrollTop, 174.75);
  env.wheel(10000);
  assert.equal(env.scroller.scrollTop, 1400);
  assert.equal(env.wheel(20).status, 'edge');
  env.wheel(-10000);
  assert.equal(env.scroller.scrollTop, 0);
  assert.ok(moves.every(move => move.behavior === 'instant'));
});

test('wheel line and page units use the target column line height and visible viewport', () => {
  const env = readingSetup();
  env.window.getComputedStyle = () => ({ lineHeight: '20px' });
  env.wheel(3, 1);
  assert.equal(env.scroller.scrollTop, 160);
  env.scroller.getBoundingClientRect = () => ({ top: 50, bottom: 650 });
  env.wheel(1, 2);
  assert.equal(env.scroller.scrollTop, 710, 'one page is the 550px visible area');
  env.window.getComputedStyle = () => ({ lineHeight: 'normal' });
  env.wheel(-2, 1);
  assert.equal(env.scroller.scrollTop, 678);
  for (const deltaY of [0, NaN, Infinity, '20']) assert.equal(env.wheel(deltaY).status, 'skipped');
  assert.equal(env.wheel(20, 3).status, 'skipped');
  assert.equal(env.scroller.scrollTop, 678);
});

test('returning to the top after reading jumps directly without clicking X controls', () => {
  const env = readingSetup();
  env.navigate();
  env.navigate();
  assert.ok(env.scroller.scrollTop > 300);
  const moves = [];
  env.scroller.scrollTo = options => { moves.push({ ...options }); env.scroller.scrollTop = options.top; };
  let clicks = 0, cancelled = 0;
  env.document.addEventListener('click', () => clicks++);
  const toTop = () => env.api.navigate({
    getSettings: () => env.settings, getScroller: () => env.scroller, mode: 'top', beforeMove: () => cancelled++,
  });
  assert.equal(toTop().status, 'moved');
  assert.equal(env.scroller.scrollTop, 0);
  assert.deepEqual(moves, [{ top: 0, behavior: 'instant' }]);
  assert.equal(toTop().status, 'edge');
  assert.deepEqual(moves.at(-1), { top: 0, behavior: 'instant' });
  assert.equal(cancelled, 2, 'remaining refresh correction is cancelled even at the top');
  assert.equal(clicks, 0);
});

test('returning to the top cancels a smooth step before its first frame is painted', () => {
  const env = readingSetup();
  env.scroller.scrollTop = 0;
  let pending = null;
  env.scroller.scrollTo = ({ top, behavior }) => {
    if (behavior === 'smooth') pending = () => { env.scroller.scrollTop = top; };
    else { pending = null; env.scroller.scrollTop = top; }
  };
  assert.equal(env.navigate().status, 'moved');
  assert.equal(env.scroller.scrollTop, 0);
  assert.equal(typeof pending, 'function');
  assert.equal(env.navigate(-1, 'top').status, 'edge');
  assert.equal(pending, null);
  assert.equal(env.scroller.scrollTop, 0);
});

test('reading remains available on Following and does not click any X controls', () => {
  const env = readingSetup();
  env.settings.columnType = 'following';
  env.document.querySelector('[role="tab"]').textContent = 'フォロー中';
  let clicks = 0;
  env.document.addEventListener('click', () => clicks++);
  let cancelled = 0;
  assert.equal(env.navigate(1, 'post', () => cancelled++).status, 'moved');
  assert.equal(cancelled, 1);
  assert.equal(clicks, 0);
});

test('reading skips unavailable, modal, composing and non-native pages without moving', () => {
  const variants = [
    env => { env.document.hidden = true; },
    env => { env.document.body.innerHTML += '<div role="dialog"></div>'; },
    env => { env.document.body.innerHTML += '<div data-testid="tweetTextarea_0" contenteditable="true">draft</div>'; },
    env => { env.document.body.innerHTML += '<div data-testid="attachments"><img></div>'; },
    env => { env.settings.isLiveFeedColumn = true; },
    env => { env.settings.isTimelineColumn = true; },
    env => { env.window.location.pathname = '/someone/status/123'; },
    env => { env.document.querySelector('[data-testid="primaryColumn"]').innerHTML = ''; },
  ];
  for (const mode of ['post', 'top', 'wheel']) for (const change of variants) {
    const env = readingSetup();
    change(env);
    assert.equal((mode === 'wheel' ? env.wheel(120) : env.navigate(1, mode)).status, 'skipped');
    assert.equal(env.scroller.scrollTop, 100);
  }
});

test('virtualized lists with no preceding rendered anchor scroll back one screenful', () => {
  const env = readingSetup();
  env.scroller.scrollTop = 1000;
  env.document.querySelector('[data-y="100"]').setAttribute('data-y', '1300');
  env.document.querySelector('[data-y="300"]').setAttribute('data-y', '1500');
  env.navigate(-1);
  assert.equal(env.scroller.scrollTop, 520);
});

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
