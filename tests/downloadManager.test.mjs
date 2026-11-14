import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { deferred, downloadEnvironment, evaluate, media, settle } from './helpers.mjs';

test('unchanged polls do not enumerate tabs or resend progress', async () => {
  const env = downloadEnvironment();
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 10, totalBytes: 100 });
  env.manager.start(media(), 'batch');
  await settle();
  await env.clock.advance(0);
  const tabQueries = env.tabQueries;
  const sent = env.sends.length;
  await env.clock.advance(1200);
  assert.equal(env.searches.length, 4);
  assert.equal(env.tabQueries, tabQueries);
  assert.equal(env.sends.length, sent);
});

test('slow polls never overlap, and stale snapshots cannot undo completion events', async () => {
  const env = downloadEnvironment();
  const first = deferred();
  let calls = 0;
  env.api.downloads.search = () => ++calls === 1 ? first.promise : Promise.resolve([{ state: 'complete', bytesReceived: 100, totalBytes: 100 }]);
  env.manager.start(media(), 'batch');
  await settle();
  await env.clock.advance(1200);
  assert.equal(calls, 1);
  env.api.downloads.onChanged.emit({ id: 1, state: { current: 'complete' } });
  first.resolve([{ state: 'in_progress', bytesReceived: 10, totalBytes: 100 }]);
  await settle();
  assert.equal(env.manager.items.get(1).state, 'complete');
  await env.clock.advance(0);
  assert.equal(calls, 2);
  assert.equal(env.manager.items.get(1).bytesReceived, 100);
  assert.equal(env.manager.pollTimer, null);
});

test('all changed batches share one tab lookup and duplicate events send nothing', async () => {
  const env = downloadEnvironment();
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 0 });
  env.snapshots.set(2, { state: 'in_progress', bytesReceived: 0 });
  env.manager.start(media(), 'a');
  env.manager.start(media(), 'b');
  await settle();
  await env.clock.advance(0);
  assert.equal(env.tabQueries, 1);
  assert.equal(env.sends.length, 4);
  env.api.downloads.onChanged.emit({ id: 1, bytesReceived: { current: 20 } });
  env.api.downloads.onChanged.emit({ id: 2, bytesReceived: { current: 30 } });
  await env.clock.advance(0);
  assert.equal(env.tabQueries, 2);
  env.api.downloads.onChanged.emit({ id: 1, bytesReceived: { current: 20 } });
  await env.clock.advance(0);
  assert.equal(env.tabQueries, 2);
});

test('completed and failed batches are evicted even when no further downloads occur', async () => {
  const env = downloadEnvironment();
  env.snapshots.set(1, { state: 'complete', bytesReceived: 100, totalBytes: 100 });
  env.manager.start(media(), 'complete');
  env.manager.start({ ...media(), images: [] }, 'empty');
  env.manager.start({ ...media(), images: [{ index: 0, url: 'https://untrusted.example/image.jpg' }] }, 'blocked');
  await settle();
  await env.clock.advance(0);
  assert.equal(env.manager.batches.size, 3);
  await env.clock.advance(5000);
  assert.equal(env.manager.batches.size, 0);
  assert.equal(env.manager.items.size, 0);
  assert.equal(env.manager.activeIds.size, 0);
  assert.equal(env.clock.timers.size, 0);
});

test('a delayed second start is not mistaken for a finished batch', async () => {
  const env = downloadEnvironment();
  const second = deferred();
  let calls = 0;
  env.api.downloads.download = () => ++calls === 1 ? Promise.resolve(1) : second.promise;
  env.snapshots.set(1, { state: 'complete', bytesReceived: 100, totalBytes: 100 });
  env.manager.start(media(2), 'batch');
  await settle();
  await env.clock.advance(6000);
  assert.equal(env.manager.batches.get('batch').pendingStarts, 1);
  second.resolve(2);
  env.snapshots.set(2, { state: 'complete', bytesReceived: 200, totalBytes: 200 });
  await settle();
  await env.clock.advance(0);
  assert.equal(env.sends.at(-1).message.items.length, 2);
  assert.ok(env.sends.at(-1).message.items.every(item => item.state === 'complete'));
  await env.clock.advance(5000);
  assert.equal(env.manager.items.size, 0);
});

