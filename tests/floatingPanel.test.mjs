import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, Events, settle } from './helpers.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const source = readFileSync(new URL('../floatingControls.js', import.meta.url), 'utf8');
const scroll = readFileSync(new URL('../homeScroll.js', import.meta.url), 'utf8');
const key = 'yomikui_reading_targets_v1';
function setup() {
  const clock = new Clock(), window = new Events();
  const { document } = parseHTML('<html><body></body></html>');
  const saved = {};
  const chrome = { storage: { local: {
    async get(key) { return { [key]: saved[key] }; }, async set(value) { Object.assign(saved, clone(value)); },
  } } };
  const context = vm.createContext({ ...clock.globals(), document, window, chrome });
  vm.runInContext(scroll, context);
  vm.runInContext(source, context);
  return { api: context.YomikuiFloatingControls, saved, clock };
}

function panel(env, options = {}) {
  const { mode = 'post', hideEmpty = true, target = ['recommended'], selectionMode = 'single',
    phase = 'idle', reading = false, ready = true, workspaceId = 'workspace', selectedWorkspaceId = workspaceId,
    kinds = { one: 'recommended' }, lastAction = 'selection', settingsOpen = false, results = [],
    color = 'bluegray', transparency = 0, columns = [{ id: 'one', type: 'home', title: 'Home' }], visible = ['one'],
  } = options;
  const states = [env.api.preferences({ mode, hideEmpty, color, transparency }),
    { workspaceId: selectedWorkspaceId, value: env.api.selectionPreferences({ selectionMode, single: target[0], multiple: target, multipleReady: true }), ready },
    new Set(visible), lastAction, settingsOpen];
  let index, nodes;
  const refs = [];
  let refIndex;
  const React = {
    useState() { const slot = index++; return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }]; },
    useRef(current) { const slot = refIndex++; return refs[slot] ??= { current }; },
    useCallback: fn => fn, useEffect() {}, useLayoutEffect() {},
  };
  const element = (type, props) => ({ type, props });
  const render = () => {
    index = 0; refIndex = 0; nodes = [];
    const tree = env.api.Panel({ React, jsx: { jsx: element, jsxs: element }, columns, kinds, workspaceId,
      view: { phase, results, done: 0, total: results.length }, reading: { busy: reading, results: [], message: '' },
      canRefresh: true, refreshText: '操作結果', refreshDetails: '列ごとの結果',
      onRefresh() {}, onNavigate() {}, ...options, reading: { busy: reading, results: [], message: '' },
    });
    const visit = node => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of [node.props?.children].flat()) visit(child); };
    visit(tree);
    return tree;
  };
  render();
  return { render, nodes: () => nodes, find: predicate => nodes.find(predicate),
    byClass: name => nodes.find(node => node.props?.className === name),
    target: name => nodes.find(node => node.props?.['data-target'] === name),
    mode: mode => nodes.find(node => node.type === 'button' && node.props?.children === (mode === 'single' ? '切り替え' : '複数選択')),
  };
}

test('workspace selections persist without losing concurrent writes and legacy choices migrate to groups', async () => {
  const env = setup();
  assert.equal((await env.api.loadTarget('first')).single, 'recommended');
  env.saved[key] = { old: 'all', search: 'group:search', removed: 'column-id' };
  assert.deepEqual(clone(await env.api.loadTarget('old')).multiple, ['recommended', 'following', 'search', 'explore']);
  assert.equal((await env.api.loadTarget('search')).single, 'search');
  assert.equal((await env.api.loadTarget('removed')).single, 'recommended');
  const one = env.api.saveTarget('first', { selectionMode: 'multiple', single: 'following', multiple: ['search', 'recommended', 'search', 'invalid'], multipleReady: true });
  const two = env.api.saveTarget('second', 'group:search');
  const during = env.api.loadTarget('first');
  await Promise.all([one, two]);
  assert.deepEqual(clone(await during), { selectionMode: 'multiple', single: 'following', multiple: ['search', 'recommended'], multipleReady: true });
  assert.equal((await env.api.loadTarget('second')).single, 'search');
  await env.api.saveTarget('first', { selectionMode: 'multiple', multiple: [] });
  assert.deepEqual(clone((await env.api.loadTarget('first')).multiple), [], 'an intentional empty selection never becomes all columns');
});

test('single and multiple modes remember independent choices and switching targets never runs an action', async () => {
  const env = setup(), actions = [];
  const available = panel(env, { target: ['recommended', 'search'], selectionMode: 'multiple',
    onRefresh: action => actions.push(action), onNavigate: action => actions.push(action),
    columns: [{ id: 'one', type: 'home' }, { id: 'two', type: 'search' }], visible: ['one', 'two'], kinds: { one: 'recommended', two: 'search' } });
  available.mode('single').props.onClick(); available.render();
  available.target('search').props.onClick(); available.render();
  assert.equal(available.target('search').props['aria-pressed'], true);
  assert.equal(available.target('recommended').props['aria-pressed'], false);
  available.mode('multiple').props.onClick(); available.render();
  assert.equal(available.target('recommended').props['aria-pressed'], true);
  assert.equal(available.target('search').props['aria-pressed'], true);
  available.target('recommended').props.onClick(); available.render();
  available.target('search').props.onClick(); available.render();
  assert.equal(available.byClass('yf-top').props.disabled, true);
  assert.equal(available.byClass('yf-refresh').props.disabled, true);
  assert.deepEqual(actions, []);
  await settle();
  assert.deepEqual(clone((await env.api.loadTarget('workspace')).multiple), []);
});

