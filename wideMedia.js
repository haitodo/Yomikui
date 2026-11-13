"use strict";

// Loaded before contentIframe.js in native and custom column frames.
// Manages responsive wide media layout and high-resolution thumbnail upgrades.
(() => {
  if (globalThis.YomikuiWideMedia) return;

  const WIDE_MIN_WIDTH_REM = 36; // 576px breakpoint
  const WIDE_MIN_WIDTH_PX = 576;

  const TWEET = 'article[data-testid="tweet"]';
  const PHOTO_LINK = 'a[role="link"][href*="/photo/"]';
  const VIDEO_PLAYER = `${TWEET} [data-testid="videoPlayer"], ${TWEET} [data-testid="videoComponent"]`;
  const TWEET_PHOTO = `${TWEET} [data-testid="tweetPhoto"]`;
  const MEDIA = ':is([data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="card.layoutLarge.media"])';
  const MEDIA_CONTENT = ':is(img, video, [data-testid="previewInterstitial"], div[style*="background-image"])';
  const RATIO_SPACER = 'div[style*="padding-bottom"]';
  const SMALL_CARD = '[data-testid^="card.layoutSmall"]';
  const CAROUSEL = '[data-testid="ScrollSnap-SwipeableList"]';
  const CONDENSED_MEDIA = '[data-testid="testCondensedMedia"]';

  // Exclude overlays, dialogs, menus, and popovers from structural width rules
  const NOT_POPUP = ':not(#layers):not(#layers *):not([role="dialog"]):not([role="dialog"] *):not([role="menu"]):not([role="menu"] *):not([role="listbox"]):not([role="listbox"] *)';

  // Keep each :has() independent so browsers can parse the grid and its exclusions.
  const GRID_TRACK = `${RATIO_SPACER} + div > div`;
  const GRID_FRAME = `div:has(> ${GRID_TRACK} > div:first-child ${MEDIA}):has(> ${GRID_TRACK} > div:nth-child(2) ${MEDIA})`;
  const PHOTO_GRID_FRAME = `div:has(> ${RATIO_SPACER} + div ${PHOTO_LINK}:is([href*="/photo/2"], [href*="/photo/3"], [href*="/photo/4"]))`;
  const MULTI_GRID = `${TWEET} ${GRID_FRAME}`;
  const OUTSIDE_GALLERY = `:not(${GRID_FRAME} *, ${PHOTO_GRID_FRAME} *, ${CAROUSEL}, ${CAROUSEL} *, ${CONDENSED_MEDIA}, ${CONDENSED_MEDIA} *)`;
  const OUTSIDE_SMALL_CARD = `:not(${SMALL_CARD}, ${SMALL_CARD} *)`;

  // X places the aspect-ratio spacer outside photos and inside video previews.
  const RATIO_FRAME = `:has(> ${RATIO_SPACER} + div)`;
  const SINGLE_MEDIA_FRAME = `${TWEET} :is(div:has(> ${RATIO_SPACER} + ${MEDIA}, > ${RATIO_SPACER} + div ${MEDIA}), ${MEDIA}${RATIO_FRAME}, ${MEDIA} > div${RATIO_FRAME}, ${MEDIA} > div > div${RATIO_FRAME}):not(${GRID_FRAME}, ${PHOTO_GRID_FRAME})${OUTSIDE_GALLERY}${OUTSIDE_SMALL_CARD}`;
  const SINGLE_MEDIA_LAYER = `${SINGLE_MEDIA_FRAME} > ${RATIO_SPACER} + div`;
  const SINGLE_MEDIA = `${TWEET} ${MEDIA}${OUTSIDE_GALLERY}${OUTSIDE_SMALL_CARD}`;

  // Media-only ancestors can carry a fixed inline max-width independently of the frame.
  const POST_CONTENT = `[data-testid="Tweet-User-Avatar"], [data-testid="User-Name"], [data-testid="tweetText"], [role="group"]:not(${MEDIA} *), [data-testid="reply"], [data-testid="like"], [data-testid="unlike"]`;
  const MEDIA_ANCESTOR = `${TWEET} div:has(${MEDIA}):not(${RATIO_FRAME}, ${MEDIA} *):not(:has(${POST_CONTENT}, ${SMALL_CARD}, ${CAROUSEL}))${OUTSIDE_GALLERY}${OUTSIDE_SMALL_CARD}`;

  // Selectors for explicit small / large modes
  const IR = `${TWEET} ${PHOTO_GRID_FRAME}`;
  const AH = `${IR} > div[style*="padding-bottom"] + div > div`;
  const SH = `${AH} > div`;
  const DOLLAR_H = `${IR} ${PHOTO_LINK} > div`;
  const R1 = `${TWEET} ${PHOTO_LINK} div:has(> div[style*="padding-bottom"])`;

  function buildLayoutCss({ hideBanner } = {}) {
    const rules = [];

    // Unlock the full ancestor chain from #react-root -> main -> intermediate wrappers -> primaryColumn -> cellInnerDiv -> tweet
    rules.push(`
      #react-root,
      #react-root > div {
        width: 100% !important;
        max-width: 100% !important;
      }
      #react-root > div > div {
        width: 100% !important;
        max-width: 100% !important;
        justify-content: flex-start !important;
      }
      main[role="main"] {
        flex: 1 1 0% !important;
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        align-items: stretch !important;
      }
      main[role="main"] div:has([data-testid="primaryColumn"])${NOT_POPUP} {
        flex-grow: 1 !important;
        flex-shrink: 1 !important;
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        align-items: stretch !important;
        justify-content: flex-start !important;
        box-sizing: border-box !important;
      }
      [data-testid="primaryColumn"] {
        flex: 1 1 0% !important;
      }
      [data-testid="primaryColumn"],
      [data-testid="primaryColumn"] > div,
      [data-testid="primaryColumn"] > div > div:first-child,
      [data-testid="primaryColumn"] div:has([data-testid="cellInnerDiv"])${NOT_POPUP},
      [data-testid="primaryColumn"] div:has([role="tablist"], form[role="search"], [data-testid="tweetTextarea_0"], [data-testid="UserName"], [data-testid="UserDescription"])${NOT_POPUP},
      [data-testid="primaryColumn"] section[role="region"],
      [data-testid="primaryColumn"] section[role="region"] > div,
      [data-testid="cellInnerDiv"],
      [data-testid="cellInnerDiv"] > div,
      [data-testid="cellInnerDiv"] div:has(> article[data-testid="tweet"])${NOT_POPUP},
      article[data-testid="tweet"] {
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        box-sizing: border-box !important;
      }
      main[role="main"] .r-1ye8kvj${NOT_POPUP},
      [data-testid="primaryColumn"] .r-1ye8kvj${NOT_POPUP} {
        max-width: 100% !important;
      }
    `);

    if (hideBanner) {
      rules.push(`
        header[role="banner"] { display: none !important; }
        main[role="main"] { padding-left: 0 !important; }
        [data-testid="primaryColumn"] { border-inline: none !important; border: none !important; }
        body > div#react-root > div > div { padding-left: 0 !important; }
      `);
    } else {
      // Prevent banner menu expansion to 275px wide or extra centering flex-grow in wide columns
      rules.push(`
        header[role="banner"] {
          flex: 0 0 auto !important;
          align-items: flex-start !important;
          width: 68px !important;
          min-width: 0 !important;
          max-width: 88px !important;
        }
        header[role="banner"] > div,
        header[role="banner"] > div > div {
          width: 68px !important;
          min-width: 0 !important;
          max-width: 88px !important;
          align-items: center !important;
        }
        header[role="banner"] nav[role="navigation"] a[role="link"] > div > div:nth-child(2),
        header[role="banner"] [data-testid="SideNav_NewTweet_Button"] span,
        header[role="banner"] [data-testid="SideNav_AccountSwitcher_Button"] > div:not(:first-child) {
          display: none !important;
        }
      `);
    }

    return rules.join("\n");
  }

  function buildSingleMediaCss(maxHeight) {
    // Let the height limit grow with a wide iframe while bounding very tall media.
    return `
      ${MEDIA_ANCESTOR},
      ${TWEET} ${PHOTO_LINK}${OUTSIDE_GALLERY}${OUTSIDE_SMALL_CARD} {
        width: 100% !important;
        max-width: 100% !important;
        max-height: none !important;
        flex-basis: auto !important;
        align-self: stretch !important;
        align-items: stretch !important;
      }
      ${SINGLE_MEDIA}:not(${RATIO_FRAME}) {
        width: 100% !important;
        max-width: 100% !important;
      }
      ${SINGLE_MEDIA_FRAME} {
        width: 100% !important;
        max-width: 100% !important;
        height: auto !important;
        max-height: max(${maxHeight}, 100vw) !important;
        position: relative !important;
        overflow: hidden !important;
      }
      ${SINGLE_MEDIA_LAYER} {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
      }
      ${SINGLE_MEDIA_LAYER} > [data-testid="tweetPhoto"] {
        margin: 0 !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
      }
      ${SINGLE_MEDIA} ${MEDIA_CONTENT} {
        width: 100% !important;
        height: 100% !important;
      }
      ${SINGLE_MEDIA} :is(img, video) {
        max-width: none !important;
        max-height: none !important;
        object-fit: contain !important;
        object-position: center !important;
      }
      ${SINGLE_MEDIA} [data-testid="previewInterstitial"] {
        inset: 0 !important;
      }
      ${SINGLE_MEDIA} div[style*="background-image"] {
        background-size: contain !important;
        background-repeat: no-repeat !important;
        background-position: center !important;
      }
    `;
  }

  function buildMediaSizeCss(mode = "default") {
    if (mode === "small") {
      const smallHeight = "140px";
      const mediaContainers = `
        ${R1},
        ${IR},
        ${VIDEO_PLAYER} > div,
        ${TWEET_PHOTO} > div > div
      `;
      const paddingBoxes = `
        ${R1} > div[style*="padding-bottom"],
        ${IR} > div[style*="padding-bottom"],
        ${VIDEO_PLAYER} > div > div[style*="padding-bottom"],
        ${TWEET_PHOTO} > div > div > div[style*="padding-bottom"]
      `;
      const mediaAbsoluteTargets = `
        ${R1} > div[style*="padding-bottom"] + div,
        ${IR} > div[style*="padding-bottom"] + div,
        ${VIDEO_PLAYER} > div > div[style*="padding-bottom"] + div,
        ${TWEET_PHOTO} > div > div > div[style*="padding-bottom"] + div,
        ${DOLLAR_H},
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"],
        ${TWEET_PHOTO} [data-testid="previewInterstitial"]
      `;
      const mediaContent = `
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"] img,
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"] > div[style*="background-image"],
        ${TWEET_PHOTO} img,
        ${TWEET_PHOTO} video,
        ${TWEET_PHOTO} [data-testid="previewInterstitial"],
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] img,
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] > div[style*="background-image"],
        ${TWEET_PHOTO} div[style*="background-image"],
        ${VIDEO_PLAYER} video,
        ${VIDEO_PLAYER} img,
        ${VIDEO_PLAYER} > div > div[style*="padding-bottom"] + div > div[style*="background-image"]
      `;

      return `
        ${mediaContainers} {
          height: ${smallHeight} !important;
          max-height: ${smallHeight} !important;
          min-height: 0 !important;
          overflow: hidden !important;
          position: relative !important;
        }
        ${paddingBoxes} {
          padding: 0 !important;
          padding-bottom: 0 !important;
          height: 0 !important;
          min-height: 0 !important;
          margin: 0 !important;
          overflow: hidden !important;
        }
        ${mediaAbsoluteTargets} {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          margin: 0 !important;
        }
        ${mediaContainers},
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"],
        ${TWEET_PHOTO},
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] {
          background-color: rgb(0, 0, 0) !important;
        }
        ${mediaContent} {
          width: 100% !important;
          height: 100% !important;
          object-fit: contain !important;
          object-position: center !important;
        }
        ${TWEET_PHOTO} div[style*="background-image"],
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"] > div[style*="background-image"],
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] > div[style*="background-image"],
        ${VIDEO_PLAYER} > div > div[style*="padding-bottom"] + div > div[style*="background-image"] {
          background-size: contain !important;
          background-repeat: no-repeat !important;
          background-position: center !important;
        }
        ${AH} {
          display: flex !important;
          flex-direction: row !important;
          width: 100% !important;
          height: 100% !important;
          gap: 2px !important;
        }
        ${SH} {
          flex: 1 1 50% !important;
          min-width: 0 !important;
          height: 100% !important;
          position: relative !important;
          overflow: hidden !important;
        }
        ${SH} > div {
          height: 100% !important;
          min-height: inherit !important;
          position: relative !important;
        }
        ${DOLLAR_H},
        ${IR} ${PHOTO_LINK} [data-testid="tweetPhoto"] {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          margin: 0 !important;
        }
      `;
    }

    if (mode === "large") {
      const mediaContent = `
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"] img,
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"] > div[style*="background-image"],
        ${TWEET_PHOTO} img,
        ${TWEET_PHOTO} video,
        ${TWEET_PHOTO} [data-testid="previewInterstitial"],
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] img,
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] > div[style*="background-image"],
        ${TWEET_PHOTO} div[style*="background-image"],
        ${VIDEO_PLAYER} video,
        ${VIDEO_PLAYER} img,
        ${VIDEO_PLAYER} > div > div[style*="padding-bottom"] + div > div[style*="background-image"]
      `;

      return `
        ${buildSingleMediaCss("85vh")}
        ${IR} {
          width: 100% !important;
          max-width: 100% !important;
          min-height: 0 !important;
          height: auto !important;
          overflow: visible !important;
        }
        ${IR} > div[style*="padding-bottom"] {
          padding-bottom: 0 !important;
          min-height: 0 !important;
          height: 0 !important;
        }
        ${IR} > div[style*="padding-bottom"] + div {
          position: relative !important;
          inset: auto !important;
          height: auto !important;
        }
        ${AH} {
          display: flex !important;
          flex-direction: column !important;
          width: 100% !important;
          height: auto !important;
          gap: 4px !important;
        }
        ${SH} {
          flex: 1 1 auto !important;
          min-width: 0 !important;
          min-height: 420px !important;
          max-height: 82vh !important;
          height: auto !important;
          position: relative !important;
          overflow: hidden !important;
        }
        ${SH} > div {
          height: 100% !important;
          min-height: inherit !important;
          position: relative !important;
        }
        ${DOLLAR_H},
        ${IR} ${PHOTO_LINK} [data-testid="tweetPhoto"] {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          margin: 0 !important;
        }
        ${mediaContent} {
          width: 100% !important;
          height: 100% !important;
          max-width: none !important;
          max-height: none !important;
          object-fit: contain !important;
          object-position: center !important;
        }
        ${TWEET_PHOTO} div[style*="background-image"],
        ${TWEET} ${PHOTO_LINK} [data-testid="tweetPhoto"] > div[style*="background-image"],
        ${TWEET_PHOTO} [data-testid="previewInterstitial"] > div[style*="background-image"],
        ${VIDEO_PLAYER} > div > div[style*="padding-bottom"] + div > div[style*="background-image"] {
          background-size: contain !important;
          background-repeat: no-repeat !important;
          background-position: center !important;
        }
      `;
    }

    // Default mode: responsive expansion when column viewport >= 36rem (576px)
    return `
      @media (min-width: ${WIDE_MIN_WIDTH_REM}rem) {
        ${buildSingleMediaCss("82vh")}

        ${MULTI_GRID} {
          width: 100% !important;
          max-width: 100% !important;
          max-height: 78vh !important;
          position: relative !important;
          overflow: hidden !important;
        }
        ${MULTI_GRID} > div[style*="padding-bottom"] {
          padding-bottom: 75% !important;
        }
        ${MULTI_GRID} > div[style*="padding-bottom"] + div {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
        }
        ${MULTI_GRID} [data-testid="tweetPhoto"] {
          margin: 0 !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
        }
        ${MULTI_GRID} [data-testid="tweetPhoto"] img {
          width: 100% !important;
          height: 100% !important;
          object-fit: cover !important;
          object-position: center !important;
        }
        ${MULTI_GRID} [data-testid="tweetPhoto"] div[style*="background-image"] {
          background-size: cover !important;
          background-position: center !important;
        }

        ${TWEET_PHOTO} [data-testid="previewInterstitial"] {
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
        }
      }
    `;
  }

  const TWIMG_MEDIA_PATHS = Object.freeze([
    "/media/",
    "/ext_tw_video_thumb/",
    "/amplify_video_thumb/",
    "/tweet_video_thumb/",
  ]);

  function upgradeImageUrl(urlString) {
    if (typeof urlString !== "string" || !urlString) return null;
    try {
      const url = new URL(urlString);
      if (url.hostname !== "pbs.twimg.com") return null;
      if (!TWIMG_MEDIA_PATHS.some(prefix => url.pathname.startsWith(prefix))) return null;
      const currentName = url.searchParams.get("name");
      if (currentName === "large" || currentName === "orig" || currentName === "4096x4096") return null;
      url.searchParams.set("name", "large");
      return url.toString();
    } catch {
      return null;
    }
  }

  function upgradeMediaInRoot(root) {
    if (!root) return 0;
    let upgradedCount = 0;

    // 1. Image elements (Tweet photos, Live Feed tiles, Saved Timeline cards)
    const imgSelector = '[data-testid="tweetPhoto"] img, .rd-lf-media-tile img, #yomikui-timeline-root .rd-tweet-card img';
    const images = [];
    if (root.nodeType === 1 && root.matches(imgSelector)) images.push(root);
    if (root.querySelectorAll) images.push(...root.querySelectorAll(imgSelector));

    for (const img of images) {
      const currentSrc = img.getAttribute("src") || img.src;
      const nextSrc = upgradeImageUrl(currentSrc);
      if (nextSrc && nextSrc !== currentSrc) {
        if (!img.dataset.yomikuiOrigSrc) img.dataset.yomikuiOrigSrc = currentSrc;
        img.src = nextSrc;
        upgradedCount++;
      }
    }

    // 2. Visual background-image elements used by X for tweet photos
    const bgSelector = '[data-testid="tweetPhoto"] div[style*="background-image"]';
    const bgDivs = [];
    if (root.nodeType === 1 && root.matches(bgSelector)) bgDivs.push(root);
    if (root.querySelectorAll) bgDivs.push(...root.querySelectorAll(bgSelector));

    for (const div of bgDivs) {
      const bgStyle = div.style.backgroundImage || "";
      const match = bgStyle.match(/url\(["']?([^"')]+)["']?\)/);
      if (match && match[1]) {
        const nextUrl = upgradeImageUrl(match[1]);
        if (nextUrl && nextUrl !== match[1]) {
          div.style.backgroundImage = `url("${nextUrl}")`;
          upgradedCount++;
        }
      }
    }

    return upgradedCount;
  }

  function createController({ window: win, document: doc }) {
    let settings = null;
    let visible = true;
    let observing = false;
    let timer = null;
    let resizeTimer = null;
    const pending = new Set();

    function isActive() {
      if (!doc || doc.hidden || !visible) return false;
      const mode = settings?.mediaSizeMode ?? "default";
      if (mode === "small") return false;
      const width = win.innerWidth || doc.documentElement?.clientWidth || 0;
      return width >= WIDE_MIN_WIDTH_PX;
    }

    function flush() {
      timer = null;
      if (!isActive()) {
        pending.clear();
        return;
      }
      for (const node of pending) {
        if (node && (node === doc || node.isConnected)) {
          upgradeMediaInRoot(node);
        }
      }
      pending.clear();
    }

    function schedule() {
      if (timer != null) return;
      timer = win.setTimeout(flush, 80);
    }

    function onMutations(records) {
      if (!isActive()) return;
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target) pending.add(target);
        if (record.addedNodes) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) pending.add(node);
          }
        }
      }
      if (pending.size) schedule();
    }

    const observer = typeof win.MutationObserver === "function"
      ? new win.MutationObserver(onMutations)
      : null;

    function sync() {
      const active = isActive();
      if (active) {
        if (!observing && observer && doc.documentElement) {
          observing = true;
          observer.observe(doc.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "style"],
          });
        }
        pending.add(doc);
        schedule();
      } else {
        if (observing && observer) {
          observer.disconnect();
          observing = false;
        }
        if (timer != null) {
          win.clearTimeout(timer);
          timer = null;
        }
        pending.clear();
      }
      return active;
    }

    function onResize() {
      if (resizeTimer != null) win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(() => {
        resizeTimer = null;
        if (sync()) upgradeMediaInRoot(doc);
      }, 150);
    }

    const listeners = [];
    const listen = (target, event, handler) => {
      if (target && target.addEventListener) {
        target.addEventListener(event, handler);
        listeners.push(() => target.removeEventListener(event, handler));
      }
    };

    listen(doc, "visibilitychange", () => sync());
    listen(win, "resize", onResize);
    listen(win, "yomikui-frame-column-visibility", e => {
      visible = e.detail?.visible !== false;
      sync();
    });

    return {
      update(nextSettings) {
        settings = nextSettings;
        sync();
      },
      setVisible(nextVisible) {
        visible = nextVisible !== false;
        sync();
      },
      flushNow() {
        if (timer != null) {
          win.clearTimeout(timer);
          timer = null;
        }
        flush();
      },
      dispose() {
        if (observer) observer.disconnect();
        if (timer != null) win.clearTimeout(timer);
        if (resizeTimer != null) win.clearTimeout(resizeTimer);
        listeners.forEach(remove => remove());
        listeners.length = 0;
        pending.clear();
      },
      isActive,
    };
  }

  let defaultController = null;
  function getDefaultController() {
    if (!defaultController && typeof window !== "undefined" && typeof document !== "undefined") {
      defaultController = createController({ window, document });
    }
    return defaultController;
  }

  function update(settings) {
    const controller = getDefaultController();
    controller?.update(settings);
  }

  globalThis.YomikuiWideMedia = Object.freeze({
    WIDE_MIN_WIDTH_REM,
    WIDE_MIN_WIDTH_PX,
    buildLayoutCss,
    buildMediaSizeCss,
    upgradeImageUrl,
    upgradeMediaInRoot,
    update,
    createController,
  });
})();
