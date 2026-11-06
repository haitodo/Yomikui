import assert from 'node:assert/strict';
import test from 'node:test';
import { browserEnvironment, evaluate, tweet, Element } from './helpers.mjs';

function setup() {
  const env = browserEnvironment();
  let columnVisible = true;
  let churn = 0;
  evaluate(env.context, 'frameMaintenance.js');
  const maintenance = new env.context.YomikuiFrameMaintenance({
    targetOrigin: 'https://x.com', getColumnId: () => 'column1',
    isColumnVisible: () => columnVisible, getChurn: () => churn,
  });
  return {
    ...env, maintenance,
    setVisible(value) { columnVisible = value; env.window.emit('yomikui-frame-column-visibility'); },
    setChurn(value) { churn = value; },
  };
}

test('idle columns do not rescan the document, send duplicate counts, or measure FPS', async () => {
  const env = setup();
  env.document.body.appendChild(tweet('1'));
  env.maintenance.start();
  const queries = env.document.documentQueries;
  await env.clock.advance(15 * 60 * 1000);
  assert.equal(env.document.documentQueries, queries);
  assert.equal(env.messages.length, 1);
  assert.equal(env.messages[0].count, 1);
  assert.equal(env.clock.frames.size, 0);
  assert.equal(env.clock.timers.size, 0);
});

test('leaf node additions without child elements early exit and skip querySelectorAll', () => {
  const env = setup();
  env.maintenance.start();
  const observer = env.observers[0];
  const span = new Element('span');
  const queriesBefore = env.document.documentQueries;
  observer.emit([{ type: 'childList', target: env.document.body, addedNodes: [span] }]);
  assert.equal(env.document.documentQueries, queriesBefore);
  assert.equal(env.maintenance.pendingTweets.size, 0);
});

test('new mutations restart performance checks after an idle session', async () => {
  const env = setup();
  env.maintenance.start();
  await env.clock.advance(10 * 60 * 1000);
  assert.equal(env.clock.timers.size, 0);
  env.setChurn(100);
  const item = env.document.body.appendChild(tweet('1'));
  env.observers.at(-1).emit([{ type: 'childList', target: env.document.body, addedNodes: [item] }]);
  await env.clock.advance(5000);
  assert.equal(env.clock.frames.size, 1);
  env.maintenance.dispose();
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.clock.frames.size, 0);
});

test('mutations are batched, count only changed tweets, and support reused DOM nodes', async () => {
  const env = setup();
  env.maintenance.start();
  const observer = env.observers[0];
  const queries = env.document.documentQueries;
  const item = env.document.body.appendChild(tweet('123'));
  const record = { type: 'childList', target: env.document.body, addedNodes: [item], removedNodes: [] };
  for (let i = 0; i < 100; i++) observer.emit([record]);
  assert.equal(env.maintenance.pendingTweets.size, 1);
  await env.clock.advance(4000);
  assert.equal(env.messages.at(-1).count, 1);
  assert.equal(env.document.documentQueries, queries);
  observer.emit([record]);
  await env.clock.advance(4000);
  assert.equal(env.messages.length, 2);
  item.children[0].setAttribute('href', '/someone/status/456');
  observer.emit([{ type: 'attributes', target: item.children[0] }]);
  await env.clock.advance(4000);
  assert.equal(env.messages.at(-1).count, 2);
});

test('hidden columns and tabs release all timers, queued nodes, observers, and FPS callbacks', async () => {
  const env = setup();
  env.maintenance.start();
  const observer = env.observers.at(-1);
  const item = env.document.body.appendChild(tweet('1'));
  observer.emit([{ type: 'childList', target: env.document.body, addedNodes: [item] }]);
  env.setVisible(false);
  assert.equal(observer.connected, false);
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.maintenance.pendingTweets.size, 0);
  const queries = env.document.documentQueries;
  await env.clock.advance(60000);
  assert.equal(env.document.documentQueries, queries);
  env.setVisible(true);
  assert.equal(env.messages.at(-1).count, 1);
  env.document.hidden = true;
  env.document.emit('visibilitychange');
  assert.equal(env.clock.timers.size, 0);
  env.document.hidden = false;
  env.document.emit('visibilitychange');
  assert.equal(env.maintenance.active, true);
});

test('FPS sampling is conditional, bounded to one second, and resumes after page restoration', async () => {
  const env = setup();
  env.maintenance.start();
  env.setChurn(100);
  await env.clock.advance(10 * 60 * 1000);
  assert.equal(env.clock.frames.size, 1);
  for (let i = 0; i <= 20; i++) env.clock.frame(50);
  assert.equal(env.clock.frames.size, 0);
  const suggestion = env.messages.at(-1);
  assert.equal(suggestion.shouldSuggest, true);
  assert.equal(suggestion.fps, 20);
  env.window.emit('pagehide');
  assert.equal(env.clock.timers.size, 0);
  env.window.emit('pageshow');
  assert.equal(env.clock.frames.size, 1);
  env.setVisible(false);
  assert.equal(env.clock.frames.size, 0);
});

test('reset clears stale suggestions and counts without restarting hidden work', () => {
  const env = setup();
  const item = env.document.body.appendChild(tweet('1'));
  env.maintenance.start();
  env.maintenance.setSuggestion(true);
  item.children[0].setAttribute('href', '/someone/status/2');
  env.maintenance.reset();
  assert.equal(env.maintenance.suggested, false);
  assert.equal(env.messages.filter(message => message.shouldSuggest === false).length, 1);
  assert.deepEqual(Array.from(env.maintenance.seenIds), ['2']);
  env.setVisible(false);
  env.maintenance.reset();
  assert.equal(env.clock.timers.size, 0);
  env.maintenance.dispose();
  env.setVisible(true);
  assert.equal(env.clock.timers.size, 0);
});

test('duplicate cleanup retains the original per-tweet limits', () => {
  const env = setup();
  const item = env.document.body.appendChild(tweet('1'));
  for (let i = 0; i < 20; i++) item.appendChild(new Element('span', { class: 'yomikui-label-badge' }));
  for (let i = 0; i < 3; i++) env.document.body.appendChild(new Element('style', { id: 'yomikui-account-label-styles' }));
  env.maintenance.start();
  assert.equal(item.querySelectorAll('.yomikui-label-badge').length, 16);
  assert.equal(env.document.querySelectorAll('#yomikui-account-label-styles').length, 1);
});

test('tweet ID history stays bounded and counts never decrease after pruning', async () => {
  const env = setup();
  env.maintenance.start();
  let highest = 0;
  for (let batch = 0; batch < 12; batch++) {
    const items = Array.from({ length: 500 }, (_, index) => tweet(String(batch * 500 + index)));
    env.document.body.replaceChildren(...items);
    env.observers.at(-1).emit([{ type: 'childList', target: env.document.body, addedNodes: items }]);
    await env.clock.advance(4000);
    assert.ok(env.maintenance.seenIds.size <= 5000);
    assert.ok(env.maintenance.count >= highest);
    highest = env.maintenance.count;
  }
});

test('the iframe bundle returns before initialization in a top-level page', () => {
  const env = browserEnvironment();
  env.window.top = env.window;
  evaluate(env.context, 'frameMaintenance.js');
  evaluate(env.context, 'contentIframe.js');
  assert.equal(env.context.YomikuiFrameMaintenance, undefined);
  assert.equal(env.observers.length, 0);
  assert.equal(env.clock.timers.size, 0);
});
