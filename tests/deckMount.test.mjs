import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Events } from './helpers.mjs';

test('Dve sets initial isIntersecting to false and mounts only when visible or keepMounted', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  assert.match(deck, /\[Le,Ue\]=\(0,nt\.useState\)\(!1\),\[gt,\$\]=\(0,nt\.useState\)\(!1\)/);
  assert.match(deck, /Ge=Le\|\|a/);
});

test('Dve autoReload timer stops when offscreen or document is hidden', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  assert.match(deck, /if\(!e\.autoReload\|\|e\.liveFeed\|\|!Le\)return;/);
  assert.match(deck, /document\.addEventListener\("visibilitychange",sn\)/);
  // Reload execution effect also guards against offscreen (!Le) and pauses when hidden
  assert.match(deck, /document\.addEventListener\("visibilitychange",_vc\)/);
});

test('gY stubbed notification poller is silenced in contentDeck.js', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  assert.match(deck, /function gY\(e\)\{\}/);
});

test('hY keepMounted (ep) only retains columns that were actually seen, ignoring never-seen offscreen columns', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  const start = deck.indexOf('hY=()=>');
  const end = deck.indexOf(';var Wee=', start);
  assert.ok(start > 0 && end > start);

  // Extract af and ep from hY
  const afStart = deck.indexOf('af=(0,Ke.useCallback)', start);
  const OiStart = deck.indexOf('Oi=(0,Ke.useCallback)', afStart);
  assert.ok(afStart > start && OiStart > afStart);

  let snippet = deck.slice(afStart, OiStart).trim();
  if (snippet.endsWith(',')) snippet = snippet.slice(0, -1);

  // Run in a VM with simulated React hooks
  const context = {
    Ke: {
      useCallback: fn => fn,
      useMemo: fn => fn,
    },
    t: [
      { id: 'col1', type: 'home' },
      { id: 'col2', type: 'notifications' },
      { id: 'col3', type: 'search' },
      { id: 'col4', type: 'list' },
    ],
    T0e: 2,
    Pe: { current: {} },
    V: { current: {} },
    na: {},
    N: {},
    yn: val => { context.na = val; },
    G: val => { context.N = val; },
  };

  vm.runInNewContext('var ' + snippet + ';', context);
  const { af, ep: getEp } = context;

  // Initial state: 4 columns, none have been reported yet
  assert.deepEqual(Array.from(getEp()), []);

  // Scenario 1: col3 and col4 report initial false (offscreen at startup)
  af('col3', false);
  af('col4', false);
  // Pe.current should record false
  assert.equal(context.Pe.current['col3'], false);
  assert.equal(context.Pe.current['col4'], false);
  // But V.current (lastSeenAt) must NOT be recorded for never-seen columns!
  assert.equal(context.V.current['col3'], undefined);
  assert.equal(context.V.current['col4'], undefined);
  // keepMounted set must be empty (neither col3 nor col4 is kept mounted)
  assert.deepEqual(Array.from(getEp()), []);

  // Scenario 2: col1 reports true (onscreen at startup)
  af('col1', true);
  assert.equal(context.Pe.current['col1'], true);
  assert.ok(context.V.current['col1'] > 0);
  // col1 is currently visible (na.col1 === true), so ep does not include it
  assert.deepEqual(Array.from(getEp()), []);

  // Scenario 3: col1 scrolls offscreen (now reports false)
  const timeSeen1 = context.V.current['col1'];
  af('col1', false);
  assert.equal(context.Pe.current['col1'], false);
  // Now col1 was previously visible and is now offscreen -> it should be in keepMounted!
  assert.ok(context.V.current['col1'] >= timeSeen1);
  assert.deepEqual(Array.from(getEp()), ['col1']);

  // Scenario 4: col2 becomes visible, then goes offscreen
  af('col2', true);
  af('col2', false);
  // Both col1 and col2 were seen and are now offscreen -> both kept mounted
  const epResult = Array.from(getEp());
  assert.ok(epResult.includes('col1'));
  assert.ok(epResult.includes('col2'));
  assert.equal(epResult.length, 2);
  // col3 and col4 are still never-seen and must NOT be kept mounted!
  assert.equal(epResult.includes('col3'), false);
  assert.equal(epResult.includes('col4'), false);
});