test('progress during a slow broadcast is delivered afterward without concurrent tab lookups', async () => {
  const env = downloadEnvironment();
  const first = deferred();
  let lookups = 0;
  env.api.tabs.query = () => ++lookups === 1 ? first.promise : Promise.resolve([{ id: 1 }]);
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 0 });
  env.manager.start(media(), 'batch');
  await settle();
  await env.clock.advance(0);
  env.api.downloads.onChanged.emit({ id: 1, bytesReceived: { current: 20 } });
  await env.clock.advance(0);
  assert.equal(lookups, 1);
  first.resolve([{ id: 1 }]);
  await settle();
  await env.clock.advance(0);
  assert.equal(lookups, 2);
  assert.equal(env.sends.at(-1).message.items[0].bytesReceived, 20);
});

test('download start failures are reported and released', async () => {
  const env = downloadEnvironment();
  env.api.downloads.download = async () => { throw new Error('NETWORK_FAILED'); };
  env.manager.start(media(), 'batch');
  await settle();
  await env.clock.advance(0);
  assert.match(env.sends[0].message.items[0].error, /NETWORK_FAILED/);
  await env.clock.advance(5000);
  assert.equal(env.manager.items.size, 0);
});

test('downloads removed from browser history do not keep the polling worker alive', async () => {
  const env = downloadEnvironment();
  env.manager.start(media(), 'removed');
  await settle();
  await env.clock.advance(0);
  assert.equal(env.manager.items.get(1).error, 'DOWNLOAD_NOT_FOUND');
  assert.equal(env.manager.activeIds.size, 0);
  assert.equal(env.manager.batches.get('removed').activeCount, 0);
  await env.clock.advance(5000);
  assert.equal(env.clock.timers.size, 0);
  assert.equal(env.manager.items.size, 0);
});

test('videos use the original publication date even when the timeline entry ID differs', async () => {
  const env = downloadEnvironment();
  const requests = [];
  env.api.downloads.download = async options => { requests.push(options); return 1; };
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 100, totalBytes: 100 });
  env.manager.start({
    ...media(),
    tweetId: '1990000000000000000',
    tweetCreatedAt: new Date(2024, 3, 9, 0, 1).getTime(),
    videos: [{ index: 0, url: 'https://video.twimg.com/video.mp4' }],
  }, 'batch');
  await settle();
  await env.clock.advance(0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].filename, 'Yomikui-videos/2024-04-09/someone_1990000000000000000_v1.mp4');
  assert.equal(env.manager.items.get(1).filename, 'someone_1990000000000000000_v1.mp4');
  assert.equal(env.manager.items.get(1).totalBytes, -1);
  env.api.downloads.onChanged.emit({ id: 1, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  assert.equal(env.manager.items.get(1).error, 'USER_CANCELED');
});

test('images use each source post date and keep basenames in progress items', async () => {
  const env = downloadEnvironment();
  const requests = [];
  env.api.downloads.download = async options => { requests.push(options); return requests.length; };
  env.snapshots.set(1, { state: 'complete', bytesReceived: 100, totalBytes: 100 });
  env.snapshots.set(2, { state: 'complete', bytesReceived: 200, totalBytes: 200 });
  env.snapshots.set(3, { state: 'complete', bytesReceived: 300, totalBytes: 300 });
  const request = { ...media(3), tweetCreatedAt: new Date(2025, 10, 6, 23, 59).getTime() };
  request.images[1].sourcePost = { tweetId: '456', tweetCreatedAt: new Date(2024, 0, 8, 12).getTime() };
  request.images[2].sourcePost = { tweetId: '456' };
  env.manager.start(request, 'images');
  await settle();
  await env.clock.advance(0);
  assert.deepEqual(requests.map(r => r.filename), [
    'Yomikui-images/2025-11-06/someone_123_1.jpg',
    'Yomikui-images/2024-01-08/someone_123_2.jpg',
    'Yomikui-images/unknown-date/someone_123_3.jpg',
  ]);
  assert.deepEqual(env.sends.at(-1).message.items.map(item => item.filename), [
    'someone_123_1.jpg',
    'someone_123_2.jpg',
    'someone_123_3.jpg',
  ]);
});

