import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Clock, Events } from './helpers.mjs';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const source = readFileSync(new URL('../searchFilters.js', import.meta.url), 'utf8');
const deckSource = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const jaMessages = JSON.parse(readFileSync(new URL('../_locales/ja/messages.json', import.meta.url), 'utf8'));

function setup(options = {}) {
  const clock = new Clock();
  clock.now = Date.UTC(2026, 10, 13, 7, 0, 0);
  const saved = {};
  if ('initialPresets' in options) {
    saved.yomikui_search_filter_presets_v1 = clone(options.initialPresets);
  }
  const win = options.window ?? null;
  const doc = options.document ?? null;
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: clone(saved[key]) }; },
        async set(patch) { Object.assign(saved, clone(patch)); },
      },
    },
    i18n: {
      getMessage(key) { return jaMessages[key]?.message ?? ''; },
    },
  };
  const context = vm.createContext({
    ...clock.globals(),
    URL,
    URLSearchParams,
    crypto: { randomUUID },
    chrome,
    ...(win ? { window: win } : {}),
    ...(doc ? { document: doc } : {}),
    ...(options.tweetRouting ? { YomikuiTweetRouting: options.tweetRouting } : {}),
    ...(options.columnNavigation ? { YomikuiColumnNavigation: options.columnNavigation } : {}),
  });
  vm.runInContext(source, context);
  return { api: context.YomikuiSearchFilters, saved, clock, context };
}

function makeJsx() {
  const jsx = (type, props, key) => ({ type, props: { ...props, ...(key !== undefined ? { key } : {}) } });
  return { jsx, jsxs: jsx, Fragment: 'Fragment' };
}

function flattenNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenNodes(item, out);
    return out;
  }
  out.push(node);
  if (node.props?.children !== undefined) flattenNodes(node.props.children, out);
  return out;
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'object') return textContent(node.props?.children);
  return '';
}

test('parseSearchQuery and buildSearchQuery preserve phrases, groups, and unmanaged operators', () => {
  const { api, clock } = setup();
  const query = '("AI agent" OR LLM) -spam from:jack filter:images -filter:retweets -filter:replies lang:ja min_faves:100 min_retweets:20 since:' + api.formatDaysAgo(7, clock.now);
  const parsed = api.parseSearchQuery(query, clock.now);

  assert.equal(parsed.baseText, '("AI agent" OR LLM) -spam from:jack');
  assert.deepEqual(clone(parsed.filters), {
    media: 'images',
    excludeRetweets: true,
    excludeReplies: true,
    excludeLinks: false,
    langJa: true,
    minFaves: 100,
    minRetweets: 20,
    sinceDays: 7,
    sinceDate: null,
    untilDate: null,
  });
  assert.equal(api.countActiveFilters(parsed.filters), 7);

  const rebuilt = api.buildSearchQuery(parsed.baseText, parsed.filters, clock.now);
  assert.equal(
    rebuilt,
    `("AI agent" OR LLM) -spam from:jack filter:images -filter:retweets -filter:replies lang:ja min_faves:100 min_retweets:20 since:${api.formatDaysAgo(7, clock.now)}`,
  );
});

test('parseSearchQuery preserves custom fixed since dates and parseSearchUrl validates search routes', () => {
  const { api, clock } = setup();
  const parsed = api.parseSearchQuery('cats since:2025-01-15 -filter:links', clock.now);
  assert.equal(parsed.baseText, 'cats');
  assert.equal(parsed.filters.sinceDays, null);
  assert.equal(parsed.filters.sinceDate, '2025-01-15');
  assert.equal(parsed.filters.excludeLinks, true);

  assert.deepEqual(clone(api.parseSearchUrl('/search?q=hello&f=live')), { q: 'hello', tab: 'live' });
  assert.deepEqual(clone(api.parseSearchUrl('https://x.com/search?q=filter%3Afollows')), { q: 'filter:follows', tab: 'top' });
  assert.equal(api.parseSearchUrl('/home'), null);
  assert.equal(api.parseSearchUrl('/search?q=yomikui-timeline'), null);
  assert.equal(api.parseSearchUrl('https://example.com/search?q=test'), null);

  assert.equal(api.buildSearchPath('cats', { media: 'videos', excludeRetweets: true }, 'top', clock.now), '/search?q=cats+filter%3Avideos+-filter%3Aretweets');
  assert.equal(api.buildSearchPath('cats', {}, 'live', clock.now), '/search?q=cats&f=live');
  assert.equal(api.buildSearchPath('', {}, 'top', clock.now), '/search');
});