test('contentIframe Wb avoids duplicate script tag injection', () => {
  const iframe = readFileSync('contentIframe.js', 'utf8');
  assert.doesNotMatch(iframe, /chrome\.runtime\.getURL\("mediaInterceptor\.js"\)/);
});

test('rememberLastPage ZH uses event-driven navigation and eliminates periodic 800ms setInterval', () => {
  const iframe = readFileSync('contentIframe.js', 'utf8');
  assert.ok(iframe.includes('_zHNav'));
  assert.ok(iframe.includes('"currententrychange"'));
  assert.ok(iframe.includes('"popstate"'));
  assert.ok(iframe.includes('"hashchange"'));
  assert.doesNotMatch(iframe, /_h=setInterval\(\(\)=>\{!i1\|\|!kh\|\|qH\(kh\)\},eJ\)/);
});

test('manifest.json restricts contentDeck content script matches to yomikui routes', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const deckScript = manifest.content_scripts.find(s => s.js?.includes('contentDeck.js'));
  assert.ok(deckScript);
  assert.deepEqual(deckScript.matches, [
    'https://twitter.com/yomikui*',
    'https://*.twitter.com/yomikui*',
    'https://x.com/yomikui*',
    'https://*.x.com/yomikui*'
  ]);
});

test('tweetActions restricts characterData observation to retweet targets and prunes irrelevant response subtrees', () => {
  const code = readFileSync('tweetActions.js', 'utf8');
  assert.ok(code.includes('[data-testid="retweet"], [data-testid="unretweet"]'));
  assert.ok(code.includes("IGNORED_RESPONSE_KEYS = new Set(['user_results', 'feedbackInfo'"));
});

