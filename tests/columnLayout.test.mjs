import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Clock } from './helpers.mjs';

const layoutSource = readFileSync(new URL('../columnLayout.js', import.meta.url), 'utf8');
const deckSource = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function setup() {
  const clock = new Clock();
  const saved = new Map();
  const writes = [];
  const context = vm.createContext({
    ...clock.globals(), URL, queueMicrotask,
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID },
    chrome: { runtime: { getManifest: () => ({ version: '0.1.0' }) } },
    layoutStorage: {
      get: async key => clone(saved.get(key)),
      set: async (key, value) => { saved.set(key, clone(value)); writes.push(key); },
    },
  });
  vm.runInContext(layoutSource, context);
  // Run the shipped schema, Zustand/Immer store and persistence code. Stop
  // before UI initialization and replace only the IndexedDB I/O boundary.
  const end = deckSource.indexOf(';var Im=[];');
  assert.ok(end > 0, 'dashboard store boundary must exist');
  vm.runInContext(deckSource.slice(0, end) + `;
    Ln = key => globalThis.layoutStorage.get(key);
    ra = (key, value) => globalThis.layoutStorage.set(key, value);
    globalThis.layoutRuntime = {
      store: Ut, columnSchema: rw, createColumn: _h, loadWorkspaces: nB
    };
  })();`, context);
  const { store, columnSchema, createColumn, loadWorkspaces } = context.layoutRuntime;
  const columns = [24, 30, null].map(width => ({ ...createColumn('home', '#1d9bf0'), width }));
  const inactiveColumns = [{ ...createColumn('notifications', '#ff0000'), width: 28 }];
  const workspace = (id, items) => ({ id, name: id, columns: items, createdAt: 0, updatedAt: 0 });
  store.setState({
    activeWorkspaceId: 'active', columns,
    workspaces: [workspace('active', columns), workspace('inactive', inactiveColumns)],
  });
  return { clock, saved, writes, store, columnSchema, loadWorkspaces, layout: context.YomikuiColumnLayout };
}

test('legacy and invalid width modes retain the existing fixed width', () => {
  const { columnSchema, store, layout } = setup();
  const { widthMode, ...legacy } = store.getState().columns[0];
  for (const value of [legacy, { ...legacy, widthMode: 'unknown' }, { ...legacy, widthMode: null }]) {
    const column = columnSchema.parse(value);
    assert.equal(column.widthMode, 'fixed');
    assert.equal(column.width, 24);
    assert.equal(layout.getColumnStyle(column).width, '24rem');
  }
  assert.equal(layout.getColumnStyle({ width: null }).width, '32rem');
});

test('Home refresh position defaults to standard and survives saving, duplication and reload', async () => {
  const { columnSchema, store, clock, loadWorkspaces } = setup();
  const column = store.getState().columns[0];
  assert.equal(column.homeRefreshPosition, 'top');
  const { homeRefreshPosition, ...legacy } = column;
  for (const value of [legacy, { ...legacy, homeRefreshPosition: null }, { ...legacy, homeRefreshPosition: 'invalid' }]) {
    assert.equal(columnSchema.parse(value).homeRefreshPosition, 'top');
  }
  store.getState().updateColumn(column.id, { homeRefreshPosition: 'preserve' });
  store.getState().duplicateColumn(column.id);
  assert.equal(store.getState().columns[1].homeRefreshPosition, 'preserve');
  assert.equal(store.getState().columns[2].homeRefreshPosition, 'top');
  await clock.advance(280);
  const loaded = (await loadWorkspaces()).workspaces[0].columns;
  assert.equal(loaded[0].homeRefreshPosition, 'preserve');
  assert.equal(loaded[1].homeRefreshPosition, 'preserve');
  assert.equal(loaded[2].homeRefreshPosition, 'top');
});

test('automatic widths use equal flex bases and preserve the minimum width', () => {
  const { layout } = setup();
  const first = clone(layout.getColumnStyle({ widthMode: 'auto', width: 24 }));
  const second = clone(layout.getColumnStyle({ widthMode: 'auto', width: 40 }));
  assert.deepEqual(first, second);
  assert.equal(first.flex, '1 0 0rem');
  assert.equal(first.minWidth, '20rem');
  const fixed = layout.getColumnStyle({ widthMode: 'fixed', width: 28 });
  assert.equal(fixed.flex, '0 0 28rem');
});

