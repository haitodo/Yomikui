import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, downloadEnvironment, media, settle } from './helpers.mjs';

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

test('video preference, filenames, and unknown transfer sizes retain their behavior', async () => {
  const env = downloadEnvironment();
  const requests = [];
  env.api.downloads.download = async options => { requests.push(options); return 1; };
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 100, totalBytes: 100 });
  env.manager.start({ ...media(), videos: [{ index: 0, url: 'https://video.twimg.com/video.mp4' }] }, 'batch');
  await settle();
  await env.clock.advance(0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].filename, 'Yomikui-videos/someone_123_v1.mp4');
  assert.equal(env.manager.items.get(1).filename, 'someone_123_v1.mp4');
  assert.equal(env.manager.items.get(1).totalBytes, -1);
  env.api.downloads.onChanged.emit({ id: 1, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  assert.equal(env.manager.items.get(1).error, 'USER_CANCELED');
});

test('images are saved under the Yomikui-images folder while keeping basename in progress items', async () => {
  const env = downloadEnvironment();
  const requests = [];
  env.api.downloads.download = async options => { requests.push(options); return requests.length; };
  env.snapshots.set(1, { state: 'complete', bytesReceived: 100, totalBytes: 100 });
  env.snapshots.set(2, { state: 'complete', bytesReceived: 200, totalBytes: 200 });
  env.manager.start(media(2), 'images');
  await settle();
  await env.clock.advance(0);
  assert.deepEqual(requests.map(r => r.filename), [
    'Yomikui-images/someone_123_1.jpg',
    'Yomikui-images/someone_123_2.jpg',
  ]);
  assert.deepEqual(env.sends.at(-1).message.items.map(item => item.filename), [
    'someone_123_1.jpg',
    'someone_123_2.jpg',
  ]);
});