test('the original post ID is a fallback when only the ID is available', async () => {
  const env = downloadEnvironment();
  const requests = [];
  env.api.downloads.download = async options => { requests.push(options); return requests.length; };
  // This ID encodes 2024-11-04T15:00:00.000Z, exactly midnight on November 5 in Japan.
  const sourceTweetId = '1853452138705846273';
  const localDate = new Date('2024-11-04T15:00:00Z');
  const expectedDay = localDate.getDate() === 4 ? '04' : '05';
  env.manager.start({ ...media(), tweetId: '1990000000000000000', sourceTweetId }, 'snowflake');
  env.manager.start({ ...media(), tweetId: '29000000000', tweetCreatedAt: NaN }, 'legacy');
  await settle();
  assert.deepEqual(requests.map(r => r.filename), [
    `Yomikui-images/2024-11-${expectedDay}/someone_1990000000000000000_1.jpg`,
    'Yomikui-images/unknown-date/someone_29000000000_1.jpg',
  ]);
});

test('native download clicks use timeline or DOM dates and keep quoted media on its own date', async () => {
  const env = downloadEnvironment();
  const { context, api, manager } = env;
  const requested = [];
  api.downloads.download = async options => { requested.push(options.filename); return requested.length; };
  evaluate(context, 'tweetActions.js');
  context.crypto = { randomUUID: () => 'batch' };
  context.window.parent.postMessage = ({ media, batchId }) => manager.start(media, batchId);

  const frame = readFileSync(new URL('../contentIframe.js', import.meta.url), 'utf8');
  const section = (from, to) => {
    const start = frame.indexOf(from);
    const end = frame.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start);
    return frame.slice(start, end);
  };
  vm.runInContext([
    section('function Yd(e){', 'function PD(e){'),
    section('function hX(e){', 'var Ri="yomikui-download-btn"'),
    section('var Ri="yomikui-download-btn"', 'function AX(e,t){'),
    'globalThis.cacheTimelinePost = result => kH(wH(result)); globalThis.clickDownload = EX;',
    'globalThis.Tr = url => url; globalThis.Le = () => "https://x.com";',
  ].join('\n'), context);

  const authorDate = new Date(2025, 10, 6, 0, 1).toISOString();
  const quoteDate = new Date(2024, 0, 8, 12).toISOString();
  const image = name => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${name}.jpg` });
  const quoted = { legacy: { id_str: '456', created_at: quoteDate, extended_entities: { media: [image('quoted')] } } };
  const result = {
    core: { user_results: { result: { core: { screen_name: 'author' } } } },
    legacy: { id_str: '123', created_at: authorDate, extended_entities: { media: [image('direct')] } },
    quoted_status_result: { result: quoted },
  };
  const { document } = parseHTML(`<article>
    <div role="link" data-testid="quoteTweet">
      <a href="/quoted/status/456/photo/1"><img src="https://pbs.twimg.com/media/quoted.jpg"></a>
      <a href="/quoted/status/456"><time datetime="${quoteDate}"></time></a>
    </div>
    <a href="/author/status/123"><time datetime="${authorDate}"></time></a>
    <a href="/author/status/123/photo/1"><img src="https://pbs.twimg.com/media/direct.jpg"></a>
    <button class="yomikui-download-btn" data-tweet-id="123" data-screen-name="author"></button>
  </article>`);
  const button = document.querySelector('button');
  const click = () => context.clickDownload({ target: button, stopPropagation() {}, preventDefault() {} });
  click();
  await env.clock.advance(1500);
  context.cacheTimelinePost(result);
  click();
  await settle();
  assert.deepEqual(requested, [
    'Yomikui-images/2024-01-08/author_123_1.jpg',
    'Yomikui-images/2025-11-06/author_123_2.jpg',
    'Yomikui-images/2025-11-06/author_123_1.jpg',
    'Yomikui-images/2024-01-08/author_123_2.jpg',
  ]);
});