test('period helpers compute day/week/month/year bounds, step backwards/forwards, and keep bounded ranges distinct from recency chips', () => {
  const { api, clock } = setup();
  // 2026-11-13 (Friday)
  const monthNow = api.shiftPeriodRange('month', null, null, 0, clock.now);
  assert.deepEqual(clone(monthNow), {
    startYmd: '2026-11-01',
    endYmd: '2026-11-30',
    sinceDate: '2026-11-01',
    untilDate: '2026-12-01',
  });
  assert.equal(api.detectPeriodUnit(monthNow.sinceDate, monthNow.untilDate), 'month');
  assert.equal(api.formatPeriodLabel(monthNow), '2026年11月');

  const prevMonth = api.shiftPeriodRange('month', monthNow.sinceDate, monthNow.untilDate, -1, clock.now);
  assert.deepEqual(clone(prevMonth), {
    startYmd: '2026-10-01',
    endYmd: '2026-10-31',
    sinceDate: '2026-10-01',
    untilDate: '2026-11-01',
  });
  const nextMonth = api.shiftPeriodRange('month', prevMonth.sinceDate, prevMonth.untilDate, 1, clock.now);
  assert.deepEqual(clone(nextMonth), clone(monthNow));

  // Month rollover across Jan -> Dec and Feb leap/non-leap clamping
  const jan = api.getPeriodBounds('month', '2026-01-31');
  const dec = api.shiftPeriodRange('month', jan.sinceDate, jan.untilDate, -1, clock.now);
  assert.equal(dec.sinceDate, '2025-12-01');
  assert.equal(dec.untilDate, '2026-01-01');
  assert.equal(api.addMonthsYmd('2024-01-31', 1), '2024-02-29');
  assert.equal(api.addMonthsYmd('2026-01-31', 1), '2026-02-28');

  // Week (Monday 2026-11-09 .. Sunday 2026-11-15 -> until 2026-11-16)
  const thisWeek = api.shiftPeriodRange('week', null, null, 0, clock.now);
  assert.equal(thisWeek.startYmd, '2026-11-09');
  assert.equal(thisWeek.endYmd, '2026-11-15');
  assert.equal(thisWeek.untilDate, '2026-11-16');
  assert.equal(api.detectPeriodUnit(thisWeek.sinceDate, thisWeek.untilDate), 'week');
  assert.equal(api.formatPeriodLabel(thisWeek), '11/09週');
  const prevWeek = api.shiftPeriodRange('week', thisWeek.sinceDate, thisWeek.untilDate, -1, clock.now);
  assert.equal(prevWeek.sinceDate, '2026-11-02');
  assert.equal(prevWeek.untilDate, '2026-11-09');

  // Year
  const thisYear = api.shiftPeriodRange('year', null, null, 0, clock.now);
  assert.equal(thisYear.sinceDate, '2026-01-01');
  assert.equal(thisYear.untilDate, '2027-01-01');
  assert.equal(api.detectPeriodUnit(thisYear.sinceDate, thisYear.untilDate), 'year');
  assert.equal(api.formatPeriodLabel(thisYear), '2026年');
  const prevYear = api.shiftPeriodRange('year', thisYear.sinceDate, thisYear.untilDate, -1, clock.now);
  assert.equal(prevYear.sinceDate, '2025-01-01');
  assert.equal(prevYear.untilDate, '2026-01-01');

  // Bounded 1-day range for yesterday must NOT collapse into sinceDays: 1 (24時間)
  const yesterday = api.shiftPeriodRange('day', null, null, -1, clock.now);
  assert.equal(api.detectPeriodUnit(yesterday.sinceDate, yesterday.untilDate), 'day');
  const query = api.buildSearchQuery('cats', { sinceDate: yesterday.sinceDate, untilDate: yesterday.untilDate }, clock.now);
  const parsed = api.parseSearchQuery(query, clock.now);
  assert.equal(parsed.filters.sinceDays, null);
  assert.equal(parsed.filters.sinceDate, yesterday.sinceDate);
  assert.equal(parsed.filters.untilDate, yesterday.untilDate);
});