test('equalization updates the active workspace once and preserves fixed-width values', async () => {
  const { store, clock, saved, loadWorkspaces } = setup();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  store.getState().equalizeWorkspaceColumns('active');
  assert.equal(notifications, 1);
  assert.deepEqual(Array.from(store.getState().columns, column => column.widthMode), ['auto', 'auto', 'auto']);
  assert.deepEqual(Array.from(store.getState().columns, column => column.width), [24, 30, null]);
  assert.equal(store.getState().workspaces[1].columns[0].widthMode, 'fixed');
  const timers = clock.timers.size;
  store.getState().equalizeWorkspaceColumns('active');
  store.getState().equalizeWorkspaceColumns('missing');
  assert.equal(notifications, 1);
  assert.equal(clock.timers.size, timers);
  unsubscribe();
  await clock.advance(280);
  assert.equal(saved.get('yomikui_workspaces')[0].columns[0].widthMode, 'auto');
  const reloaded = await loadWorkspaces();
  assert.equal(reloaded.activeWorkspaceId, 'active');
  assert.equal(reloaded.workspaces[0].columns[0].widthMode, 'auto');
  assert.equal(reloaded.workspaces[0].columns[0].width, 24);
  assert.equal(reloaded.workspaces[1].columns[0].widthMode, 'fixed');
});

test('a fixed column keeps its saved width while other columns remain automatic', async () => {
  const { store, clock, loadWorkspaces, layout } = setup();
  const id = store.getState().columns[0].id;
  store.getState().equalizeWorkspaceColumns('active');
  store.getState().updateColumn(id, { widthMode: 'fixed' });
  assert.equal(store.getState().columns[0].width, 24);
  assert.equal(layout.getColumnStyle(store.getState().columns[0]).width, '24rem');
  assert.equal(store.getState().columns[1].widthMode, 'auto');
  store.getState().updateColumn(id, { width: 27 });
  store.getState().updateColumn(id, { widthMode: 'auto' });
  store.getState().updateColumn(id, { widthMode: 'fixed' });
  await clock.advance(280);
  const columns = (await loadWorkspaces()).workspaces[0].columns;
  assert.equal(columns[0].widthMode, 'fixed');
  assert.equal(columns[0].width, 27);
  assert.equal(columns[1].widthMode, 'auto');
});

test('equalizing an inactive workspace leaves the active columns and pending edits intact', async () => {
  const { store, clock, loadWorkspaces } = setup();
  const activeId = store.getState().columns[0].id;
  store.getState().updateColumn(activeId, { width: 26 });
  store.getState().equalizeWorkspaceColumns('inactive');
  assert.equal(store.getState().activeWorkspaceId, 'active');
  assert.equal(store.getState().columns[0].widthMode, 'fixed');
  assert.equal(store.getState().columns[0].width, 26);
  assert.equal(store.getState().workspaces[1].columns[0].widthMode, 'auto');
  await clock.advance(280);
  const workspaces = (await loadWorkspaces()).workspaces;
  assert.equal(workspaces[0].columns[0].width, 26);
  assert.equal(workspaces[1].columns[0].widthMode, 'auto');
  assert.equal(workspaces[1].columns[0].width, 28);
  await store.getState().switchWorkspace('inactive');
  assert.equal(store.getState().columns[0].widthMode, 'auto');
  await store.getState().switchWorkspace('active');
  assert.equal(store.getState().columns[0].widthMode, 'fixed');
  assert.equal(store.getState().columns[0].width, 26);
});

test('added columns inherit automatic sizing and duplicates retain their own sizing', () => {
  const { store } = setup();
  store.getState().addColumn('home');
  assert.equal(store.getState().columns.at(-1).widthMode, 'fixed');
  store.getState().equalizeWorkspaceColumns('active');
  const firstId = store.getState().columns[0].id;
  store.getState().updateColumn(firstId, { widthMode: 'fixed' });
  store.getState().addColumn('home');
  assert.equal(store.getState().columns.at(-1).widthMode, 'auto');
  store.getState().duplicateColumn(firstId);
  assert.equal(store.getState().columns[1].widthMode, 'fixed');
  assert.equal(store.getState().columns[1].width, 24);
  const autoId = store.getState().columns.at(-1).id;
  store.getState().duplicateColumn(autoId);
  assert.equal(store.getState().columns.at(-1).widthMode, 'auto');
  store.getState().removeColumn(firstId);
  assert.equal(store.getState().columns.at(-1).widthMode, 'auto');
});