test('homeScroll ReadingContext skips irrelevant characterData mutations outside tablist', () => {
  const code = readFileSync('homeScroll.js', 'utf8');
  assert.match(code, /if \(record\.type === 'characterData'\) \{/);
  assert.match(code, /return !!target\?\.closest\('\[role="tab"\], \[role="tablist"\]'\);/);
});

test('frameMaintenance cleanup early-exits when no Yomikui DOM elements exist', () => {
  const code = readFileSync('frameMaintenance.js', 'utf8');
  assert.match(code, /if \(!document\.querySelector\(DUPLICATE_SELECTOR\)\) return;/);
});

test('contentIframe zH batches article discoveries and disconnects when frame is hidden', () => {
  const code = readFileSync('contentIframe.js', 'utf8');
  assert.ok(code.includes('_zHPending'));
  assert.ok(code.includes('_zHSchedule'));
  assert.match(code, /if\(!Xe\(\)\|\|document\.hidden\)\{t7&&\(t7\.disconnect\(\),t7=null\)/);
});

test('sidebar active workspace icon has refined active styling without distracting indicator pill', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  // Check active workspace button class in quick access (DW)
  assert.match(deck, /rd-sidebar-workspace-btn--active/);
  assert.match(deck, /border-primary\/40/);
  // Check active icon color passing
  assert.match(deck, /iconClassName:i\?"shrink-0 text-primary":"shrink-0 text-muted-foreground"/);
  // Check CSS rule exists with refined border and no ::before pill
  assert.match(deck, /#yomikui-root \.rd-sidebar-workspace-btn--active\s*\{/);
  assert.doesNotMatch(deck, /#yomikui-root \.rd-sidebar-workspace-btn--active::before/);
  assert.match(deck, /border:\s*1px solid/);
});

test('replacing the frame load listener leaves the live iframe and its window registration intact', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  const loadListener = deck.indexOf('Te.addEventListener("load",De)');
  const start = deck.lastIndexOf('(0,nt.useEffect)', loadListener);
  const end = deck.indexOf(',(0,nt.useEffect)', loadListener);
  const frame = new Events();
  frame.src = 'https://x.com/home';
  const register = () => assert.fail('Listener cleanup must not clear the frame registration');
  vm.runInNewContext(deck.slice(start, end), {
    nt: { useEffect: effect => effect()() },
    Pt: { current: frame }, e: { id: 'home' },
    i: register, kt: 0, Ge: true, Ot() {}, Eo() {},
  });
  assert.equal(frame.src, 'https://x.com/home');
  assert.equal(frame.listeners.get('load').length, 0);
  assert.match(deck, /\(\)=>i\?\.\(e\.id,null\)\),\[e\.id,i,kt,Ge,Ot\]/);
  assert.match(deck, /Ne\.current=\{\},Fe\.current=\{\},Eo\(\),syncColumnVisibility\(\);return/);
});

test('offscreen columns pause existing and newly started videos, then resume only prior playback', () => {
  const iframe = readFileSync('contentIframe.js', 'utf8');
  class Video {
    constructor(paused) { this.paused = paused; }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const playing = new Video(false);
  const idle = new Video(true);
  const addedWhileHidden = new Video(true);
  const document = new Events();
  const videos = [playing, idle];
  document.querySelectorAll = () => videos;
  const context = { document, HTMLVideoElement: Video, window: new Events(), CustomEvent };
  const start = iframe.indexOf('var $2=!0;');
  const end = iframe.indexOf('function Xe()', start);
  vm.runInNewContext(iframe.slice(start, end), context);

  context.G1(false);
  assert.equal(playing.paused, true);
  videos.push(addedWhileHidden);
  addedWhileHidden.play();
  document.emit('play', { target: addedWhileHidden });
  assert.equal(addedWhileHidden.paused, true);

  context.G1(true);
  assert.equal(playing.paused, false);
  assert.equal(idle.paused, true);
  assert.equal(addedWhileHidden.paused, true);
  assert.equal(document.listeners.get('play').length, 0);
});

test('contentIframe applies content-visibility: auto to timeline tweet cellInnerDiv elements', () => {
  const iframe = readFileSync('contentIframe.js', 'utf8');
  assert.match(iframe, /\[data-testid="cellInnerDiv"\]\s*\{\s*content-visibility:\s*auto;/);
  assert.match(iframe, /contain-intrinsic-size:\s*auto\s*150px;/);
});

test('history pauses both timers and catches up once when its column becomes visible', async () => {
  const iframe = readFileSync('contentIframe.js', 'utf8');
  const helperStart = iframe.indexOf('function watchHistoryWhileVisible(');
  const helperEnd = iframe.indexOf('var xJ=', helperStart);
  const effectStart = iframe.indexOf('(0,We.useEffect)(() => watchHistoryWhileVisible(');
  const effectEnd = iframe.indexOf(';let J=(0,We.useCallback)', effectStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && effectStart >= 0 && effectEnd > effectStart);

  const window = new Events();
  const document = new Events();
  document.hidden = false;
  const timers = new Map();
  let nextTimer = 0;
  let visible = true;
  let cleanup;
  let reads = 0;
  let historyFetches = 0;
  let labelUpdates = 0;
  let finishRead;
  const firstRead = new Promise(resolve => { finishRead = resolve; });
  vm.runInNewContext(`${iframe.slice(helperStart, helperEnd)}\n${iframe.slice(effectStart, effectEnd)}`, {
    window, document, Xe: () => visible, fJ: 15000,
    setInterval(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearInterval: id => timers.delete(id),
    We: { useEffect: effect => { cleanup = effect(); } },
    AD: () => ++reads === 1 ? firstRead : Promise.resolve(0),
    $D: async () => { historyFetches++; return []; },
    k: { current: 0 },
    S: () => { labelUpdates++; },
  });
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [15000, 60000]);
  const { callback: poll } = timers.values().next().value;
  const pending = poll();
  await poll();
  assert.equal(reads, 1);

  visible = false;
  window.emit('yomikui-frame-column-visibility');
  assert.equal(timers.size, 0);
  finishRead(1);
  await pending;
  assert.equal(historyFetches, 0);

  visible = true;
  window.emit('yomikui-frame-column-visibility');
  document.emit('visibilitychange');
  assert.equal(reads, 2);
  assert.equal(labelUpdates, 1);
  assert.equal(timers.size, 2);
  document.hidden = true;
  document.emit('visibilitychange');
  assert.equal(timers.size, 0);
  cleanup();
  document.hidden = false;
  document.emit('visibilitychange');
  window.emit('yomikui-frame-column-visibility');
  assert.equal(timers.size, 0);
});

test('sidebar sleep setting supports switch toggle and reveals minute input only when active', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  const messages = JSON.parse(readFileSync('_locales/ja/messages.json', 'utf8'));

  // Translation definition exists
  assert.ok(messages.sidebar_sleep_wait_time);
  assert.equal(messages.sidebar_sleep_wait_time.message, '待機時間');
  assert.match(deck, /"sidebar_sleep_wait_time":\{"message":"待機時間"\}/);

  // Switch toggle is rendered for sleep_when_inactive
  assert.match(deck, /V\("sidebar_sleep_when_inactive"\)\}\),\(0,ee\.jsx\)\(ga,\{checked:sleepEnabled/);

  // Minutes input is conditionally rendered when sleepEnabled is true
  assert.match(deck, /sleepEnabled&&\(0,ee\.jsxs\)\("div",\{className:"flex items-center justify-between gap-4",children:\[\(0,ee\.jsx\)\("span",\{className:"text-sm text-muted-foreground",children:V\("sidebar_sleep_wait_time"\)/);

  // Input min is 1, not 0
  assert.match(deck, /type:"number",min:1,max:60,value:dt/);

  // Obsolete "0 = 無効" is removed from sidebar settings UI
  assert.doesNotMatch(deck, /V\("sidebar_zero_disabled"\)/);

  // Logic test for saving: false sets 0, true sets clamped [1, 60]
  const feStart = deck.indexOf('Fe=(0,ln.useCallback)');
  const feEnd = deck.indexOf('),it=(0,ln.useCallback)', feStart);
  assert.ok(feStart > 0 && feEnd > feStart);
  const snippet = deck.slice(feStart, feEnd + 1).trim();

  let savedValue = null;
  const mockSetInactivityTimeout = (val) => { savedValue = val; };

  // Case 1: sleepEnabled = false
  {
    const ctx = {
      ln: { useCallback: (fn) => fn },
      sleepEnabled: false,
      dt: '10',
      h: mockSetInactivityTimeout,
      Dt: () => {},
    };
    vm.runInNewContext('var ' + snippet + ';', ctx);
    ctx.Fe();
    assert.equal(savedValue, 0);
  }

  // Case 2: sleepEnabled = true, dt = 15
  {
    const ctx = {
      ln: { useCallback: (fn) => fn },
      sleepEnabled: true,
      dt: '15',
      h: mockSetInactivityTimeout,
      Dt: () => {},
    };
    vm.runInNewContext('var ' + snippet + ';', ctx);
    ctx.Fe();
    assert.equal(savedValue, 15);
  }

  // Case 3: sleepEnabled = true, dt <= 0 clamps to minimum 1
  {
    const ctx = {
      ln: { useCallback: (fn) => fn },
      sleepEnabled: true,
      dt: '0',
      h: mockSetInactivityTimeout,
      Dt: () => {},
    };
    vm.runInNewContext('var ' + snippet + ';', ctx);
    ctx.Fe();
    assert.equal(savedValue, 1);
  }

  // Case 4: sleepEnabled = true, dt > 60 clamps to maximum 60
  {
    const ctx = {
      ln: { useCallback: (fn) => fn },
      sleepEnabled: true,
      dt: '99',
      h: mockSetInactivityTimeout,
      Dt: () => {},
    };
    vm.runInNewContext('var ' + snippet + ';', ctx);
    ctx.Fe();
    assert.equal(savedValue, 60);
  }
});

test('contentDeck.js parses as valid JavaScript without syntax errors', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  assert.doesNotThrow(() => {
    new vm.Script(deck, { filename: 'contentDeck.js' });
  });
});

test('sidebar renders dedicated account button and shows current account preview and quick switch', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');

  // Account button element exists in sidebar
  assert.match(deck, /rd-sidebar-account-btn/);

  // Checks that clicking account button calls onSwitchAccount
  assert.match(deck, /onClick:\(\)=>\{at\|\|t\?\.\(\)\}/);

  // Avatar rendering with ring-primary and fallback to user icon
  assert.match(deck, /src:ac\.avatarUrl/);
  assert.match(deck, /ring-primary\/40/);

  // Settings modal displays current account preview
  assert.match(deck, /ac\?\.screenName&&\(0,ee\.jsxs\)\("div",\{className:"flex items-center gap-2\.5 rounded-lg border border-border\/60/);

  // Account storage clearance on switch selected
  assert.match(deck, /globalThis\.YomikuiColumnNavigation\?\.clearStoredAccount\?\.\(\)/);

  // CSS rule for account button hover exists
  assert.match(deck, /#yomikui-root \.rd-sidebar-account-btn:hover\s*\{/);
});