test('presets initialize with starters, preserve empty array after deletion, and serialize concurrent updates', async () => {
  const { api, saved, clock } = setup();
  const initial = await api.loadPresets();
  assert.equal(initial.length, 3);
  assert.equal(initial[0].name, '画像・高評価');

  const events = [];
  const unsubscribe = api.subscribePresets(items => events.push(items.length));

  const p1 = api.addPreset({ name: 'イラスト保存', filters: { media: 'images', minFaves: 500 }, tab: 'top' });
  const p2 = api.addPreset({ name: '動画メモ', filters: { media: 'videos', excludeRetweets: true }, tab: 'live' });
  await Promise.all([p1, p2]);

  const afterAdd = await api.loadPresets();
  assert.equal(afterAdd.length, 5);
  assert.ok(afterAdd.some(p => p.name === 'イラスト保存'));
  assert.ok(afterAdd.some(p => p.name === '動画メモ'));
  assert.ok(events.length >= 2);

  for (const item of afterAdd) {
    await api.deletePreset(item.id);
  }
  assert.deepEqual(clone(saved[api.PRESETS_STORAGE_KEY]), []);
  assert.deepEqual(clone(await api.loadPresets()), []);

  unsubscribe();

  const appliedFilterOnly = api.applyPresetToUrl('/search?q=yomikui+filter%3Avideos&f=top', {
    name: '7日以内',
    filters: { excludeRetweets: true, sinceDays: 7 },
    tab: 'live',
    includeQuery: false,
    query: '',
  }, clock.now);
  assert.equal(
    appliedFilterOnly,
    `/search?q=yomikui+-filter%3Aretweets+since%3A${api.formatDaysAgo(7, clock.now)}&f=live`,
  );

  const appliedWithQuery = api.applyPresetToUrl('/search?q=old&f=live', {
    name: '固定検索',
    filters: { langJa: true },
    tab: null,
    includeQuery: true,
    query: 'TypeScript',
  }, clock.now);
  assert.equal(appliedWithQuery, '/search?q=TypeScript+lang%3Aja&f=live');
});