function controls(layout, widthMode = 'fixed') {
  const changes = [];
  const modes = [];
  const element = (type, props, key) => ({ type, props, key });
  const tree = layout.WidthControl({
    column: { id: 'column', widthMode }, width: 32,
    onWidthChange: value => changes.push(value),
    onModeChange: value => modes.push(value),
    Slider: 'Slider', Input: 'Input', jsx: { jsx: element, jsxs: element }, t: key => key,
  });
  const find = (type, predicate = () => true) => {
    const visit = node => {
      if (!node || typeof node !== 'object') return undefined;
      if (node.type === type && predicate(node)) return node;
      const children = node.props?.children;
      return (Array.isArray(children) ? children : [children]).map(visit).find(Boolean);
    };
    return visit(tree);
  };
  return { changes, modes, find };
}

test('automatic mode hides the fixed-width inputs and describes how space is shared', () => {
  const { layout } = setup();
  const { find, modes } = controls(layout, 'auto');
  assert.equal(find('Input'), undefined);
  assert.equal(find('Slider'), undefined);
  const group = find('div', node => node.props.role === 'group');
  assert.equal(group.props['aria-describedby'], find('p').props.id);
  assert.equal(group.props['aria-labelledby'], find('span').props.id);
  const [automatic, fixed] = group.props.children;
  assert.equal(automatic.props['aria-pressed'], true);
  assert.equal(fixed.props['aria-pressed'], false);
  automatic.props.onClick();
  assert.deepEqual(modes, []);
  fixed.props.onClick();
  assert.deepEqual(modes, ['fixed']);
});

test('fixed-width inputs commit on blur, clamp values, and allow cancelling a draft', () => {
  const { layout } = setup();
  const { find, changes, modes } = controls(layout);
  const [automatic, fixed] = find('div', node => node.props.role === 'group').props.children;
  assert.equal(automatic.props['aria-pressed'], false);
  assert.equal(fixed.props['aria-pressed'], true);
  automatic.props.onClick();
  assert.deepEqual(modes, ['auto']);
  const input = find('Input').props;
  for (const [value, expected] of [['24', '24'], ['60', '60'], ['100', '80'], ['3', '20'], ['28.7', '29'], ['', '32'], ['bad', '32']]) {
    const currentTarget = { value };
    input.onBlur({ currentTarget });
    assert.equal(currentTarget.value, expected);
  }
  assert.deepEqual(changes, [24, 60, 80, 20, 29]);
  const currentTarget = { value: '27', blur() { input.onBlur({ currentTarget }); } };
  input.onKeyDown({ key: 'Escape', currentTarget, preventDefault() {}, stopPropagation() {} });
  assert.equal(currentTarget.value, '32');
  assert.deepEqual(changes, [24, 60, 80, 20, 29]);
  currentTarget.value = '26';
  input.onKeyDown({ key: 'Enter', currentTarget, preventDefault() {}, stopPropagation() {} });
  assert.equal(changes.at(-1), 26);
  find('Slider').props.onValueChange([70]);
  assert.equal(changes.at(-1), 70);
});

test('the extension loads layout support first and includes the new translations', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('contentDeck.js')).js;
  assert.ok(scripts.indexOf('columnLayout.js') >= 0);
  assert.ok(scripts.indexOf('columnLayout.js') < scripts.indexOf('contentDeck.js'));
  const messages = JSON.parse(readFileSync(new URL('../_locales/ja/messages.json', import.meta.url), 'utf8'));
  for (const key of ['column_settings_width_auto', 'column_settings_width_auto_desc', 'column_settings_width_fixed', 'workspaces_equalize_columns', 'workspaces_equalize_columns_desc']) {
    assert.ok(messages[key]?.message);
    assert.ok(deckSource.includes(JSON.stringify({ [key]: messages[key] }).slice(1, -1)));
  }
});

test('likes column can be added with correct defaults and validates in schema', () => {
  const { store, columnSchema } = setup();
  const initialCount = store.getState().columns.length;
  store.getState().addColumn('likes');
  const added = store.getState().columns.at(-1);
  assert.equal(store.getState().columns.length, initialCount + 1);
  assert.equal(added.type, 'likes');
  assert.equal(added.title, 'Likes');
  assert.equal(added.path, '/i/history/likes');
  assert.equal(added.hideBanner, true);
  assert.equal(added.hideTopBar, true);

  const parsed = columnSchema.safeParse(added);
  assert.equal(parsed.success, true);
});
