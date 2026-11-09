import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { Clock, deferred, Events, settle } from './helpers.mjs';

const pipSource = readFileSync(new URL('../mediaPip.js', import.meta.url), 'utf8');
const frameSource = readFileSync(new URL('../mediaPipFrame.js', import.meta.url), 'utf8');
const frameBundle = readFileSync(new URL('../contentIframe.js', import.meta.url), 'utf8');
const photo = name => ({ type: 'photo', src: `https://pbs.twimg.com/media/${name}.jpg` });
const poster = 'https://pbs.twimg.com/ext_tw_video_thumb/123/img/poster.jpg';
const videoUrl = 'https://video.twimg.com/ext_tw_video/123/vid/test.mp4';
const xOrigin = 'https://x.com';

function deck({ fetch, play = () => Promise.resolve() }) {
  const { document } = parseHTML('<html><head></head><body></body></html>');
  const pip = Object.assign(new Events(), { document, closed: false, close() { this.closed = true; this.emit('pagehide'); } });
  const createElement = document.createElement.bind(document);
  document.createElement = (tag, options) => {
    const element = createElement(tag, options);
    if (tag === 'img') element.decode = async () => {};
    if (tag === 'video') Object.assign(element, { play, pause() { this.paused = true; }, load() {} });
    return element;
  };
  const released = [], sessions = [], clock = new Clock();
  let requests = 0;
  const window = { documentPictureInPicture: { async requestWindow() { requests++; return pip; } } };
  const globals = {
    ...clock.globals(), window, fetch, console, AbortController, crypto: { randomUUID: () => 'session' },
    URL: class extends URL {
      static createObjectURL(blob) { return `blob:${blob}`; }
      static revokeObjectURL(url) { released.push(url); }
    },
  };
  const context = vm.createContext(globals);
  vm.runInContext(pipSource, context);
  const controller = context.YomikuiMediaPip.create({
    photoUrl: src => src, getMuted: () => true, setMuted() {}, onSessionChange: session => sessions.push(session),
  });
  return { clock, document, pip, controller, sessions, released, requests: () => requests };
}

test('the same window follows gallery selection and ignores a slower, superseded image', async () => {
  const first = deferred();
  const env = deck({ fetch: src => src.includes('first') ? first.promise : Promise.resolve({ ok: true, blob: async () => src }) });
  const { controller, document, pip } = env;
  assert.equal(await controller.open(), true);
  assert.equal(await controller.open(), false);
  const items = [photo('first'), photo('second'), photo('third')];
  assert.equal(controller.show(items, 0), true);
  assert.equal(controller.show(items, 1), true);
  await settle();
  first.resolve({ ok: true, blob: async () => 'old-image' });
  await settle();
  assert.equal(document.querySelector('img').getAttribute('src'), `blob:${items[1].src}`);
  assert.equal(document.querySelector('footer span').textContent, '2 / 3');
  document.querySelector('[aria-label="次のメディア"]').click();
  await settle();
  assert.equal(document.querySelector('img').getAttribute('src'), `blob:${items[2].src}`);
  pip.close();
  assert.equal(controller.show(items, 0), false);
  assert.equal(env.requests(), 1);
  assert.deepEqual(env.sessions, ['session', null]);
  assert.deepEqual(env.released, [`blob:${items[1].src}`, `blob:${items[2].src}`]);
});

test('a column is asked to pause only after PiP playback starts, and switching to a photo stops PiP playback', async () => {
  const playing = deferred();
  const { controller, document, clock } = deck({ play: () => playing.promise, fetch: async () => ({ ok: true, blob: async () => 'image' }) });
  await controller.open();
  const frame = {}, frames = new Map([['column', frame]]), messages = [];
  const port = { postMessage: data => messages.push(data), close() { this.closed = true; } };
  const data = { session: 'session', columnId: 'column', at: 0, media: { type: 'video', src: videoUrl }, playback: { muted: false, volume: .5, rate: 1.5 } };
  controller.handlePlay({ origin: xOrigin, source: frame, ports: [port], data }, frames);
  const video = document.querySelector('video');
  assert.equal(video.muted, true);
  assert.deepEqual(messages, []);
  playing.resolve();
  await settle();
  assert.deepEqual(messages, ['pause']);
  assert.equal(video.muted, true);
  port.onmessage({ data: 'paused' });
  await settle();
  assert.equal(video.muted, false);
  assert.equal(video.volume, .5);
  assert.equal(video.playbackRate, 1.5);
  await clock.advance(1);
  controller.show([photo('newer')], 0);
  assert.equal(video.paused, true);
  assert.equal(video.hasAttribute('src'), false);
  const late = { close() { this.closed = true; } };
  controller.handlePlay({ origin: xOrigin, source: frame, ports: [late], data }, frames);
  await settle();
  assert.equal(late.closed, true);
  assert.ok(document.querySelector('img'));
});

