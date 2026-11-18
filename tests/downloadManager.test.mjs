import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { browserEnvironment, deferred, downloadEnvironment, evaluate, Events, media, settle } from './helpers.mjs';

const deck = readFileSync(new URL('../contentDeck.js', import.meta.url), 'utf8');

function deckSection(from, to) {
  const start = deck.indexOf(from);
  const end = deck.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start);
  return deck.slice(start, end);
}

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
  const search = env.api.downloads.search;
  env.api.downloads.search = query => {
    if (query.id === undefined) return search(query);
    return ++calls === 1 ? first.promise : Promise.resolve([{ state: 'complete', bytesReceived: 100, totalBytes: 100 }]);
  };
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

test('video progress advances with unknown size and reports the browser choosing a destination', async () => {
  const env = downloadEnvironment();
  const video = { ...media(), videos: [{ index: 0, url: 'https://video.twimg.com/video.mp4' }] };
  const lastItem = () => env.sends.at(-1).message.items[0];
  env.snapshots.set(1, { state: 'in_progress', filename: '', bytesReceived: 0, totalBytes: -1 });
  await env.manager.start(video, 'video');
  await env.clock.advance(0);
  assert.equal(lastItem().awaitingTarget, true);

  const filename = '/downloads/Yomikui-videos/unknown-date/someone_123_v1.mp4';
  env.api.downloads.onChanged.emit({ id: 1, filename: { current: filename } });
  await env.clock.advance(0);
  assert.equal(lastItem().awaitingTarget, false);
  env.snapshots.set(1, { state: 'in_progress', filename, bytesReceived: 50, totalBytes: -1 });
  await env.clock.advance(400);
  assert.equal(lastItem().totalBytes, -1);
  assert.equal(lastItem().bytesReceived, 50);

  env.snapshots.set(1, { state: 'in_progress', filename, bytesReceived: 100, totalBytes: 100 });
  await env.clock.advance(400);
  assert.equal(lastItem().state, 'in_progress');
  assert.equal(lastItem().totalBytes, 100);

  env.snapshots.set(1, { state: 'complete', filename, bytesReceived: 100, totalBytes: 100 });
  env.api.downloads.onChanged.emit({ id: 1, state: { current: 'complete' } });
  await env.clock.advance(0);
  assert.equal(lastItem().state, 'complete');
});

test('the shipped dashboard keeps unknown-size progress animated and distinguishes save stages', async () => {
  const { context } = browserEnvironment();
  const { document, window } = parseHTML('<html><head><title>X</title></head><body></body></html>');
  Object.assign(context, {
    document, MutationObserver: window.MutationObserver,
    P4: 'Yomikui', owe() {}, Hee: '', chrome: { runtime: { getURL: url => url } },
  });
  vm.runInContext([
    deckSection('function Pve(', 'var Ove=({batch:'),
    deckSection('function swe(){', 'function lwe(){'),
  ].join('\n'), context);

  const maintenance = context.swe();
  try {
    const unknown = { state: 'in_progress', bytesReceived: 50, totalBytes: -1 };
    assert.equal(context.activeDownloadLabel([]), 'download_toast_preparing');
    assert.equal(context.activeDownloadLabel([{ ...unknown, awaitingTarget: true }]), 'download_toast_waiting_for_path');
    assert.equal(context.activeDownloadLabel([unknown]), 'download_toast_downloading');
    assert.equal(context.Pve([unknown]).percent, undefined);
    const saving = [{ ...unknown, totalBytes: 50 }];
    assert.equal(context.Pve(saving).percent, 99);
    assert.equal(context.activeDownloadLabel(saving), 'download_toast_waiting_for_save');
    const inaccurate = [{ ...unknown, totalBytes: 10 }];
    assert.equal(context.Pve(inaccurate).percent, undefined);
    assert.equal(context.activeDownloadLabel(inaccurate), 'download_toast_downloading');

    document.head.appendChild(document.createElement('meta'));
    await settle();
    assert.match(document.getElementById('yomikui-styles').textContent, /@keyframes download-indeterminate/);
  } finally {
    maintenance.headObserver.disconnect();
    maintenance.titleObserver?.disconnect();
  }
});