test('FilterButton and FilterPanel render controls, toggle filters, and manage presets', async () => {
  const { api } = setup();
  const jsx = makeJsx();
  const Button = (props) => ({ type: 'Button', props });
  const navigated = [];
  const added = [];
  const deleted = [];
  let open = false;

  const baseState = {
    open,
    setOpen: (val) => { open = typeof val === 'function' ? val(open) : val; },
    toggleOpen: () => { open = !open; },
    isSearchPage: true,
    isLiveFeed: false,
    currentUrl: '/search?q=rust+filter%3Aimages+-filter%3Aretweets&f=live',
    tab: 'live',
    baseText: 'rust',
    filters: api.parseSearchQuery('rust filter:images -filter:retweets').filters,
    activeCount: 2,
    presets: api.DEFAULT_PRESETS,
    navigateSearch: (path) => navigated.push(path),
    addPreset: async (item) => added.push(item),
    deletePreset: async (id) => deleted.push(id),
  };

  assert.equal(api.FilterButton({ searchState: { ...baseState, isSearchPage: false }, Button, jsx }), null);
  assert.equal(api.FilterButton({ searchState: { ...baseState, isLiveFeed: true }, Button, jsx }), null);

  const btnTree = api.FilterButton({ searchState: baseState, Button, jsx });
  const btnNodes = flattenNodes(btnTree);
  assert.equal(btnTree.props['aria-expanded'], false);
  assert.equal(textContent(btnNodes.find(n => String(n.props?.className).includes('rd-search-filter-badge'))), '2');
  btnTree.props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(open, true);

  let panelHooks = [false, '', false, true, 'rust', '', ''];
  let hookIdx = 0;
  const useState = (init) => {
    const idx = hookIdx++;
    if (!(idx in panelHooks)) panelHooks[idx] = typeof init === 'function' ? init() : init;
    return [panelHooks[idx], val => { panelHooks[idx] = typeof val === 'function' ? val(panelHooks[idx]) : val; }];
  };
  const renderPanel = (statePatch = {}) => {
    hookIdx = 0;
    return api.FilterPanel({
      searchState: { ...baseState, open: true, ...statePatch },
      jsx,
      useState,
      useEffect: () => {},
    });
  };

  const panel = renderPanel();
  const nodes = flattenNodes(panel);
  const buttons = nodes.filter(n => n.type === 'button');
  const findBtn = label => buttons.find(b => textContent(b).trim() === label);

  // Toggle language filter on
  findBtn('日本語').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust+filter%3Aimages+-filter%3Aretweets+lang%3Aja&f=live');

  // Toggle media filter off (images already pressed)
  assert.equal(findBtn('画像').props['aria-pressed'], true);
  findBtn('画像').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust+-filter%3Aretweets&f=live');

  // Click min_faves 100+
  findBtn('100+').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust+filter%3Aimages+-filter%3Aretweets+min_faves%3A100&f=live');

  // Switch tab to media
  findBtn('メディア').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust+filter%3Aimages+-filter%3Aretweets&f=media');

  // Clear all filters while keeping baseText
  findBtn('解除').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust&f=live');

  // Click preset chip
  findBtn('一次情報・最新').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust+-filter%3Aretweets+-filter%3Areplies+lang%3Aja&f=live');

  // Delete preset chip
  const deleteBtn = buttons.find(b => b.props['aria-label'] === '動画のみ を削除');
  deleteBtn.props.onClick({ stopPropagation() {} });
  assert.deepEqual(deleted, ['starter-videos']);

  // Open save preset form and submit
  findBtn('+ 保存').props.onClick();
  const panelWithForm = renderPanel();
  const form = flattenNodes(panelWithForm).find(n => n.type === 'form');
  assert.ok(form);
  const nameInput = flattenNodes(form).find(n => n.type === 'input' && n.props.type === 'text');
  nameInput.props.onChange({ currentTarget: { value: 'テストプリセット' } });
  const updatedForm = flattenNodes(renderPanel()).find(n => n.type === 'form');
  await updatedForm.props.onSubmit({ preventDefault() {} });
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'テストプリセット');
  assert.equal(added[0].tab, 'live');

  // Open period selector, step month backwards, switch unit to week, and apply custom date range
  const getButtons = (statePatch = {}) => flattenNodes(renderPanel(statePatch)).filter(n => n.type === 'button');
  const findInPanel = (btns, label) => btns.find(b => textContent(b).trim() === label);

  findInPanel(getButtons(), '📅 期間指定').props.onClick();
  let periodPanel = renderPanel();
  let periodBtns = flattenNodes(periodPanel).filter(n => n.type === 'button');
  // Current month button ("今月")
  findInPanel(periodBtns, '今月').props.onClick();
  const thisMonthQuery = navigated.at(-1);
  assert.ok(thisMonthQuery.includes('since%3A') && thisMonthQuery.includes('until%3A'));

  // Step previous month from that URL
  const monthFilters = api.parseSearchQuery(new URL(thisMonthQuery, 'https://x.com').searchParams.get('q')).filters;
  periodBtns = getButtons({ filters: monthFilters });
  findInPanel(periodBtns, '◀ 前').props.onClick();
  const prevMonthParsed = api.parseSearchQuery(new URL(navigated.at(-1), 'https://x.com').searchParams.get('q')).filters;
  assert.equal(api.detectPeriodUnit(prevMonthParsed.sinceDate, prevMonthParsed.untilDate), 'month');
  assert.notEqual(prevMonthParsed.sinceDate, monthFilters.sinceDate);

  // Switch unit to 週 and step forward ("次 ▶")
  findInPanel(getButtons({ filters: prevMonthParsed }), '週').props.onClick();
  findInPanel(getButtons({ filters: prevMonthParsed }), '次 ▶').props.onClick();
  const nextWeekParsed = api.parseSearchQuery(new URL(navigated.at(-1), 'https://x.com').searchParams.get('q')).filters;
  assert.equal(api.detectPeriodUnit(nextWeekParsed.sinceDate, nextWeekParsed.untilDate), 'week');

  // Enter reversed custom dates (start > end) and apply -> auto-swaps & sets untilDate = end + 1 day
  const dateInputs = flattenNodes(renderPanel()).filter(n => n.type === 'input' && n.props.type === 'date');
  assert.equal(dateInputs.length, 2);
  dateInputs[0].props.onChange({ currentTarget: { value: '2026-05-10' } });
  dateInputs[1].props.onChange({ currentTarget: { value: '2026-05-01' } });
  findInPanel(getButtons(), '適用').props.onClick();
  assert.equal(
    navigated.at(-1),
    '/search?q=rust+filter%3Aimages+-filter%3Aretweets+since%3A2026-05-01+until%3A2026-05-11&f=live',
  );
});

