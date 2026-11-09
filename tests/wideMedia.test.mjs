import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { Clock } from "./helpers.mjs";

const wideMediaSource = readFileSync(new URL("../wideMedia.js", import.meta.url), "utf8");
const iframeSource = readFileSync(new URL("../contentIframe.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

function loadWideMedia(customGlobals = {}) {
  const sandbox = {
    globalThis: {},
    URL,
    ...customGlobals,
  };
  sandbox.globalThis = sandbox;
  const fn = new Function("globalThis", "window", "document", "URL", wideMediaSource);
  fn(sandbox.globalThis, sandbox.window, sandbox.document, URL);
  return sandbox.globalThis.YomikuiWideMedia;
}

test("buildLayoutCss outputs 100% width rules across full X ancestor chain and branches on hideBanner", () => {
  const WideMedia = loadWideMedia();
  const hiddenBannerCss = WideMedia.buildLayoutCss({ hideBanner: true });
  assert.ok(hiddenBannerCss.includes("#react-root > div > div"));
  assert.ok(hiddenBannerCss.includes('main[role="main"]'));
  assert.ok(hiddenBannerCss.includes('main[role="main"] div:has([data-testid="primaryColumn"])'));
  assert.ok(hiddenBannerCss.includes('[data-testid="primaryColumn"] div:has([data-testid="cellInnerDiv"])'));
  assert.ok(hiddenBannerCss.includes('[data-testid="cellInnerDiv"] div:has(> article[data-testid="tweet"])'));
  assert.ok(hiddenBannerCss.includes(".r-1ye8kvj"));
  assert.ok(hiddenBannerCss.includes(':not(#layers):not(#layers *):not([role="dialog"])'));
  assert.ok(hiddenBannerCss.includes("max-width: 100% !important;"));
  assert.ok(hiddenBannerCss.includes('header[role="banner"] { display: none !important; }'));

  const visibleBannerCss = WideMedia.buildLayoutCss({ hideBanner: false });
  assert.ok(visibleBannerCss.includes('main[role="main"] div:has([data-testid="primaryColumn"])'));
  assert.ok(visibleBannerCss.includes("max-width: 100% !important;"));
  assert.ok(visibleBannerCss.includes('header[role="banner"]'));
  assert.ok(visibleBannerCss.includes("max-width: 88px !important;"));
  assert.ok(visibleBannerCss.includes("display: none !important;"));
});

test("buildMediaSizeCss generates responsive rules for default mode and proper overrides for small/large", () => {
  const WideMedia = loadWideMedia();

  // 1. default mode: responsive breakpoint at 36rem (576px)
  const defaultCss = WideMedia.buildMediaSizeCss("default");
  assert.ok(defaultCss.includes(`@media (min-width: ${WideMedia.WIDE_MIN_WIDTH_REM}rem)`));
  assert.ok(defaultCss.includes("max-height: 82vh !important;"));
  assert.ok(defaultCss.includes("padding-bottom: 75% !important;")); // 4:3 grid expansion
  assert.ok(defaultCss.includes("object-fit: contain !important;"));
  assert.ok(defaultCss.includes("object-fit: cover !important;"));
  assert.ok(defaultCss.includes("align-items: stretch !important;"));
  // Safeguards against nested text/small-card collapse and nested tweet selector bug
  assert.ok(defaultCss.includes('[data-testid="tweetText"]'));
  assert.ok(defaultCss.includes('[data-testid^="card.layoutSmall"]'));
  assert.ok(!defaultCss.includes(':has(article[data-testid="tweet"]'));

  // 2. small mode: fixed 140px height, no duplicated nested tweet selector
  const smallCss = WideMedia.buildMediaSizeCss("small");
  assert.ok(smallCss.includes("140px !important;"));
  assert.ok(!smallCss.includes("min-width: 36rem"));
  assert.ok(!smallCss.includes(':has(article[data-testid="tweet"]'));
  assert.ok(!smallCss.includes('article[data-testid="tweet"] a[role="link"][href*="/photo/2"]'));

  // 3. large mode: column stacked without 16:9 forced black bars
  const largeCss = WideMedia.buildMediaSizeCss("large");
  assert.ok(largeCss.includes("flex-direction: column !important;"));
  assert.ok(largeCss.includes("min-height: 420px !important;"));
  assert.ok(largeCss.includes("max-height: 85vh !important;"));
  assert.ok(!largeCss.includes("padding-bottom: 110%"));
  assert.ok(!largeCss.includes(':has(article[data-testid="tweet"]'));
});

test("upgradeImageUrl only promotes eligible twimg thumbnails and respects idempotency", () => {
  const WideMedia = loadWideMedia();

  // Target paths and small/custom sizes promote to large
  assert.equal(
    WideMedia.upgradeImageUrl("https://pbs.twimg.com/media/GFedCba?format=jpg&name=small"),
    "https://pbs.twimg.com/media/GFedCba?format=jpg&name=large"
  );
  assert.equal(
    WideMedia.upgradeImageUrl("https://pbs.twimg.com/media/GFedCba?format=jpg&name=360x360"),
    "https://pbs.twimg.com/media/GFedCba?format=jpg&name=large"
  );
  assert.equal(
    WideMedia.upgradeImageUrl("https://pbs.twimg.com/ext_tw_video_thumb/12345/pu/img/poster.jpg?name=small"),
    "https://pbs.twimg.com/ext_tw_video_thumb/12345/pu/img/poster.jpg?name=large"
  );
  assert.equal(
    WideMedia.upgradeImageUrl("https://pbs.twimg.com/amplify_video_thumb/98765/img/frame.jpg"),
    "https://pbs.twimg.com/amplify_video_thumb/98765/img/frame.jpg?name=large"
  );

  // Already high-res or orig remains null (no-op)
  assert.equal(WideMedia.upgradeImageUrl("https://pbs.twimg.com/media/GFedCba?format=jpg&name=large"), null);
  assert.equal(WideMedia.upgradeImageUrl("https://pbs.twimg.com/media/GFedCba?format=jpg&name=orig"), null);
  assert.equal(WideMedia.upgradeImageUrl("https://pbs.twimg.com/media/GFedCba?format=jpg&name=4096x4096"), null);

  // Excluded paths (avatars, icons, external domains) remain untouched
  assert.equal(WideMedia.upgradeImageUrl("https://pbs.twimg.com/profile_images/123/avatar.jpg?name=small"), null);
  assert.equal(WideMedia.upgradeImageUrl("https://example.com/media/photo.jpg?name=small"), null);
  assert.equal(WideMedia.upgradeImageUrl(""), null);
  assert.equal(WideMedia.upgradeImageUrl(null), null);
});

test("upgradeMediaInRoot upgrades both img src and visual background-image styles", () => {
  const WideMedia = loadWideMedia();
  const html = `
    <div>
      <article data-testid="tweet">
        <div data-testid="tweetPhoto">
          <div style="background-image: url('https://pbs.twimg.com/media/photo1?format=jpg&name=small');"></div>
          <img src="https://pbs.twimg.com/media/photo1?format=jpg&name=small">
        </div>
      </article>
      <div class="rd-lf-media-tile">
        <img src="https://pbs.twimg.com/media/photo2?format=jpg&name=360x360">
      </div>
      <div id="yomikui-timeline-root">
        <div class="rd-tweet-card">
          <img src="https://pbs.twimg.com/media/photo3?format=jpg&name=medium">
        </div>
      </div>
      <div data-testid="unrelated">
        <img src="https://pbs.twimg.com/profile_images/123/avatar.jpg">
      </div>
    </div>
  `;
  const { document } = parseHTML(html);

  const count = WideMedia.upgradeMediaInRoot(document);
  assert.equal(count, 4); // 1 bg + 1 tweetPhoto img + 1 liveFeed img + 1 timelineCard img

  const tweetImg = document.querySelector('[data-testid="tweetPhoto"] img');
  assert.equal(tweetImg.src, "https://pbs.twimg.com/media/photo1?format=jpg&name=large");
  assert.equal(tweetImg.dataset.yomikuiOrigSrc, "https://pbs.twimg.com/media/photo1?format=jpg&name=small");

  const tweetBg = document.querySelector('[data-testid="tweetPhoto"] div[style*="background-image"]');
  assert.ok(tweetBg.style.backgroundImage.includes("name=large"));

  const lfImg = document.querySelector(".rd-lf-media-tile img");
  assert.equal(lfImg.src, "https://pbs.twimg.com/media/photo2?format=jpg&name=large");

  // Re-running on already upgraded DOM changes nothing
  assert.equal(WideMedia.upgradeMediaInRoot(document), 0);
});

test("createController coordinates lifecycle, width threshold, and visibility changes", async () => {
  const clock = new Clock();
  const html = `
    <html>
      <head></head>
      <body>
        <article data-testid="tweet">
          <div data-testid="tweetPhoto">
            <img src="https://pbs.twimg.com/media/photo1?format=jpg&name=small">
          </div>
        </article>
      </body>
    </html>
  `;
  const dom = parseHTML(html);
  const win = {
    ...clock.globals(),
    innerWidth: 800, // >= 576px wide column
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    addEventListener(type, fn) { this[`on_${type}`] = fn; },
    removeEventListener(type) { delete this[`on_${type}`]; },
  };

  const WideMedia = loadWideMedia({ window: win, document: dom.document });
  const controller = WideMedia.createController({ window: win, document: dom.document });

  // 1. Initial wide state activates controller and upgrades images after batch delay
  controller.update({ mediaSizeMode: "default" });
  assert.equal(controller.isActive(), true);

  await clock.advance(80);
  const img = dom.document.querySelector("img");
  assert.equal(img.src, "https://pbs.twimg.com/media/photo1?format=jpg&name=large");

  // 2. Narrow column (< 576px) deactivates observation
  win.innerWidth = 480;
  controller.update({ mediaSizeMode: "default" });
  assert.equal(controller.isActive(), false);

  // 3. Widening on resize triggers debounced upgrade
  win.innerWidth = 900;
  img.src = "https://pbs.twimg.com/media/photo2?format=jpg&name=small";
  win.on_resize();
  await clock.advance(150);
  assert.equal(controller.isActive(), true);
  assert.equal(img.src, "https://pbs.twimg.com/media/photo2?format=jpg&name=large");

  // 4. Column hidden pauses observer
  win["on_yomikui-frame-column-visibility"]({ detail: { visible: false } });
  assert.equal(controller.isActive(), false);

  controller.dispose();
});

test("extension bundle wiring verifies wideMedia loading order and contentIframe integration", () => {
  // 1. Manifest includes wideMedia.js before contentIframe.js
  const frameScripts = manifest.content_scripts.find(c => c.all_frames && c.js.includes("contentIframe.js")).js;
  const wideIndex = frameScripts.indexOf("wideMedia.js");
  const iframeIndex = frameScripts.indexOf("contentIframe.js");
  assert.ok(wideIndex >= 0, "wideMedia.js must be registered in manifest");
  assert.ok(wideIndex < iframeIndex, "wideMedia.js must load before contentIframe.js");

  // 2. Head protection set includes iframe and media-size styles
  assert.ok(iframeSource.includes('"yomikui-iframe-styles"'));
  assert.ok(iframeSource.includes('"yomikui-media-size-styles"'));

  // 3. Hardcoded maxWidth: 600 in timeline and live feed containers is eliminated
  assert.ok(!iframeSource.includes("style:{maxWidth:600"));

  // 4. WideMedia delegated methods are invoked in contentIframe.js
  assert.ok(iframeSource.includes("YomikuiWideMedia?.buildLayoutCss"));
  assert.ok(iframeSource.includes("YomikuiWideMedia.buildMediaSizeCss"));
  assert.ok(iframeSource.includes("YomikuiWideMedia?.update"));
});
