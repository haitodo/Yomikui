import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { browserEnvironment, Element, Events, evaluate, settle } from './helpers.mjs';

const URL_A = 'https://x.com/i/api/graphql/abcdefghij/HomeLatestTimeline';
const URL_B = 'https://x.com/i/api/graphql/klmnopqrst/SearchTimeline';

function mediaSetup() {
  const env = browserEnvironment();
  let clones = 0;
  let stringifies = 0;
  const response = { clone() { clones++; return { text: async () => '{"tweets":[]}' }; } };
  env.window.fetch = async () => response;
  class XHR extends Events {
    responseType = '';
    responseText = '{"tweets":[]}';
    open() {}
    send() {}
  }
  Object.assign(env.context, {
    XMLHttpRequest: XHR,
    location: { hash: '', pathname: '/home' },
    JSON: { stringify(value) { stringifies++; return JSON.stringify(value); } },
  });
  evaluate(env.context, 'mediaInterceptor.js');
  const discovered = [];
  const bodies = [];
  env.window.addEventListener('yomikui-query-id-discovered', event => discovered.push(event.detail));
  env.window.addEventListener('yomikui-media-response', event => bodies.push(event.detail));
  return { ...env, XHR, response, discovered, bodies, get clones() { return clones; }, get stringifies() { return stringifies; } };
}

test('Live Feed fetch discovers query IDs without cloning or decoding response bodies', async () => {
  const env = mediaSetup();
  env.window.__yomikuiLiveFeedMode = true;
  assert.equal(await env.window.fetch(URL_A), env.response);
  await settle();
  assert.equal(env.clones, 0);
  assert.equal(env.bodies.length, 0);
  assert.equal(env.discovered[0].operationName, 'HomeLatestTimeline');
});

test('ordinary fetch still publishes media responses and ignores unrelated requests', async () => {
  const env = mediaSetup();
  await env.window.fetch(URL_A);
  await settle();
  assert.equal(env.clones, 1);
  assert.equal(env.bodies[0].body, '{"tweets":[]}');
  await env.window.fetch('https://x.com/settings');
  assert.equal(env.clones, 1);
});

test('top-level pages leave native fetch and XHR untouched', () => {
  const env = browserEnvironment();
  env.window.top = env.window;
  const fetch = async () => {};
  env.window.fetch = fetch;
  evaluate(env.context, 'mediaInterceptor.js');
  assert.equal(env.window.fetch, fetch);
  assert.equal(env.window.__yomikuiMediaInterceptorInstalled, undefined);
});

test('reopened XHR uses one listener, reports its current URL, and ignores unrelated reuse', () => {
  const env = mediaSetup();
  const xhr = new env.XHR();
  xhr.open('GET', URL_A);
  xhr.send();
  xhr.emit('load');
  xhr.open('GET', new URL(URL_B));
  xhr.send();
  xhr.emit('load');
  assert.equal(xhr.listeners.get('load').length, 1);
  assert.equal(env.bodies.length, 2);
  assert.equal(env.bodies[1].url, URL_B);
  xhr.open('GET', 'https://x.com/settings');
  xhr.send();
  xhr.emit('load');
  assert.equal(env.bodies.length, 2);
});

test('Live Feed XHR skips both text reads and JSON serialization', () => {
  const env = mediaSetup();
  env.window.__yomikuiLiveFeedMode = true;
  const xhr = new env.XHR();
  xhr.open('GET', URL_A);
  xhr.send();
  Object.defineProperty(xhr, 'responseText', { get() { throw new Error('Body must not be read'); } });
  xhr.emit('load');
  xhr.responseType = 'json';
  xhr.response = { large: true };
  xhr.emit('load');
  assert.equal(env.discovered.length, 2);
  assert.equal(env.stringifies, 0);
});

function animation(id) {
  const svg = new Element('svg', { id });
  svg.appendChild(new Element('path', { d: 'M0 0 L1 1' }));
  return svg;
}

test('transaction bootstrap watches changed subtrees without rescanning the document', async () => {
  const env = browserEnvironment();
  const svg = env.document.body.appendChild(animation('loading-x-anim-0'));
  let clones = 0;
  const clone = svg.cloneNode.bind(svg);
  svg.cloneNode = deep => { clones++; return clone(deep); };
  const seen = [];
  const token = Buffer.from('valid-transaction-token-content').toString('base64');
  function generator(origin, path) {
    path.split('?')[0].trim();
    seen.push(env.document.getElementById('loading-x-anim-0'));
    return token;
  }
  function factory() { 'x-client-transaction-id'; return ''.split('?')[0].trim(); }
  const runtime = () => ({ generator });
  runtime.m = { bootstrap: factory };
  const chunks = [];
  chunks.push = chunk => { chunk[2](runtime); return 1; };
  env.window.webpackChunk_twitter_responsive_web = chunks;
  Object.assign(env.context, { crypto: { randomUUID }, atob });
  evaluate(env.context, 'xTransactionBridge.js');
  const queries = env.document.documentQueries;
  const observer = env.observers[0];
  const unrelated = env.document.body.appendChild(new Element('div'));
  observer.emit([{ target: env.document.body, addedNodes: [unrelated], removedNodes: [] }]);
  assert.equal(env.document.documentQueries, queries);
  assert.equal(clones, 1);
  observer.emit([
    { target: env.document.body, addedNodes: [svg], removedNodes: [] },
    { target: svg.children[0], addedNodes: [], removedNodes: [] },
  ]);
  assert.equal(clones, 2);
  svg.remove();
  observer.emit([{ target: env.document.body, addedNodes: [], removedNodes: [svg] }]);
  const responses = [];
  env.window.addEventListener('yomikui-x-transaction-response', event => responses.push(event.detail));
  env.window.emit('yomikui-x-transaction-request', {
    detail: { requestId: 'one', path: '/i/api/graphql/abcdefghij/CreateBookmark', method: 'POST' },
  });
  await settle();
  assert.equal(responses[0].token, token);
  assert.ok(seen[0]);
  assert.equal(env.document.getElementById('loading-x-anim-0'), null);
  env.document.emit('DOMContentLoaded');
  assert.equal(observer.connected, false);
});

test('a bridge injected after DOM readiness does not leave an observer running', () => {
  const env = browserEnvironment();
  env.document.readyState = 'complete';
  evaluate(env.context, 'xTransactionBridge.js');
  assert.equal(env.observers[0].connected, false);
});