test('FilterPanel renders only slim 1-row period minibar when closed with active period, and opens overlay popover on demand', () => {
  const { api } = setup();
  const jsx = makeJsx();
  const navigated = [];
  let open = false;
  const hooks = [];
  let hookIdx = 0;
  const useState = (init) => {
    const idx = hookIdx++;
    if (!(idx in hooks)) hooks[idx] = typeof init === 'function' ? init() : init;
    return [hooks[idx], val => { hooks[idx] = typeof val === 'function' ? val(hooks[idx]) : val; }];
  };

  const renderWith = (filters, isOpen = open) => {
    hookIdx = 0;
    return api.FilterPanel({
      searchState: {
        open: isOpen,
        setOpen: (val) => { open = typeof val === 'function' ? val(open) : val; },
        toggleOpen: () => { open = !open; },
        isSearchPage: true,
        isLiveFeed: false,
        currentUrl: api.buildSearchPath('rust', filters, 'live'),
        tab: 'live',
        baseText: 'rust',
        filters,
        activeCount: api.countActiveFilters(filters),
        presets: [],
        navigateSearch: (path) => navigated.push(path),
        addPreset: async () => {},
        deletePreset: async () => {},
      },
      jsx,
      useState,
      useEffect: () => {},
    });
  };

  // Closed & no custom period -> renders nothing (0px)
  assert.equal(renderWith(api.normalizeFilters(), false), null);

  // Closed & active month period -> renders ONLY minibar (no overlay panel)
  const novFilters = api.normalizeFilters({ sinceDate: '2026-11-01', untilDate: '2026-12-01' });
  const closedTree = renderWith(novFilters, false);
  const closedNodes = flattenNodes(closedTree);
  assert.ok(closedNodes.some(n => String(n.props?.className).includes('rd-search-period-minibar')));
  assert.equal(closedNodes.some(n => String(n.props?.className).includes('rd-search-filter-panel')), false);

  // Step previous month directly from closed minibar
  const miniBtns = closedNodes.filter(n => n.type === 'button');
  miniBtns.find(b => b.props['aria-label'] === '前の期間').props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust+since%3A2026-10-01+until%3A2026-11-01&f=live');

  // Switch unit to 週 on minibar and jump to 今週
  miniBtns.find(b => textContent(b).trim() === '週').props.onClick();
  const weekTree = renderWith(novFilters, false);
  const weekBtns = flattenNodes(weekTree).filter(n => n.type === 'button');
  assert.ok(weekBtns.some(b => textContent(b).trim() === '今週'));

  // Clicking the period label opens the overlay popover with date box expanded
  weekBtns.find(b => b.props.title === '詳細・日付指定を開く').props.onClick();
  assert.equal(open, true);

  const openTree = renderWith(novFilters, true);
  const openNodes = flattenNodes(openTree);
  assert.ok(openNodes.some(n => String(n.props?.className).includes('rd-search-filter-panel')));
  assert.ok(openNodes.some(n => String(n.props?.className).includes('rd-search-period-box')));
  const backdrop = openNodes.find(n => String(n.props?.className).includes('rd-search-filter-backdrop'));
  assert.ok(backdrop);
  backdrop.props.onClick();
  assert.equal(open, false);

  // Clear period directly from minibar
  const clearBtn = flattenNodes(renderWith(novFilters, false))
    .filter(n => n.type === 'button')
    .find(b => b.props['aria-label'] === '期間を解除');
  clearBtn.props.onClick();
  assert.equal(navigated.at(-1), '/search?q=rust&f=live');
});

