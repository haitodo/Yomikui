import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('Dve sets initial isIntersecting to false and mounts only when visible or keepMounted', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  assert.match(deck, /\[Le,Ue\]=\(0,nt\.useState\)\(!1\),\[gt,\$\]=\(0,nt\.useState\)\(!1\)/);
  assert.match(deck, /Ge=Le\|\|a/);
});

test('Dve autoReload timer stops when offscreen or document is hidden', () => {
  const deck = readFileSync('contentDeck.js', 'utf8');
  assert.match(deck, /if\(!e\.autoReload\|\|e\.liveFeed\|\|!Le\)return;/);
  assert.match(deck, /document\.addEventListener\("visibilitychange",sn\)/);
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


