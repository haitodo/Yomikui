(() => {
  'use strict';

  const title = 'メディアPiP';
  const supported = () => typeof window.documentPictureInPicture?.requestWindow === 'function';
  const xOrigin = origin => /^https:\/\/(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/i.test(origin);

  function mediaUrl(value, host) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.host === host && !url.username && !url.password) return url.href;
    } catch {}
    return '';
  }

  async function loadPhoto(src, signal) {
    const response = await fetch(src, { credentials: 'omit', cache: 'force-cache', signal });
    if (!response.ok) throw new Error('Could not load media image');
    return response.blob();
  }

  function playbackOf(video) {
    return video ? {
      time: video.currentTime, muted: video.muted, volume: video.volume,
      rate: video.playbackRate, paused: video.paused,
    } : null;
  }

  function createView(pipWindow, { move, close }) {
    const doc = pipWindow.document;
    const style = doc.createElement('style');
    style.textContent = `
      html, body { height: 100%; }
      body { margin: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto;
        background: #101114; color: #f5f5f5; font: 13px system-ui, sans-serif; }
      main { position: relative; min-width: 0; min-height: 0; display: grid; place-items: center; }
      main > img, main > video { width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; }
      main > p { text-align: center; margin: 12px; }
      footer { display: flex; align-items: center; justify-content: center; gap: 10px;
        padding: 5px; background: #1c1d22; font-variant-numeric: tabular-nums; }
      footer[hidden] { display: none; }
      button { color: inherit; background: #30323a; border: 0; border-radius: 5px;
        min-width: 36px; padding: 5px; font: inherit; cursor: pointer; }
      button:hover { background: #454851; }
    `;
    doc.head.append(style);
    doc.title = `Yomikui · ${title}`;
    doc.documentElement.lang = 'ja';
    const stage = doc.createElement('main');
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    const footer = doc.createElement('footer');
    footer.hidden = true;
    const count = doc.createElement('span');
    const previous = doc.createElement('button');
    previous.type = 'button';
    previous.textContent = '‹';
    previous.setAttribute('aria-label', '前のメディア');
    previous.addEventListener('click', () => move(-1));
    const next = doc.createElement('button');
    next.type = 'button';
    next.textContent = '›';
    next.setAttribute('aria-label', '次のメディア');
    next.addEventListener('click', () => move(1));
    footer.append(previous, count, next);
    doc.body.replaceChildren(stage, footer);
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (event.target?.closest?.('video, button') || footer.hidden) return;
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    });
    const message = text => { status.textContent = text; stage.replaceChildren(status); };
    message('列で画像を選ぶか、動画を再生してください');
    return {
      doc, message,
      display: element => stage.replaceChildren(element),
      count(index, total) {
        footer.hidden = total < 2;
        count.textContent = `${index + 1} / ${total}`;
      },
    };
  }

  function pauseSource(port, signal) {
    return new Promise(resolve => {
      function finish(paused) {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        port.onmessage = null;
        resolve(paused);
      }
      const cancel = () => finish(false);
      const timeout = setTimeout(cancel, 1500);
      signal.addEventListener('abort', cancel, { once: true });
      port.onmessage = event => finish(event.data === 'paused');
      port.postMessage('pause');
    });
  }

  function create({ photoUrl, getMuted, setMuted, onSessionChange }) {
    let pipWindow = null;
    let session = null;
    let opening = false;
    let view;
    let gallery = [];
    let index = 0;
    let selectedAt = 0;
    let active = null;

    function release() {
      if (!active) return;
      const { abort, video, objectUrl, port, timer } = active;
      active = null;
      clearTimeout(timer);
      abort.abort();
      if (port) port.close();
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }

    function clear(owner) {
      if (owner !== pipWindow) return;
      release();
      pipWindow = null;
      session = null;
      view = null;
      gallery = [];
      selectedAt = 0;
      onSessionChange(null);
    }

    function close() {
      if (!pipWindow) return;
      const owner = pipWindow;
      clear(owner);
      owner.close();
    }

    async function open() {
      if (pipWindow || opening || !supported()) return false;
      opening = true;
      let owner;
      try {
        owner = await window.documentPictureInPicture.requestWindow({ width: 480, height: 320 });
        view = createView(owner, { move, close });
        pipWindow = owner;
        session = crypto.randomUUID();
        owner.addEventListener('pagehide', () => clear(owner), { once: true });
        onSessionChange(session);
        return true;
      } catch (error) {
        if (owner === pipWindow) clear(owner);
        owner?.close();
        console.warn('[Yomikui] メディアPiPを開けませんでした', error);
        return false;
      } finally {
        opening = false;
      }
    }

    function syncFrame(frame, origin, state = session) {
      if (!frame || !xOrigin(origin)) return;
      frame.postMessage({ type: 'yomikui-media-pip-state', session: state }, origin);
    }

    function fail(request, message) {
      if (request !== active) return;
      release();
      view.message(message);
    }

    async function showPhoto(item, request) {
      const src = photoUrl(item.src);
      let blob;
      try {
        blob = await loadPhoto(src, request.abort.signal);
      } catch (error) {
        if (request !== active) return;
        if (src === item.src) throw error;
        blob = await loadPhoto(item.src, request.abort.signal);
      }
      if (request !== active) return;
      const img = view.doc.createElement('img');
      img.alt = '投稿の画像';
      img.src = request.objectUrl = URL.createObjectURL(blob);
      await img.decode();
      if (request === active) view.display(img);
    }

    async function showVideo(item, playback, request) {
      const { port, abort: { signal } } = request;
      const video = request.video = view.doc.createElement('video');
      const muted = item.type === 'animated_gif' || (playback?.muted ?? getMuted());
      video.loop = item.type === 'animated_gif';
      video.controls = item.type === 'video' && !port;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      video.muted = !!port || muted;
      video.volume = Number.isFinite(playback?.volume) ? Math.max(0, Math.min(1, playback.volume)) : 1;
      if (Number.isFinite(playback?.rate) && playback.rate >= .25 && playback.rate <= 4) video.playbackRate = playback.rate;
      if (Number.isFinite(playback?.time) && playback.time > 0) {
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = Math.min(playback.time, video.duration || playback.time);
        }, { once: true, signal });
      }
      video.addEventListener('error', () => fail(request, '動画を表示できませんでした'), { once: true, signal });
      video.poster = item.posterUrl;
      video.src = item.src;
      view.display(video);
      try {
        if (!playback?.paused) await video.play();
        if (request !== active) return;
        if (port && !await pauseSource(port, signal)) {
          fail(request, '列の動画をPiPに移せませんでした');
          return;
        }
        if (request !== active) return;
        video.muted = muted;
        video.controls = item.type === 'video';
      } catch (error) {
        // Gallery videos still have controls when the browser requires a click to play.
        if (port || error.name !== 'NotAllowedError') throw error;
      } finally {
        clearTimeout(request.timer);
        port?.close();
        request.port = null;
      }
      if (request === active && item.type === 'video') {
        let lastMuted = video.muted;
        video.addEventListener('volumechange', () => {
          if (video.muted === lastMuted) return;
          lastMuted = video.muted;
          setMuted(lastMuted);
        }, { signal });
      }
    }

    function show(items, position, { playback, port, at = Date.now() } = {}) {
      if (!pipWindow || pipWindow.closed) return false;
      if (at < selectedAt) { port?.close(); return true; }
      const item = items[position];
      if (!item || !['photo', 'video', 'animated_gif'].includes(item.type)) return false;
      const src = mediaUrl(item.src, item.type === 'photo' ? 'pbs.twimg.com' : 'video.twimg.com');
      if (!src) return false;

      release();
      gallery = items;
      index = position;
      selectedAt = at;
      const request = active = { abort: new AbortController(), port };
      view.count(index, gallery.length);
      view.message('メディアを読み込み中…');
      if (port) request.timer = setTimeout(() => fail(request, '列の動画をPiPに移せませんでした'), 10000);
      const media = { ...item, src, posterUrl: mediaUrl(item.posterUrl, 'pbs.twimg.com') };
      const load = item.type === 'photo' ? showPhoto(media, request) : showVideo(media, playback, request);
      load.catch(() => fail(request, 'メディアを表示できませんでした'));
      return true;
    }

    function move(delta) {
      if (gallery.length > 1) show(gallery, (index + delta + gallery.length) % gallery.length);
    }

    function handlePlay(event, frames) {
      const data = event.data;
      const port = event.ports[0];
      if (!port) return;
      const valid = session && data.session === session && xOrigin(event.origin) &&
        frames.get(data.columnId) === event.source &&
        Number.isFinite(data.at) && Math.abs(Date.now() - data.at) < 6000 &&
        (data.media?.type === 'video' || data.media?.type === 'animated_gif');
      if (!valid || !show([data.media], 0, { playback: data.playback, at: data.at, port })) port.close();
    }

    return { open, close, isOpen: () => !!pipWindow && !pipWindow.closed, show, syncFrame, handlePlay };
  }

  function Button({ jsx, open, onClick, overlay = false }) {
    if (!supported()) return null;
    const label = `${title}を${open ? '閉じる' : '開く'}`;
    return jsx.jsxs('button', {
      type: 'button', title: label, 'aria-label': label, 'aria-pressed': open,
      onClick: event => { event.stopPropagation(); onClick(); },
      className: overlay
        ? 'rounded-full bg-black/40 px-3 py-1 text-xs font-semibold text-white hover:bg-black/60'
        : `flex h-10 w-10 items-center justify-center rounded-xl hover:bg-sidebar-accent ${open ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground'}`,
      children: [jsx.jsxs('svg', {
        width: overlay ? 14 : 20, height: overlay ? 14 : 20, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, 'aria-hidden': true,
        style: overlay ? { display: 'inline-block', marginRight: 5, verticalAlign: 'middle' } : undefined,
        children: [jsx.jsx('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
          jsx.jsx('rect', { x: 11, y: 11, width: 7, height: 5, rx: .5, fill: open ? 'currentColor' : 'none' })],
      }), overlay ? title : null],
    });
  }

  globalThis.YomikuiMediaPip = { create, Button, playbackOf, loadPhoto };
})();
