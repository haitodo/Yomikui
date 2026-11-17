(() => {
  'use strict';

  const mediaPath = /^\/([A-Za-z0-9_]+|i\/web)\/status\/(\d+)\/(photo|video)\/([1-9]\d*)\/?$/;
  const viewerSelector = '[role="dialog"] [data-testid="swipe-to-dismiss"]';
  const photoSource = 'https://pbs.twimg.com/media/';
  const icon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="M12 2a1 1 0 0 1 1 1v10.586l2.293-2.293a1 1 0 0 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L11 13.586V3a1 1 0 0 1 1-1zM5 17a1 1 0 0 1 1 1v2h12v-2a1 1 0 1 1 2 0v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a1 1 0 0 1 1-1z"/>
</svg>`;

  function originalImageUrl(value) {
    if (!value) return value;
    try {
      const url = new URL(value);
      if (url.hostname !== 'pbs.twimg.com') return value;
      const isPhoto = url.pathname.startsWith('/media/');
      if (!isPhoto && !/^\/(?:amplify_video|ext_tw_video|tweet_video)_thumb\//.test(url.pathname)) return value;
      url.searchParams.set('name', 'orig');
      const extension = isPhoto && url.pathname.match(/\.([a-z]+)$/i)?.[1];
      if (extension) {
        url.pathname = url.pathname.slice(0, -extension.length - 1);
        if (!url.searchParams.has('format')) url.searchParams.set('format', extension);
      }
      return url.href;
    } catch {
      return value;
    }
  }

  function viewerMedia(viewer, dialog, route, cached) {
    const [, handle, tweetId, type, number] = route;
    const index = Number(number) - 1;
    if (!Number.isSafeInteger(index)) return null;
    const images = [];
    const videos = [];
    const photo = viewer.querySelector(`img[src^="${photoSource}"]`);
    const photoUrl = photo?.src || photo?.currentSrc;
    if (type === 'photo' && photoUrl?.startsWith(photoSource)) {
      images.push({ url: originalImageUrl(photoUrl), index });
    } else {
      const video = viewer.querySelector('video');
      if (!video) return null;
      const url = globalThis.YomikuiMediaPipFrame.getVideoUrl(video);
      if (!url) return null;
      const cachedItem = cached?.videos.find(item => item.url === url);
      videos.push({ url, index: cachedItem?.index ?? index });
    }

    const time = dialog.querySelector(`a[href$="/status/${tweetId}"] time[datetime]`);
    const postPath = globalThis.YomikuiTweetActions.getStatusPath(time?.closest('a')?.getAttribute('href'));
    const postHandle = postPath?.match(/^\/([A-Za-z0-9_]+)\/status\//)?.[1] ?? handle;
    const screenName = ['i', 'i/web'].includes(postHandle) ? cached?.screenName ?? 'unknown' : postHandle;
    const tweetCreatedAt = Number.isFinite(cached?.tweetCreatedAt)
      ? cached.tweetCreatedAt
      : Date.parse(time?.getAttribute('datetime'));
    return { tweetId, screenName, tweetCreatedAt, images, videos };
  }

  function createButton(onClick) {
    const style = document.createElement('style');
    style.textContent = `
      .yomikui-media-viewer-download {
        position: absolute;
        top: 12px;
        left: 56px;
        z-index: 1;
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: rgba(15, 20, 25, .75);
        color: white;
        cursor: pointer;
      }
      .yomikui-media-viewer-download:hover { background: rgba(39, 44, 48, .9); }
      .yomikui-media-viewer-download:focus-visible { outline: 2px solid #1d9bf0; }
      .yomikui-media-viewer-download:disabled { opacity: .5; cursor: default; }
      .yomikui-media-viewer-download[data-error] { color: #f4212e; }
    `;
    document.head.append(style);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yomikui-media-viewer-download';
    button.title = chrome.i18n.getMessage('app_download_media') || 'Download media';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = icon;
    button.addEventListener('click', onClick);
    return button;
  }

  function downloadInTab(media) {
    return chrome.runtime.sendMessage({ type: 'yomikui-download-media', media, batchId: crypto.randomUUID() });
  }

  function install({ isVisible = () => true, getCachedMedia, download = downloadInTab } = {}) {
    let button;
    let pending = false;
    let observed = null;
    let selectedSlide = null;
    const observer = new MutationObserver(sync);

    function selection() {
      const route = document.hidden || !isVisible() ? null : location.pathname.match(mediaPath);
      if (!route) selectedSlide = null;
      const layers = route ? document.getElementById('layers') : null;
      const root = route ? layers ?? document : null;
      const viewers = layers?.querySelectorAll(viewerSelector);
      const viewer = viewers?.[0];
      const dialog = viewer?.closest('[role="dialog"]');
      // X keeps both slides mounted during the animation between photos.
      if (viewers?.length !== 1) return { root, dialog, transitioning: viewers?.length > 1 };
      const media = viewerMedia(viewer, dialog, route, getCachedMedia?.(route[2]));
      if (!media) return { root, dialog };

      const routeKey = route.slice(2).join('/');
      const url = media.images[0]?.url ?? media.videos[0].url;
      // The route can change before X mounts the next slide.
      if (selectedSlide?.viewer === viewer && selectedSlide.routeKey !== routeKey && selectedSlide.url === url) {
        return { root, dialog, transitioning: true };
      }
      selectedSlide = { viewer, routeKey, url };
      return { root, dialog, media };
    }

    function sync() {
      const { root, dialog, media, transitioning } = selection();
      if (root !== observed) {
        observer.disconnect();
        observed = root;
        if (root) observer.observe(root, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster'],
        });
      }
      if (media) {
        button ??= createButton(save);
        button.disabled = pending;
        if (button.parentElement !== dialog) dialog.append(button);
      } else if (transitioning && button?.parentElement === dialog) {
        button.disabled = true;
      } else {
        button?.remove();
      }
    }

    async function save(event) {
      event.stopPropagation();
      if (!event.isTrusted || pending) return;
      const { dialog, media } = selection();
      if (!media || button.parentElement !== dialog) return;
      pending = true;
      button.disabled = true;
      try {
        const result = await download(media);
        if (result?.success === false) throw new Error('Download request failed');
      } catch {
        button.setAttribute('data-error', '');
        setTimeout(() => button.removeAttribute('data-error'), 2000);
      } finally {
        pending = false;
        sync();
      }
    }

    window.navigation?.addEventListener('currententrychange', sync);
    window.addEventListener('yomikui-frame-column-visibility', sync);
    if (getCachedMedia) window.addEventListener('yomikui-media-response', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
  }

  globalThis.YomikuiMediaViewerDownload = { install, icon, originalImageUrl };
  if (window.self === window.top) install();
})();
