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
    api.buildSearchPath('rust', { media: 'images', excludeRetweets: true, sinceDate: '2026-05-01', untilDate: '2026-05-11' }, 'live'),
  );
  const customRangeParsed = api.parseSearchQuery(new URL(navigated.at(-1), 'https://x.com').searchParams.get('q'));
  assert.equal(customRangeParsed.filters.sinceDate, '2026-05-01');
  assert.equal(customRangeParsed.filters.untilDate, '2026-05-11');
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
  assert.equal(
    navigated.at(-1),
    api.buildSearchPath('rust', { sinceDate: '2026-10-01', untilDate: '2026-11-01' }, 'live'),
  );

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

test('relativePeriod presets resolve dynamically to current day/week/month/year when applied later', async () => {
  const { api } = setup();
  const saveDayNow = new Date(2026, 10, 13, 12, 0, 0).getTime(); // 2026-11-13
  const nextWeekNow = new Date(2026, 10, 20, 12, 0, 0).getTime(); // 2026-11-20 (Fri)
  const nextMonthNow = new Date(2026, 11, 5, 12, 0, 0).getTime(); // 2026-12-05
  const nextYearNow = new Date(2027, 2, 10, 12, 0, 0).getTime(); // 2027-03-10

  const dayPresetFilters = api.normalizeFilters({ media: 'images', relativePeriod: 'day' });
  assert.equal(dayPresetFilters.relativePeriod, 'day');
  assert.equal(dayPresetFilters.sinceDate, null);
  assert.equal(dayPresetFilters.untilDate, null);
  assert.equal(api.countActiveFilters(dayPresetFilters), 2);
  assert.equal(api.formatPeriodLabel(dayPresetFilters), '今日');
  assert.equal(api.suggestPresetName(dayPresetFilters), '画像 · 今日');

  await api.savePresets([
    { id: 'rel-day', name: '今日の画像', filters: { media: 'images', relativePeriod: 'day' }, tab: 'live' },
    { id: 'rel-week', name: '今週', filters: { relativePeriod: 'week' }, tab: null },
    { id: 'rel-month', name: '今月', filters: { relativePeriod: 'month' }, tab: null },
    { id: 'rel-year', name: '今年', filters: { relativePeriod: 'year' }, tab: null },
  ]);
  const loaded = await api.loadPresets();
  assert.equal(loaded[0].filters.relativePeriod, 'day');

  // Applied on save day -> 2026-11-13
  assert.equal(
    api.applyPresetToUrl('/search?q=ai', loaded[0], saveDayNow),
    api.buildSearchPath('ai', { media: 'images', sinceDate: '2026-11-13', untilDate: '2026-11-14' }, 'live', saveDayNow),
  );
  // Applied next week -> 2026-11-20
  assert.equal(
    api.applyPresetToUrl('/search?q=ai', loaded[0], nextWeekNow),
    api.buildSearchPath('ai', { media: 'images', sinceDate: '2026-11-20', untilDate: '2026-11-21' }, 'live', nextWeekNow),
  );
  // Week (Mon..Sun for 2026-11-20 is 2026-11-16..2026-11-22 -> until 2026-11-23)
  assert.equal(
    api.applyPresetToUrl('/search?q=ai', loaded[1], nextWeekNow),
    api.buildSearchPath('ai', { sinceDate: '2026-11-16', untilDate: '2026-11-23' }, 'top', nextWeekNow),
  );
  // Month -> 2026-12-01..2027-01-01
  assert.equal(
    api.applyPresetToUrl('/search?q=ai', loaded[2], nextMonthNow),
    api.buildSearchPath('ai', { sinceDate: '2026-12-01', untilDate: '2027-01-01' }, 'top', nextMonthNow),
  );
  // Year -> 2027-01-01..2028-01-01
  assert.equal(
    api.applyPresetToUrl('/search?q=ai', loaded[3], nextYearNow),
    api.buildSearchPath('ai', { sinceDate: '2027-01-01', untilDate: '2028-01-01' }, 'top', nextYearNow),
  );
});

