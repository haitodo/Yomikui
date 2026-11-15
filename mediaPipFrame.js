(() => {
  'use strict';

  const players = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';
  const videoCard = 'article[data-testid="tweet"] [data-testid="card.wrapper"]';
  const playerControls = 'a[href], button, input, select, textarea, label, [role="button"], [role="link"], [role="slider"], [role="menu"], [data-testid="scrubber"]';
  const playerButtons = 'button, [role="button"]';
  const previewPlay = '[data-testid="playButton"]';
  const playLabel = /^(?:この動画を再生する|動画を再生|再生|プレイ|play(?: video)?)(?:\b|[\s.、。:]|$)/i;
  const playIntentMs = 5000;
  const startupPauseMs = 2000;
  const xOrigin = origin => /^https:\/\/(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/i.test(origin);
  const mediaByPoster = new Map();
  let session = null;
  let installed = false;

  function posterKey(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.host === 'pbs.twimg.com') {
        return url.pathname.replace(/\.(?:jpe?g|png|webp)(?::\w+)?$/i, '');
      }
    } catch {}
    return '';
  }

  function mp4(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.host === 'video.twimg.com' && url.pathname.endsWith('.mp4')) {
        return url.href;
      }
    } catch {}
    return '';
  }

  function rememberVideo(posterUrl, url, type) {
    const key = posterKey(posterUrl);
    const src = mp4(url);
    if (!key || !src) return;
    mediaByPoster.delete(key);
    mediaByPoster.set(key, { src, posterUrl, type });
    if (mediaByPoster.size > 500) mediaByPoster.delete(mediaByPoster.keys().next().value);
  }

  function cardVideoTarget(target) {
    const player = target?.closest?.(players);
    if (!player?.closest(videoCard)) return null;
    const control = target.closest(playerControls);
    if (control && player.contains(control)) return null;
    const video = player.querySelector('video');
    return video && !video.controls ? video : null;
  }

  function playTarget(target, cardVideo) {
    const button = target?.closest?.(playerButtons);
    if (button?.matches(previewPlay)) {
      const preview = button.closest('[data-testid="previewInterstitial"]');
      const key = posterKey(preview?.querySelector('img')?.src);
      if (key) return { key, article: button.closest('article') };
    }
    const video = cardVideo ?? target?.closest?.(players)?.querySelector('video');
    if (!video || (!video.paused && !video.ended)) return null;
    if (!cardVideo && target !== video && !playLabel.test(button?.getAttribute('aria-label') || '')) return null;
    return { video, key: posterKey(video.poster), article: video.closest('article') };
  }

  function matchesVideo(target, video, key) {
    return target.video === video || (key && target.key === key && target.article === video.closest('article'));
  }

  function install({ getColumnId, isVisible }) {
    if (installed || window.parent === window) return;
    installed = true;
    let parentOrigin;
    let intent = null;
    let previewPlayback = null;

    function cancelPreviewPlayback(event) {
      if (event.isTrusted) previewPlayback = null;
    }

    function onVideoInteraction(event) {
      if (!event.isTrusted) return;
      cancelPreviewPlayback(event);
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const visible = isVisible();
      const cardVideo = visible ? cardVideoTarget(event.target) : null;
      if (event.type !== 'click') {
        // X binds outbound navigation on mouse down and opens the URL on mouse up.
        if (cardVideo) event.stopImmediatePropagation();
        return;
      }
      const trackPlayback = session || event.target?.closest?.(previewPlay);
      const target = visible && trackPlayback ? playTarget(event.target, cardVideo) : null;
      const request = target ? { ...target, at: Date.now() } : null;
      intent = session ? request : null;
      if (request && !session && !request.video) previewPlayback = request;
      if (!cardVideo) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (cardVideo.paused || cardVideo.ended) {
        cardVideo.play().catch(() => {});
      } else {
        cardVideo.pause();
      }
    }

    function onPreviewPlaying({ target: video, isTrusted }) {
      const request = previewPlayback;
      if (!request || !isTrusted || video.tagName !== 'VIDEO') return;
      if (Date.now() - request.at >= playIntentMs || (request.video && request.video !== video)) {
        previewPlayback = null;
        return;
      }
      if (request.video || !matchesVideo(request, video, posterKey(video.poster))) return;
      request.video = video;
      request.startedAt = Date.now();
    }

    function onPreviewPause({ target: video, isTrusted }) {
      const request = previewPlayback;
      if (!isTrusted || request?.video !== video) return;
      // Wait for X to render its paused controls, then retry the original click once.
      requestAnimationFrame(() => {
        if (previewPlayback !== request) return;
        previewPlayback = null;
        if (Date.now() - request.startedAt >= startupPauseMs || document.hidden || !isVisible()) return;
        if (!video.isConnected || !video.paused || video.ended || posterKey(video.poster) !== request.key) return;
        const player = video.closest('[data-testid="videoPlayer"]') ?? video.closest(players);
        if (!player || video.closest('article') !== request.article) return;
        const { left, top, width, height } = player.getBoundingClientRect();
        if (!width || !height || !player.contains(document.elementFromPoint(left + width / 2, top + height / 2))) return;
        const button = Array.from(player.querySelectorAll(playerButtons)).find(control =>
          !control.disabled && playLabel.test(control.getAttribute('aria-label') || ''));
        button?.click();
      });
    }

    function onPlay(event) {
      const video = event.target;
      if (!intent || !event.isTrusted || !isVisible() || video.tagName !== 'VIDEO') return;
      if (Date.now() - intent.at >= playIntentMs) { intent = null; return; }
      const key = posterKey(video.poster);
      if (!matchesVideo(intent, video, key)) return;
      const { at } = intent;
      intent = null;
      const columnId = getColumnId();
      const cached = mediaByPoster.get(key);
      const source = video.currentSrc || video.src;
      const src = mp4(source) || cached?.src;
      if (!columnId || !src) return;

      const activeSession = session;
      const channel = new MessageChannel();
      const expires = setTimeout(() => channel.port1.close(), 12000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(expires);
        const sameVideo = source ? source === (video.currentSrc || video.src) : key === posterKey(video.poster);
        if (data === 'pause' && session === activeSession && sameVideo) {
          video.pause();
          channel.port1.postMessage('paused');
        }
        channel.port1.close();
      };
      window.parent.postMessage({
        type: 'yomikui-media-pip-play', session: activeSession, columnId, at,
        media: { src, type: cached?.type ?? 'video', posterUrl: video.poster || cached?.posterUrl },
        playback: { time: video.currentTime, muted: video.muted, volume: video.volume, rate: video.playbackRate },
      }, parentOrigin, [channel.port2]);
    }

    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, onVideoInteraction, true);
    }
    document.addEventListener('playing', onPreviewPlaying, true);
    document.addEventListener('pause', onPreviewPause, true);
    document.addEventListener('keydown', cancelPreviewPlayback, true);
    document.addEventListener('wheel', cancelPreviewPlayback, { capture: true, passive: true });
    window.addEventListener('blur', cancelPreviewPlayback);
    window.addEventListener('message', event => {
      if (event.source !== window.parent || !xOrigin(event.origin) || event.data?.type !== 'yomikui-media-pip-state') return;
      const next = typeof event.data.session === 'string' ? event.data.session : null;
      if (next === session) return;
      parentOrigin = event.origin;
      session = next;
      intent = null;
      previewPlayback = null;
      if (session) {
        document.addEventListener('play', onPlay, true);
      } else {
        document.removeEventListener('play', onPlay, true);
      }
    });
  }

  globalThis.YomikuiMediaPipFrame = { install, rememberVideo, isOpen: () => !!session };
})();