test('installFrameSearchBridge reports path changes and handles search navigation messages', () => {
  const win = new Events();
  const doc = new Events();
  doc.readyState = 'complete';
  const posted = [];
  const navigated = [];

  win.location = { pathname: '/search', search: '?q=cats', hash: '#yomikui-cid1', href: 'https://x.com/search?q=cats#yomikui-cid1' };
  win.parent = { postMessage(msg, target) { posted.push({ msg, target }); } };
  win.navigation = new Events();

  const { api } = setup({
    window: win,
    document: doc,
    tweetRouting: { openInPlace(path) { navigated.push(path); } },
  });

  const cleanup = api.installFrameSearchBridge(doc, win);
  assert.equal(posted.length, 1);
  assert.deepEqual(clone(posted[0].msg), { type: 'yomikui-search-location', path: '/search?q=cats' });

  win.location.search = '?q=cats+filter%3Aimages';
  win.navigation.emit('currententrychange');
  assert.equal(posted.length, 2);
  assert.equal(posted[1].msg.path, '/search?q=cats+filter%3Aimages');

  // Untrusted origin is ignored
  win.emit('message', {
    source: win.parent,
    origin: 'https://evil.example',
    data: { type: 'yomikui-search-navigate', path: '/search?q=evil' },
  });
  assert.equal(navigated.length, 0);

  // Trusted parent navigate message works
  win.emit('message', {
    source: win.parent,
    origin: 'https://x.com',
    data: { type: 'yomikui-search-navigate', path: '/search?q=cats+lang%3Aja&f=live' },
  });
  assert.deepEqual(navigated, ['/search?q=cats+lang%3Aja&f=live']);

  cleanup();
});

test('manifest, locales, and contentDeck wire searchFilters cleanly', () => {
  const deckEntry = manifest.content_scripts.find(entry => entry.js?.includes('contentDeck.js'));
  const frameEntry = manifest.content_scripts.find(entry => entry.js?.includes('contentIframe.js'));
  assert.ok(deckEntry.js.indexOf('searchFilters.js') >= 0);
  assert.ok(deckEntry.js.indexOf('searchFilters.js') < deckEntry.js.indexOf('contentDeck.js'));
  assert.ok(frameEntry.js.indexOf('searchFilters.js') >= 0);
  assert.ok(frameEntry.js.indexOf('searchFilters.js') < frameEntry.js.indexOf('contentIframe.js'));

  assert.ok(jaMessages.search_filter_button?.message);
  assert.ok(jaMessages.search_filter_presets?.message);

  assert.ok(deckSource.includes('YomikuiSearchFilters?.useColumnSearch'));
  assert.ok(deckSource.includes('YomikuiSearchFilters.FilterButton'));
  assert.ok(deckSource.includes('YomikuiSearchFilters.FilterPanel'));
});