test('FilterPanel save form supports relative period toggle defaulting ON for current period and OFF for past period', async () => {
  const { api } = setup();
  const jsx = makeJsx();
  const added = [];
  const todayBounds = api.getPeriodBounds('day', api.todayYmd());
  const yesterdayBounds = api.shiftPeriodRange('day', todayBounds.sinceDate, todayBounds.untilDate, -1);
  const pastMonthFilters = api.normalizeFilters({ sinceDate: '2025-01-01', untilDate: '2025-02-01' });

  const renderPanelWith = (filters, hooks, presets = []) => {
    let hookIdx = 0;
    const useState = (init) => {
      const idx = hookIdx++;
      if (!(idx in hooks)) hooks[idx] = typeof init === 'function' ? init() : init;
      return [hooks[idx], val => { hooks[idx] = typeof val === 'function' ? val(hooks[idx]) : val; }];
    };
    return api.FilterPanel({
      searchState: {
        open: true,
        setOpen: () => {},
        toggleOpen: () => {},
        isSearchPage: true,
        isLiveFeed: false,
        currentUrl: api.buildSearchPath('rust', filters, 'top'),
        tab: 'top',
        baseText: 'rust',
        filters,
        activeCount: api.countActiveFilters(filters),
        presets,
        navigateSearch: () => {},
        addPreset: async (item) => added.push(item),
        deletePreset: async () => {},
      },
      jsx,
      useState,
      useEffect: () => {},
    });
  };

  // 1. Current day selected -> checkbox defaults ON, placeholder is "今日", saves relativePeriod: 'day'
  const hooksToday = [];
  const todayFilters = api.normalizeFilters({ sinceDate: todayBounds.sinceDate, untilDate: todayBounds.untilDate });
  const initialTree = renderPanelWith(todayFilters, hooksToday, [
    { id: 'p-rel', name: '今日の検索', filters: { relativePeriod: 'day' }, tab: null, includeQuery: false, query: '' },
  ]);
  const initialNodes = flattenNodes(initialTree);
  // Active preset chip matches resolved today dates
  const chip = initialNodes.find(n => String(n.props?.className).includes('rd-search-preset-chip'));
  assert.ok(String(chip.props.className).includes('border-primary'));
  initialNodes.filter(n => n.type === 'button').find(b => textContent(b).trim() === '+ 保存').props.onClick();

  const formTree = renderPanelWith(todayFilters, hooksToday);
  const formNodes = flattenNodes(formTree.find ? formTree : formTree);
  const form = formNodes.find(n => n.type === 'form');
  assert.ok(form);
  const formDescendants = flattenNodes(form);
  const nameInput = formDescendants.find(n => n.type === 'input' && n.props.type === 'text');
  assert.equal(nameInput.props.placeholder, '今日');
  const relativeLabelNode = formDescendants.find(n => n.type === 'label' && textContent(n).includes('実行時の今日'));
  assert.ok(relativeLabelNode);
  const relativeCheckbox = flattenNodes(relativeLabelNode).find(n => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(relativeCheckbox.props.checked, true);

  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(added.at(-1).name, '今日');
  assert.equal(added.at(-1).filters.relativePeriod, 'day');
  assert.equal(added.at(-1).filters.sinceDate, null);

  // Yesterday search does NOT match the relative 'day' preset chip
  const yesterdayFilters = api.normalizeFilters({ sinceDate: yesterdayBounds.sinceDate, untilDate: yesterdayBounds.untilDate });
  const yesterdayNodes = flattenNodes(renderPanelWith(yesterdayFilters, [], [
    { id: 'p-rel', name: '今日の検索', filters: { relativePeriod: 'day' }, tab: null, includeQuery: false, query: '' },
  ]));
  const yesterdayChip = yesterdayNodes.find(n => String(n.props?.className).includes('rd-search-preset-chip'));
  assert.equal(String(yesterdayChip.props.className).includes('border-primary'), false);

  // Unchecking the checkbox saves fixed dates instead
  hooksToday.length = 0;
  flattenNodes(renderPanelWith(todayFilters, hooksToday))
    .filter(n => n.type === 'button')
    .find(b => textContent(b).trim() === '+ 保存')
    .props.onClick();
  const form2Nodes = flattenNodes(renderPanelWith(todayFilters, hooksToday));
  const relCb2 = flattenNodes(form2Nodes.find(n => n.type === 'label' && textContent(n).includes('実行時の今日')))
    .find(n => n.type === 'input');
  relCb2.props.onChange({ currentTarget: { checked: false } });
  const form2 = flattenNodes(renderPanelWith(todayFilters, hooksToday)).find(n => n.type === 'form');
  await form2.props.onSubmit({ preventDefault() {} });
  assert.equal(added.at(-1).filters.relativePeriod, undefined);
  assert.equal(added.at(-1).filters.sinceDate, todayBounds.sinceDate);
  assert.equal(added.at(-1).filters.untilDate, todayBounds.untilDate);

  // 2. Past month selected -> checkbox defaults OFF
  const hooksPast = [];
  flattenNodes(renderPanelWith(pastMonthFilters, hooksPast))
    .filter(n => n.type === 'button')
    .find(b => textContent(b).trim() === '+ 保存')
    .props.onClick();
  const pastFormNodes = flattenNodes(renderPanelWith(pastMonthFilters, hooksPast));
  const pastRelCb = flattenNodes(pastFormNodes.find(n => n.type === 'label' && textContent(n).includes('実行時の今月')))
    .find(n => n.type === 'input');
  assert.equal(pastRelCb.props.checked, false);
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

test('day period boundaries align to local midnight in UTC queries and separate Today from Previous Day cleanly', () => {
  const { api, clock } = setup();
  const today = api.todayYmd(clock.now);
  const todayBounds = api.getPeriodBounds('day', today);
  const prevBounds = api.shiftPeriodRange('day', todayBounds.sinceDate, todayBounds.untilDate, -1, clock.now);

  const todayQuery = api.buildSearchQuery('cats', { sinceDate: todayBounds.sinceDate, untilDate: todayBounds.untilDate }, clock.now);
  const prevQuery = api.buildSearchQuery('cats', { sinceDate: prevBounds.sinceDate, untilDate: prevBounds.untilDate }, clock.now);

  const expectedPrevSince = api.formatSearchDateBoundary(prevBounds.sinceDate);
  const expectedPrevUntil = api.formatSearchDateBoundary(prevBounds.untilDate);
  const expectedTodaySince = api.formatSearchDateBoundary(todayBounds.sinceDate);
  const expectedTodayUntil = api.formatSearchDateBoundary(todayBounds.untilDate);

  // Previous day ends at the exact boundary where Today starts (no UTC 09:00 JST bleed)
  assert.equal(expectedPrevUntil, expectedTodaySince);
  assert.equal(prevQuery, `cats since:${expectedPrevSince} until:${expectedPrevUntil}`);
  assert.equal(todayQuery, `cats since:${expectedTodaySince} until:${expectedTodayUntil}`);

  // When timezone has a non-zero offset (e.g. JST +09:00), explicit _UTC midnight timestamps are emitted
  if (new Date(2026, 10, 13, 0, 0, 0, 0).getTimezoneOffset() === -540) {
    assert.equal(todayQuery, 'cats since:2026-11-12_15:00:00_UTC until:2026-11-13_15:00:00_UTC');
    assert.equal(prevQuery, 'cats since:2026-11-11_15:00:00_UTC until:2026-11-12_15:00:00_UTC');
    // _JST midnight tokens also parse into the same local calendar dates
    const parsedJst = api.parseSearchQuery('cats since:2026-11-12_00:00:00_JST until:2026-11-13_00:00:00_JST', clock.now);
    assert.equal(parsedJst.filters.sinceDate, '2026-11-12');
    assert.equal(parsedJst.filters.untilDate, '2026-11-13');
  }

  // Round-trip parsing recovers the local calendar dates without collapsing into recency chips
  const parsedPrev = api.parseSearchQuery(prevQuery, clock.now);
  assert.equal(parsedPrev.baseText, 'cats');
  assert.equal(parsedPrev.filters.sinceDays, null);
  assert.equal(parsedPrev.filters.sinceDate, prevBounds.sinceDate);
  assert.equal(parsedPrev.filters.untilDate, prevBounds.untilDate);
  assert.equal(api.detectPeriodUnit(parsedPrev.filters.sinceDate, parsedPrev.filters.untilDate), 'day');

  // Start-date-only custom period (without untilDate) stays a custom date rather than collapsing to 24時間
  const startOnlyQuery = api.buildSearchQuery('cats', { sinceDate: prevBounds.sinceDate }, clock.now);
  const parsedStartOnly = api.parseSearchQuery(startOnlyQuery, clock.now);
  if (new Date(2026, 10, 12, 0, 0, 0, 0).getTimezoneOffset() !== 0) {
    assert.equal(parsedStartOnly.filters.sinceDays, null);
    assert.equal(parsedStartOnly.filters.sinceDate, prevBounds.sinceDate);
  }

  // Non-midnight custom timestamps remain untouched in baseText
  const midDay = api.parseSearchQuery('cats since:2026-11-12_12:34:56_UTC until:2026-11-13_01:02:03_UTC', clock.now);
  assert.equal(midDay.baseText, 'cats since:2026-11-12_12:34:56_UTC until:2026-11-13_01:02:03_UTC');
  assert.equal(midDay.filters.sinceDate, null);
  assert.equal(midDay.filters.untilDate, null);
});