test('a failed PiP play request leaves the original column playing', async () => {
  const { controller, document } = deck({ play: () => Promise.reject(new Error('load failed')) });
  await controller.open();
  const frame = {};
  let paused = false;
  const port = { postMessage() { paused = true; }, close() {} };
  const data = { session: 'session', columnId: 'column', at: 0, media: { type: 'video', src: videoUrl } };
  controller.handlePlay({ origin: xOrigin, source: frame, ports: [port], data }, new Map([['column', frame]]));
  await settle();
  assert.equal(paused, false);
  assert.equal(document.querySelector('video'), null);
});

function nativeFrame() {
  const { document: dom } = parseHTML(`<article>
    <div data-testid="previewInterstitial"><img src="${poster.split('.jpg')[0]}?format=jpg"><button data-testid="playButton"></button></div>
    <div data-testid="videoPlayer"><video></video></div>
  </article>`);
  const video = dom.querySelector('video');
  Object.assign(video, { poster, currentSrc: 'blob:https://x.com/native', currentTime: 1.5, muted: false, volume: .8, playbackRate: 1 });
  let paused = false;
  video.pause = () => { paused = true; };
  const clock = new Clock(), document = new Events(), window = new Events(), sent = [];
  document.getElementById = id => dom.getElementById(id);
  window.parent = { postMessage: (data, origin, ports) => sent.push({ data, origin, ports }) };
  const channel = { port1: { postMessage() {}, close() {} }, port2: {} };
  const context = vm.createContext({ ...clock.globals(), window, document, URL, MessageChannel: function () { return channel; } });
  vm.runInContext(frameSource, context);
  const api = context.YomikuiMediaPipFrame;
  api.install({ getColumnId: () => 'column', isVisible: () => true });
  const state = { type: 'yomikui-media-pip-state', session: 'session' };
  return { api, context, document, window, sent, channel, state, video, button: dom.querySelector('button'), paused: () => paused };
}

test('the frame pairs a manual preview click with its replacement player and skips autoplay', () => {
  const { api, document, window, sent, channel, state, video, button, paused } = nativeFrame();
  api.rememberVideo(poster, videoUrl, 'video');
  window.emit('message', { source: {}, origin: xOrigin, data: state });
  assert.equal(api.isOpen(), false);
  window.emit('message', { source: window.parent, origin: xOrigin, data: state });
  document.emit('play', { target: video, isTrusted: true });
  assert.equal(sent.length, 0);
  document.emit('click', { target: button, button: 0, isTrusted: true });
  document.emit('play', { target: video, isTrusted: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.media.src, videoUrl);
  assert.equal(sent[0].data.playback.time, 1.5);
  assert.equal(sent[0].ports[0], channel.port2);
  channel.port1.onmessage({ data: 'pause' });
  assert.equal(paused(), true);
  window.emit('message', { source: window.parent, origin: xOrigin, data: { ...state, session: null } });
  assert.equal(api.isOpen(), false);
  assert.equal(document.listeners.get('play').length, 0);
});

test('the shipped timeline consumer finds the video of a repost original nested under legacy', () => {
  const { context, document, window, sent, state, video, button } = nativeFrame();
  function shippedSection(start, end) {
    const from = frameBundle.indexOf(start);
    const to = frameBundle.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from);
    return frameBundle.slice(from, to);
  }
  context.YomikuiTweetActions = { captureResponse() {} };
  vm.runInContext([
    shippedSection('function jD(e){', 'function fY(e){'),
    shippedSection('function Yd(e){', 'function PD(e){'),
    shippedSection('function hX(e){', 'var Ri="yomikui-download-btn"'),
    'Wb();',
  ].join('\n'), context);

  const original = { legacy: { id_str: '123', extended_entities: { media: [{
    type: 'video', media_url_https: poster,
    video_info: { variants: [{ content_type: 'video/mp4', bitrate: 512000, url: videoUrl }] },
  }] } } };
  const result = { legacy: { id_str: '456', retweeted_status_result: {
    result: { __typename: 'TweetWithVisibilityResults', tweet: original },
  } } };
  const body = JSON.stringify({ data: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [{
    content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } },
  }] }] } } });
  window.emit('yomikui-media-response', { detail: { url: 'https://x.com/i/api/graphql/query/HomeTimeline', body } });
  window.emit('message', { source: window.parent, origin: xOrigin, data: state });
  document.emit('click', { target: button, button: 0, isTrusted: true });
  document.emit('play', { target: video, isTrusted: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.media.src, videoUrl);
});
