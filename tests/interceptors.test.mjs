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

