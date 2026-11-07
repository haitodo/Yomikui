import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { downloadEnvironment, evaluate, hook, settle } from './helpers.mjs';

function setup() {
  const env = downloadEnvironment();
  const writes = [];
  let reads = 0;
  const dnrUpdates = [];
  const api = env.api;
  api.runtime = { id: 'extension', onMessage: hook(), onInstalled: hook(), onStartup: hook() };
  api.webRequest = { onCompleted: hook(), onHeadersReceived: hook() };
  api.storage = { session: {
    set: async value => { writes.push(value); },
    get: async () => { reads++; return {}; },
  } };
  api.contextMenus = { removeAll: callback => callback(), create: (options, callback) => callback(), onClicked: hook() };
  api.declarativeNetRequest = {
    getDynamicRules: async () => [],
    updateDynamicRules: async options => { dnrUpdates.push(options); },
  };
  api.action = { onClicked: hook() };
  env.context.chrome = api;
  evaluate(env.context, 'background.js', source => source.replace(/^import .*;\n/, ''));
  return { ...env, api, writes, dnrUpdates, get reads() { return reads; } };
}

test('repeated query ID discoveries persist once and cached requests avoid storage reads', async () => {
  const env = setup();
  const url = 'https://x.com/i/api/graphql/abcdefghij/HomeLatestTimeline';
  for (let i = 0; i < 100; i++) env.api.webRequest.onCompleted.emit({ statusCode: 200, url });
  await settle();
  assert.equal(env.writes.length, 1);
  let response;
  env.api.runtime.onMessage.emit({ type: 'yomikui-get-x-query-id', operationName: 'HomeLatestTimeline' }, { id: 'extension' }, value => { response = value; });
  assert.equal(response, 'abcdefghij');
  assert.equal(env.reads, 0);
  env.api.webRequest.onCompleted.emit({ statusCode: 200, url: url.replace('abcdefghij', 'klmnopqrst') });
  assert.equal(env.writes.length, 2);
});

test('untrusted query ID sources and senders remain rejected', () => {
  const env = setup();
  for (const url of [
    'https://untrusted.example/i/api/graphql/abcdefghij/HomeLatestTimeline',
    'https://x.com/i/api/graphql/short/HomeLatestTimeline',
    'https://x.com/i/api/graphql/abcdefghij/UnsupportedOperation',
  ]) env.api.webRequest.onCompleted.emit({ statusCode: 200, url });
  assert.equal(env.writes.length, 0);
  let response;
  env.api.runtime.onMessage.emit({ type: 'yomikui-get-x-query-id', operationName: 'HomeLatestTimeline' }, { id: 'other' }, value => { response = value; });
  assert.equal(response, null);
  assert.equal(env.reads, 0);
});

test('a failed persistence attempt can retry on the next response', async () => {
  const env = setup();
  let calls = 0;
  env.api.storage.session.set = async () => { if (++calls === 1) throw new Error('temporarily unavailable'); };
  const details = { statusCode: 200, url: 'https://x.com/i/api/graphql/abcdefghij/HomeLatestTimeline' };
  env.api.webRequest.onCompleted.emit(details);
  await settle();
  env.api.webRequest.onCompleted.emit(details);
  await settle();
  assert.equal(calls, 2);
});

test('declarativeNetRequest dynamic rules include telemetry and ad blocks for x.com and twitter.com', async () => {
  const env = setup();
  await settle();
  assert.ok(env.dnrUpdates.length > 0);
  const latest = env.dnrUpdates.at(-1);
  const blockRules = latest.addRules.filter(r => r.action.type === 'block');
  const filters = blockRules.map(r => r.condition.urlFilter);
  assert.ok(filters.includes('analytics.x.com'));
  assert.ok(filters.includes('telemetry.x.com'));
  assert.ok(filters.includes('*.ads-x.com'));
  assert.ok(filters.includes('logs.x.com'));
  assert.ok(filters.includes('scribe.x.com'));
  assert.ok(filters.includes('x.com/i/api/1.1/jot/*'));
  assert.ok(filters.includes('twitter.com/i/api/1.1/jot/*'));
  assert.ok(filters.includes('x.com/i/api/1.1/branch/*'));
  assert.ok(filters.includes('twitter.com/i/api/1.1/branch/*'));
});

test('the static rule suppresses page scripts only on the dashboard document', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const ruleset = manifest.declarative_net_request.rule_resources.find(rule => rule.id === 'deck');
  assert.equal(ruleset.enabled, true);
  const [rule] = JSON.parse(readFileSync(new URL(`../${ruleset.path}`, import.meta.url)));
  const { regexFilter, resourceTypes, requestDomains } = rule.condition;
  const pathMatches = new RegExp(regexFilter);
  for (const url of [
    'https://x.com/yomikui/status/0',
    'https://www.twitter.com/yomikui/status/0/?foo=bar',
  ]) assert.match(url, pathMatches);
  for (const url of [
    'https://x.com/home',
    'https://x.com/yomikui/status/01',
    'https://x.com/yomikui/status/0/photo/1',
    'https://x.com/i/flow/login?next=/yomikui/status/0',
  ]) assert.doesNotMatch(url, pathMatches);
  assert.deepEqual(resourceTypes, ['main_frame']);
  assert.deepEqual(requestDomains, ['x.com', 'twitter.com']);
  assert.deepEqual(rule.action.responseHeaders, [
    { header: 'content-security-policy', operation: 'append', value: "script-src 'none'" },
  ]);

  const env = setup();
  await settle();
  const dynamicCsp = env.dnrUpdates.at(-1).addRules.find(candidate =>
    candidate.action.responseHeaders?.some(header => header.header.toLowerCase() === 'content-security-policy'));
  assert.ok(rule.priority > dynamicCsp.priority);
});