test('the dashboard retains simultaneous preparations and lets a failed request be retried', async () => {
  const { context } = browserEnvironment();
  const state = { downloadBatches: [] };
  const requests = [];
  const first = deferred();
  const second = deferred();
  Object.assign(context, {
    state,
    e: change => change(state),
    Ut: { getState: () => state },
    crypto: { randomUUID: () => 'retry' },
    chrome: { runtime: { sendMessage: async request => {
      requests.push(request);
      return request.batchId === 'first' ? first.promise : second.promise;
    } } },
  });
  vm.runInContext([
    'Object.assign(state, {' + deckSection('cacheDownloadRequest(c,d){', ',setTheme(c){') + '});',
    deckSection('async function requestMediaDownload(', 'var eK=()'),
  ].join('\n'), context);
  const batch = id => state.downloadBatches.find(item => item.batchId === id);

  const request = media();
  const firstRequest = context.requestMediaDownload(request, 'first');
  const secondRequest = context.requestMediaDownload(request, 'second');
  first.reject(new Error('message channel closed'));
  await firstRequest;
  assert.equal(batch('first').items[0].state, 'interrupted');
  assert.equal(batch('second').items.length, 0);
  context.Uve(batch('first'));
  assert.equal(batch('first'), undefined);
  assert.equal(requests.at(-1).batchId, 'retry');
  assert.equal(requests.at(-1).media, request);

  state.upsertDownloadBatch({ batchId: 'second', items: [{ state: 'in_progress' }] });
  second.reject(new Error('reply channel closed after progress arrived'));
  await secondRequest;
  await settle();
  assert.equal(batch('second').items[0].state, 'in_progress');
  assert.equal(batch('retry').items[0].state, 'interrupted');
});

test('all changed batches share one tab lookup and duplicate events send nothing', async () => {
  const env = downloadEnvironment();
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 0 });
  env.snapshots.set(2, { state: 'in_progress', bytesReceived: 0 });
  env.manager.start(media(), 'a');
  env.manager.start({ ...media(), tweetId: '456' }, 'b');
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

test('a batch skips existing and active paths while downloading interrupted or missing files', async () => {
  const env = downloadEnvironment();
  const requests = [];
  env.api.downloads.download = async options => { requests.push(options); return requests.length; };
  const folder = 'Yomikui-images/2026-11-14';
  const history = (index, state, exists) => ({
    filename: String.raw`C:\Users\local\Downloads\YOMIKUI-images\2026-11-14\Someone_123_${index}.jpg`,
    state,
    exists,
  });
  env.history.push(history(1, 'complete', true), history(2, 'interrupted', true),
    history(3, 'complete', false), history(4, 'in_progress', false), {
      filename: '/home/local/Downloads/Yomikui-images/2026-11-13/someone_123_5.jpg',
      state: 'complete',
      exists: true,
    });
  for (const id of [1, 2, 3]) env.snapshots.set(id, { state: 'complete', bytesReceived: 100, totalBytes: 100 });
  env.manager.start({ ...media(5), tweetCreatedAt: new Date(2026, 10, 14, 12).getTime() }, 'mixed');
  await settle();
  await env.clock.advance(1000);
  assert.deepEqual(requests.map(({ filename, conflictAction }) => [filename, conflictAction]), [
    [folder + '/someone_123_2.jpg', 'prompt'],
    [folder + '/someone_123_3.jpg', 'prompt'],
    [folder + '/someone_123_5.jpg', 'prompt'],
  ]);
  assert.deepEqual(env.sends.at(-1).message.items.filter(item => item.state === 'skipped').map(item => item.filename).sort(),
    ['someone_123_1.jpg', 'someone_123_4.jpg']);
});

