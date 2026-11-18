(() => {
  'use strict';

  const mediaPath = /^\/([A-Za-z0-9_]+|i\/web)\/status\/(\d+)\/(photo|video)\/([1-9]\d*)\/?$/;
  const slideSelector = '[data-testid="swipe-to-dismiss"]';
  const viewerSelector = `#layers [role="dialog"] ${slideSelector}, main ${slideSelector}`;
  const photoSource = 'https://pbs.twimg.com/media/';
  const iconPath = 'M12 2a1 1 0 0 1 1 1v10.586l2.293-2.293a1 1 0 0 1 1.414 1.414l-4 4a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L11 13.586V3a1 1 0 0 1 1-1zM5 17a1 1 0 0 1 1 1v2h12v-2a1 1 0 1 1 2 0v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a1 1 0 0 1 1-1z';
  const icon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="${iconPath}"/>
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

  function viewerMedia(viewer, container, route, cached) {
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

    const time = container.querySelector(`a[href$="/status/${tweetId}"] time[datetime]`);
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

  function OverlayButton({ jsx, item, label, onDownload }) {
    const path = globalThis.YomikuiTweetActions.getStatusPath(item?.postPath);
    const index = item?.mediaIndex;
    const src = item?.src;
    if (!path || typeof src !== 'string' || !Number.isSafeInteger(index) || index < 0) return null;
    const isPhoto = item.type === 'photo';
    let url;
    if (isPhoto && src.startsWith(photoSource)) {
      url = originalImageUrl(src);
    } else if (item.type === 'video' || item.type === 'animated_gif') {
      url = globalThis.YomikuiMediaPipFrame.mp4Url(src);
    }
    if (!url) return null;
    const parts = path.split('/');
    const file = { url, index };
    const media = {
      tweetId: parts.at(-1),
      screenName: parts[1] === 'i' ? 'unknown' : parts[1],
      tweetCreatedAt: Number.isFinite(item.tweetCreatedAt) ? item.tweetCreatedAt : undefined,
      images: isPhoto ? [file] : [],
      videos: isPhoto ? [] : [file],
    };
    return jsx.jsx('button', {
      type: 'button', title: label, 'aria-label': label,
      className: 'flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60',
      onClick: event => {
        event.stopPropagation();
        onDownload(media);
      },
      children: jsx.jsx('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
        children: jsx.jsx('path', { d: iconPath }),
      }),
    });
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
      // X moves the viewer from the dialog layer into main at narrow widths.
      const root = route ? document.getElementById('react-root') ?? document : null;
      const viewers = root?.querySelectorAll(viewerSelector);
      const viewer = viewers?.[0];
      const container = viewer?.closest('[role="dialog"], main');
      // X keeps both slides mounted during the animation between photos.
      if (viewers?.length !== 1) return { root, container, transitioning: viewers?.length > 1 };
      const media = viewerMedia(viewer, container, route, getCachedMedia?.(route[2]));
      if (!media) return { root, container };

      const routeKey = route.slice(2).join('/');
      const url = media.images[0]?.url ?? media.videos[0].url;
      // The route can change before X mounts the next slide.
      if (selectedSlide?.viewer === viewer && selectedSlide.routeKey !== routeKey && selectedSlide.url === url) {
        return { root, container, transitioning: true };
      }
      selectedSlide = { viewer, routeKey, url };
      return { root, container, media };
    }

    function sync() {
      const { root, container, media, transitioning } = selection();
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
        if (button.parentElement !== container) container.append(button);
      } else if (transitioning && button?.parentElement === container) {
        button.disabled = true;
      } else {
        button?.remove();
      }
    }

    async function save(event) {
      event.stopPropagation();
      if (!event.isTrusted || pending) return;
      const { container, media } = selection();
      if (!media || button.parentElement !== container) return;
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

  globalThis.YomikuiMediaViewerDownload = { install, icon, originalImageUrl, OverlayButton };
  if (window.self === window.top) install();
})();