test('the panel keeps targets next to actions and only settings beside its drag handle', () => {
  const ui = panel(setup());
  assert.ok(ui.target('recommended'));
  assert.equal(ui.target('recommended').props.hidden, false);
  assert.ok(!ui.nodes().some(node => node.props?.children === '表示中すべて' || node.props?.label === '個別の列' || node.props?.className === 'yf-summary'));
  assert.ok(!ui.nodes().some(node => node.type === 'select' && node.props?.['aria-label'] === '対象の列'));
  const body = ui.byClass('yf-body').props.children;
  assert.equal(body[1].props.className, 'yf-targets');
  assert.equal(body[2].props.className, 'yf-actions');
  assert.deepEqual(clone(ui.byClass('yf-header').props.children.map(node => node.props.className)), ['yf-handle', 'yf-settings-toggle']);
  assert.equal(ui.byClass('yf-fields').props.hidden, true);
  ui.byClass('yf-settings-toggle').props.onClick(); ui.render();
  assert.equal(ui.byClass('yf-fields').props.hidden, false);
});

test('zero-column groups can be hidden without clearing selection; restoring another workspace disables actions', async () => {
  const env = setup();
  const ui = panel(env, { selectionMode: 'multiple', target: ['search'] });
  assert.equal(ui.target('search').props.hidden, true);
  assert.equal(ui.target('search').props['aria-pressed'], true);
  assert.equal(ui.byClass('yf-down').props.disabled, true);
  const checkbox = ui.find(node => node.type === 'input' && node.props.type === 'checkbox');
  checkbox.props.onChange({ currentTarget: { checked: false } }); ui.render();
  assert.equal(ui.target('search').props.hidden, false);
  assert.equal(ui.target('search').props['aria-pressed'], true);
  assert.equal(ui.target('search').props.disabled, false, 'a selected empty group can be deselected');
  await settle();
  assert.equal((await env.api.loadPreferences()).hideEmpty, false);
  for (const options of [{ ready: false }, { selectedWorkspaceId: 'previous' }, { kinds: {} }]) {
    const restoring = panel(env, options);
    assert.equal(restoring.byClass('yf-refresh').props.disabled, true);
    assert.equal(restoring.byClass('yf-top').props.disabled, true);
  }
});

test('reading, wheel scope and refresh use the same group selection and scroll mode stays in settings', () => {
  const env = setup(), moves = [], refreshes = [];
  const ui = panel(env, { target: ['recommended', 'search'], selectionMode: 'multiple', mode: 'page',
    onNavigate: action => moves.push(clone(action)), onRefresh: action => refreshes.push(clone(action)) });
  ui.byClass('yf-top').props.onClick();
  ui.byClass('yf-down').props.onClick();
  ui.byClass('yf-refresh').props.onClick();
  assert.deepEqual(moves, [{ target: ['recommended', 'search'], mode: 'top' }, { target: ['recommended', 'search'], direction: 1, mode: 'page' }]);
  assert.deepEqual(refreshes, [{ target: ['recommended', 'search'] }]);
  assert.match(ui.byClass('yf-refresh').props.title, /先頭へ戻して/);
  const settings = ui.byClass('yf-fields');
  assert.equal(settings.props.hidden, true);
  assert.ok(settings.props.children[0].props.children.some(child => child.props?.className === 'yf-color-select'));
});

test('results stay inside the refresh button with a live announcement and no layout row', () => {
  const env = setup();
  for (const [status, label] of [['updated', '完了'], ['reloaded', '完了'], ['requested', '未確認'], ['failed', '未確認'], ['skipped', '対象外']]) {
    const ui = panel(env, { lastAction: 'refresh', phase: 'cooldown', results: [{ status }] });
    assert.equal(ui.byClass('yf-refresh').props.children[1], label);
    assert.equal(ui.find(node => node.props?.role === 'status').props.className, 'yf-sr-only');
    assert.match(ui.byClass('yf-refresh').props.title, /列ごとの結果/);
    assert.equal(ui.byClass('yf-down').props.disabled, false);
    assert.equal(ui.byClass('yf-refresh').props.disabled, true);
  }
  let cancelled = 0;
  const running = panel(env, { phase: 'running', onCancelRefresh: () => cancelled++ });
  assert.equal(running.byClass('yf-down').props.disabled, true);
  assert.equal(running.target('recommended').props.disabled, true);
  assert.equal(running.byClass('yf-refresh').props.disabled, false);
  running.byClass('yf-refresh').props.onClick();
  assert.equal(cancelled, 1);
  const moving = panel(env, { reading: true });
  assert.equal(moving.byClass('yf-refresh').props.disabled, true);
  assert.equal(moving.target('recommended').props.disabled, true);
});

test('a temporary unknown page during a reload does not move or hide its target button', () => {
  const env = setup(), view = { phase: 'idle', results: [] }, kinds = { one: 'recommended' };
  const ui = panel(env, { view, kinds });
  view.phase = 'running'; kinds.one = null; ui.render();
  assert.equal(ui.target('recommended').props.hidden, false);
  assert.equal(ui.target('recommended').props.children.at(-1).props.children, '1列');
  assert.equal(ui.byClass('yf-down').props.disabled, true, 'stable display counts never authorize an operation');
  view.phase = 'idle'; ui.render();
  assert.equal(ui.target('recommended').props.hidden, true);
});

test('color, transparency and movement mode survive preference changes', async () => {
  const env = setup();
  const ui = panel(env, { mode: 'page', color: 'sage', transparency: 35 });
  ui.find(node => node.type === 'select' && node.props['aria-label'] === '背景色').props.onChange({ currentTarget: { value: 'gray' } });
  ui.find(node => node.type === 'input' && node.props.type === 'range').props.onChange({ currentTarget: { value: '60' } });
  await settle();
  const prefs = await env.api.loadPreferences();
  assert.deepEqual([prefs.color, prefs.transparency, prefs.mode], ['gray', 60, 'page']);
});