test('a newly removed file can be saved again after the browser refreshes its history', async () => {
  const env = downloadEnvironment();
  const saved = { filename: '/downloads/Yomikui-images/unknown-date/someone_123_1.jpg', state: 'complete', exists: true };
  env.history.push(saved);
  let starts = 0;
  env.api.downloads.download = async () => ++starts;
  env.manager.start(media(), 'deleted');
  await settle();
  assert.equal(starts, 0);
  saved.exists = false;
  await env.clock.advance(1000);
  assert.equal(starts, 1);
});

test('rapid requests share a destination reservation and can retry after interruption', async () => {
  const env = downloadEnvironment();
  const first = deferred();
  let starts = 0;
  env.api.downloads.download = () => ++starts === 1 ? first.promise : Promise.resolve(2);
  env.snapshots.set(1, { state: 'in_progress', bytesReceived: 10, totalBytes: 100 });
  env.snapshots.set(2, { state: 'complete', bytesReceived: 100, totalBytes: 100 });

  env.manager.start(media(), 'first');
  env.manager.start(media(), 'second');
  await settle();
  await env.clock.advance(0);
  assert.equal(starts, 1);
  assert.equal(env.sends.find(({ message }) => message.batchId === 'second').message.items[0].state, 'skipped');

  first.resolve(1);
  await settle();
  await env.clock.advance(0);
  env.manager.start(media(), 'during');
  await env.clock.advance(0);
  assert.equal(starts, 1);

  env.snapshots.set(1, { state: 'interrupted', error: 'NETWORK_FAILED' });
  env.api.downloads.onChanged.emit({ id: 1, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  env.manager.start(media(), 'retry');
  await settle();
  await env.clock.advance(0);
  assert.equal(starts, 2);
  assert.equal(env.sends.findLast(({ message }) => message.batchId === 'retry').message.items[0].state, 'complete');
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
  assert.equal(env.manager.items.get(1).totalBytes, 100);
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
  evaluate(context, 'mediaViewerDownload.js');
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

const viewerPost = '/miyakawa_miyabi/status/2121528516672180724';
const viewerButton = '.yomikui-media-viewer-download';

function mediaViewerTest({ pathname, topLevel }) {
  const env = downloadEnvironment();
  const { context, window, api, manager } = env;
  const { document, Event } = parseHTML('<html><head></head><body></body></html>');
  window.navigation = new Events();
  if (topLevel) window.top = window;
  const downloads = [];
  api.downloads.download = async options => { downloads.push(options); return downloads.length; };
  Object.assign(context, {
    document,
    location: { pathname },
    chrome: {
      i18n: { getMessage: () => 'メディアを保存' },
      runtime: { sendMessage: async message => {
        assert.equal(message.type, 'yomikui-download-media');
        await manager.start(message.media, message.batchId);
        return { success: true };
      } },
    },
    crypto: { randomUUID: () => 'viewer-batch' },
  });
  for (const file of ['tweetActions.js', 'mediaPipFrame.js', 'mediaViewerDownload.js']) evaluate(context, file);

  function click(button) {
    const event = new Event('click', { bubbles: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    button.dispatchEvent(event);
  }

  function navigate(path) {
    context.location.pathname = path;
    window.navigation.emit('currententrychange');
  }

  return { ...env, document, downloads, click, navigate };
}

test('a direct X photo URL saves the open image at original size and follows the selected slide', async () => {
  const env = mediaViewerTest({ pathname: viewerPost + '/photo/1', topLevel: true });
  const { document, downloads } = env;
  const observer = env.observers[0];
  assert.equal(observer.target, document);
  const date = new Date(2026, 10, 14, 12).toISOString();
  document.body.innerHTML = `
    <div id="react-root">
      <article><img src="https://pbs.twimg.com/media/background.jpg"></article>
      <div id="layers">
        <div role="dialog"><div role="group"><div role="dialog" id="viewer">
          <div data-testid="swipe-to-dismiss" id="first">
            <img src="https://pbs.twimg.com/media/first?format=jpg&amp;name=large">
          </div>
          <article><a href="${viewerPost}"><time datetime="${date}"></time></a>
            <img src="https://pbs.twimg.com/media/thumbnail.jpg">
          </article>
        </div></div></div>
      </div>
    </div>`;
  observer.emit([]);
  assert.equal(observer.target, document.getElementById('react-root'));
  const button = document.querySelector('#viewer > ' + viewerButton);
  assert.equal(button.getAttribute('aria-label'), 'メディアを保存');
  assert.equal(button.type, 'button');
  env.click(button);
  await settle();

  env.navigate(viewerPost + '/photo/2');
  assert.equal(button.disabled, true);
  env.click(button);
  const second = document.createElement('div');
  second.setAttribute('data-testid', 'swipe-to-dismiss');
  second.innerHTML = '<img src="https://pbs.twimg.com/media/second.png?name=small">';
  button.parentElement.append(second);
  observer.emit([]);
  assert.equal(button.disabled, true);
  env.click(button);
  document.getElementById('first').remove();
  observer.emit([]);
  assert.equal(button.disabled, false);
  assert.equal(document.querySelectorAll(viewerButton).length, 1);
  env.click(button);
  await settle();
  assert.deepEqual(downloads.map(({ url, filename }) => ({ url, filename })), [
    {
      url: 'https://pbs.twimg.com/media/first?format=jpg&name=orig',
      filename: 'Yomikui-images/2026-11-14/miyakawa_miyabi_2121528516672180724_1.jpg',
    },
    {
      url: 'https://pbs.twimg.com/media/second?name=orig&format=png',
      filename: 'Yomikui-images/2026-11-14/miyakawa_miyabi_2121528516672180724_2.png',
    },
  ]);

  env.navigate(viewerPost);
  assert.equal(observer.connected, false);
  assert.equal(document.querySelector(viewerButton), null);
  env.navigate(viewerPost + '/photo/2');
  assert.equal(document.querySelector(viewerButton), button);
});

test('a narrow column saves the photo in main and moves the button when X switches layouts', async () => {
  const postPath = '/misonokyoko/status/2118477742111133714';
  const env = mediaViewerTest({ pathname: postPath + '/photo/1', topLevel: false });
  const { document, context, manager, downloads } = env;
  document.body.innerHTML = `
    <div id="react-root">
      <div id="layers"></div>
      <main role="main"></main>
    </div>`;
  context.YomikuiMediaViewerDownload.install({ download: media => manager.start(media, 'narrow') });
  const observer = env.observers[0];
  const main = document.querySelector('main');
  main.innerHTML = `
    <div data-testid="swipe-to-dismiss">
      <img src="https://pbs.twimg.com/media/narrow?format=jpg&amp;name=large">
    </div>`;
  observer.emit([]);

  const button = main.querySelector(viewerButton);
  assert.ok(button);
  env.click(button);
  await settle();
  assert.equal(downloads[0].url, 'https://pbs.twimg.com/media/narrow?format=jpg&name=orig');
  assert.match(downloads[0].filename, /\/misonokyoko_2118477742111133714_1\.jpg$/);

  const layers = document.getElementById('layers');
  layers.innerHTML = '<div role="dialog"></div>';
  layers.firstElementChild.append(main.querySelector('[data-testid="swipe-to-dismiss"]'));
  observer.emit([]);
  assert.equal(button.parentElement, layers.firstElementChild);
  assert.equal(document.querySelectorAll(viewerButton).length, 1);

  env.navigate(postPath);
  assert.equal(observer.connected, false);
  assert.equal(document.querySelector(viewerButton), null);
});

test('the dashboard viewer saves the selected photo with its original attachment number', async () => {
  const env = mediaViewerTest({ pathname: '/home', topLevel: false });
  const { context, document, downloads, manager } = env;
  const tweetCreatedAt = new Date(2026, 10, 14, 12).getTime();
  context.Qb = () => ({ tweetCreatedAt });
  context.Le = () => 'https://x.com';
  evaluate(context, 'contentIframe.js', source => {
    const start = source.indexOf('function Tr(url) {');
    const end = source.indexOf('var dS=', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  });
  document.body.innerHTML = `
    <article data-testid="tweet">
      <a role="link" href="${viewerPost}/photo/1"><div data-testid="tweetPhoto">
        <img src="https://pbs.twimg.com/media/first?format=jpg&amp;name=small">
      </div></a>
      <a role="link" href="${viewerPost}/photo/3"><div id="third" data-testid="tweetPhoto">
        <img src="https://pbs.twimg.com/media/third?format=jpg&amp;name=small">
      </div></a>
    </article>`;
  const event = { button: 0, preventDefault() {}, stopPropagation() {} };
  assert.equal(context.uS(event, document.getElementById('third'), {
    isEnabled: () => true, getColumnId: () => 'home',
  }), true);

  const handleOpen = deckSection(
    'if((c||ae.data?.force||mediaPip.isOpen())&&ae.data?.type==="yomikui-open-media"',
    'if(ae.data?.type==="yomikui-account-switch-selected"',
  );
  const receive = vm.runInContext(`(ae, me) => {
    const c = true, zt = {}, xt = {};
    const mediaPip = { show: () => false };
    const je = () => {}, sn = () => {}, rt = () => {};
    ${handleOpen}
  }`, context);
  const { OverlayButton } = context.YomikuiMediaViewerDownload;
  const jsx = { jsx: (type, props) => ({ type, props }) };
  receive({ data: env.messages[0] }, (index, gallery) => {
    assert.equal(index, 1);
    const renderButton = item => OverlayButton({
      jsx, item, label: 'メディアを保存',
      onDownload: media => manager.start(media, 'overlay'),
    });
    const button = renderButton(gallery[index]);
    assert.equal(button.props['aria-label'], 'メディアを保存');
    button.props.onClick(event);
    renderButton(gallery[0]).props.onClick(event);
  });
  await settle();
  assert.deepEqual(downloads.map(({ url, filename }) => ({ url, filename })), [
    {
      url: 'https://pbs.twimg.com/media/third?format=jpg&name=orig',
      filename: 'Yomikui-images/2026-11-14/miyakawa_miyabi_2121528516672180724_3.jpg',
    },
    {
      url: 'https://pbs.twimg.com/media/first?format=jpg&name=orig',
      filename: 'Yomikui-images/2026-11-14/miyakawa_miyabi_2121528516672180724_1.jpg',
    },
  ]);
});

test('the native media viewer in a column uses the cached video and follows column visibility', async () => {
  const env = mediaViewerTest({ pathname: viewerPost + '/video/2', topLevel: false });
  const { document, context, window, manager, downloads } = env;
  document.body.innerHTML = '<div id="layers"><div role="dialog"><div data-testid="swipe-to-dismiss"><video></video></div></div></div>';
  const video = document.querySelector('video');
  video.src = 'blob:https://x.com/player';
  video.poster = 'https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg';
  const mp4 = 'https://video.twimg.com/amplify_video/123/vid/movie.mp4';
  const date = new Date(2026, 10, 14, 12).getTime();
  const cached = { videos: [{ url: mp4, index: 0 }], tweetCreatedAt: date };
  let visible = true;
  context.YomikuiMediaViewerDownload.install({
    isVisible: () => visible,
    getCachedMedia: () => cached,
    download: media => manager.start(media, 'video'),
  });
  assert.equal(document.querySelector(viewerButton), null);
  context.YomikuiMediaPipFrame.rememberVideo(video.poster, mp4, 'video');
  window.emit('yomikui-media-response');
  env.click(document.querySelector(viewerButton));
  await settle();
  assert.equal(downloads[0].url, mp4);
  assert.equal(downloads[0].filename, 'Yomikui-videos/2026-11-14/miyakawa_miyabi_2121528516672180724_v1.mp4');

  visible = false;
  window.emit('yomikui-frame-column-visibility');
  assert.equal(document.querySelector(viewerButton), null);
  assert.equal(env.observers[0].connected, false);
});
