import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { Clock, Events } from "./helpers.mjs";

const routingSource = readFileSync(new URL("../tweetRouting.js", import.meta.url), "utf8");
const actionsSource = readFileSync(new URL("../tweetActions.js", import.meta.url), "utf8");
const navSource = readFileSync(new URL("../columnNavigation.js", import.meta.url), "utf8");

function setup(html = "") {
  const clock = new Clock();
  const { document, Event } = parseHTML(`<html><head></head><body>${html}</body></html>`);
  document.hidden = false;
  const window = new Events();
  window.parent = { postMessage() {} };
  window.location = {
    href: "https://x.com/home#yomikui-col1",
    origin: "https://x.com",
    hostname: "x.com",
    pathname: "/home",
    hash: "#yomikui-col1",
  };
  window.history = {
    pushState: (_state, _title, url) => {
      window.location.href = `https://x.com${url}`;
      window.location.pathname = url.split("?")[0].split("#")[0];
    },
  };
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    emit(records = []) { if (this.connected) this.callback(records); }
  }
  const context = vm.createContext({
    ...clock.globals(),
    URL,
    window,
    document,
    MutationObserver,
    PopStateEvent: Event,
  });
  vm.runInContext(navSource, context);
  vm.runInContext(actionsSource, context);
  vm.runInContext(routingSource, context);

  return { clock, document, window, observers, Event, context, routing: context.YomikuiTweetRouting };
}

test("normalizeStatusPath accepts valid paths and rejects invalid ones", () => {
  const { routing } = setup();
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890"), "/author/status/1234567890");
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890/"), "/author/status/1234567890");
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890?s=20#yomikui"), "/author/status/1234567890");
  assert.equal(routing.normalizeStatusPath("https://x.com/author/status/1234567890"), "/author/status/1234567890");
  assert.equal(routing.normalizeStatusPath("https://twitter.com/i/web/status/9876543210"), "/i/web/status/9876543210");
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890/quotes"), "/author/status/1234567890/quotes");
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890/retweets"), "/author/status/1234567890/retweets");
  assert.equal(routing.normalizeStatusPath("https://x.com/author/status/1234567890?s=20"), "/author/status/1234567890");

  assert.equal(routing.normalizeStatusPath("//evil.com/author/status/1234567890"), null);
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890/photo/1"), null);
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890/analytics"), null);
  assert.equal(routing.normalizeStatusPath("/author/status/1234567890/video/1"), null);
  assert.equal(routing.normalizeStatusPath("https://google.com/author/status/1234567890"), null);
  assert.equal(routing.normalizeStatusPath("javascript:alert(1)"), null);
  assert.equal(routing.normalizeStatusPath(""), null);
  assert.equal(routing.normalizeStatusPath(null), null);
});

test("isTargetEligible and isSourceEligible filter column types correctly", () => {
  const { routing } = setup();
  assert.equal(routing.isTargetEligible({ type: "home", liveFeed: false }), true);
  assert.equal(routing.isTargetEligible({ type: "search", liveFeed: false }), true);
  assert.equal(routing.isTargetEligible({ type: "timeline", liveFeed: false }), false);
  assert.equal(routing.isTargetEligible({ type: "chat", liveFeed: false }), false);
  assert.equal(routing.isTargetEligible({ type: "home", liveFeed: true }), false);

  assert.equal(routing.isSourceEligible({ type: "home", liveFeed: false }), true);
  assert.equal(routing.isSourceEligible({ type: "home", liveFeed: true }), true);
  assert.equal(routing.isSourceEligible({ type: "timeline" }), false);
  assert.equal(routing.isSourceEligible({ type: "chat" }), false);
});

test("findTargetColumn memoizes per array and normalizeTargets enforces single target invariant", () => {
  const { routing } = setup();
  const col1 = { id: "col1", type: "home", tweetTarget: false };
  const col2 = { id: "col2", type: "search", tweetTarget: true };
  const col3 = { id: "col3", type: "home", tweetTarget: true };
  const arr = [col1, col2, col3];

  assert.equal(routing.findTargetColumn(arr)?.id, "col2");
  assert.equal(routing.findTargetColumn(arr)?.id, "col2");

  const normalized = routing.normalizeTargets(arr);
  assert.equal(normalized[1].tweetTarget, true);
  assert.equal(normalized[2].tweetTarget, false);

  // Already-valid array returns identical reference
  assert.equal(routing.normalizeTargets(normalized), normalized);

  // Ineligible target column (e.g. chat or liveFeed) is unset
  const ineligible = [
    { id: "c1", type: "chat", tweetTarget: true },
    { id: "c2", type: "home", liveFeed: true, tweetTarget: true },
  ];
  const normIneligible = routing.normalizeTargets(ineligible);
  assert.equal(normIneligible[0].tweetTarget, false);
  assert.equal(normIneligible[1].tweetTarget, false);
});

test("shouldRoute only routes from eligible sources to a different target", () => {
  const { routing } = setup();
  const target = { id: "target", type: "search", tweetTarget: true };
  const source1 = { id: "s1", type: "home", openTweetsInTarget: true };
  const source2 = { id: "s2", type: "home", openTweetsInTarget: false };
  const columns = [source1, source2, target];

  assert.equal(routing.shouldRoute(source1, columns)?.id, "target");
  assert.equal(routing.shouldRoute(source2, columns), null);
  assert.equal(routing.shouldRoute(target, columns), null);
  assert.equal(routing.shouldRoute({ id: "chat", type: "chat" }, columns), null);
});

test("isFullyVisible checks horizontal viewport boundaries with tolerance", () => {
  const { routing } = setup();
  const vp = { left: 100, right: 500 };
  assert.equal(routing.isFullyVisible({ left: 100, right: 500 }, vp), true);
  assert.equal(routing.isFullyVisible({ left: 120, right: 480 }, vp), true);
  assert.equal(routing.isFullyVisible({ left: 99, right: 500 }, vp), true);
  assert.equal(routing.isFullyVisible({ left: 90, right: 400 }, vp), false);
  assert.equal(routing.isFullyVisible({ left: 200, right: 510 }, vp), false);
});

test("peekPendingSrc, takePendingSrc, and clearPending manage lazy-mount pending URLs", () => {
  const { routing } = setup(`<div data-column-id="t1"></div>`);
  const cols = [
    { id: "s1", type: "home", openTweetsInTarget: true },
    { id: "t1", type: "search", tweetTarget: true },
  ];

  routing.route({ columns: cols, sourceId: "s1", statusPath: "/author/status/789" });
  // peekPendingSrc reads without consuming so initial <iframe src> and [Ge,q] effect agree
  assert.equal(routing.peekPendingSrc("t1", "https://x.com/home?y=1#c"), "https://x.com/author/status/789?y=1#c");
  assert.equal(routing.takePendingSrc("t1", "https://x.com/home?y=1#c"), "https://x.com/author/status/789?y=1#c");
  // Subsequent calls return unchanged src
  assert.equal(routing.peekPendingSrc("t1", "https://x.com/home?y=1#c"), "https://x.com/home?y=1#c");
  assert.equal(routing.takePendingSrc("t1", "https://x.com/home?y=1#c"), "https://x.com/home?y=1#c");

  routing.route({ columns: cols, sourceId: "s1", statusPath: "/author/status/999" });
  routing.clearPending("t1");
  assert.equal(routing.takePendingSrc("t1", "https://x.com/home?y=1#c"), "https://x.com/home?y=1#c");
});

test("resolveClickTarget handles tweets, quote cards, list buttons, show-more, dialogs, and selections", () => {
  const tweetHtml = `
    <article data-testid="tweet" id="tweet-101">
      <div data-testid="User-Name"><a href="/author/status/101"><time>Now</time></a></div>
      <div data-testid="tweetText">
        Tweet text with <a href="https://example.com" id="ext-link">link</a>,
        <a href="/hashtag/test" id="hashtag">#test</a>, and
        <a href="/author/status/101" data-testid="tweet-text-show-more-link" id="show-more">Show more</a>
      </div>
      <div data-testid="tweetQuote" id="quote-card-1">
        <a href="/quoted/status/202" id="quote-permalink">Quoted</a>
      </div>
      <div role="link" id="media-quote-card">
        <span id="media-quote-text">Quoted media caption</span>
        <a href="/quoted2/status/303/photo/1"><div data-testid="tweetPhoto" id="quote-photo">Img</div></a>
      </div>
      <div role="group" id="action-bar">
        <div><button data-testid="reply" id="reply-btn">Reply</button></div>
        <div data-yomikui-tweet-action="quotes"><a href="https://x.com/author/status/101/quotes#yomikui" id="quote-list-btn"><svg id="quote-svg"></svg></a></div>
      </div>
    </article>
    <div role="dialog">
      <article data-testid="tweet" id="dialog-tweet">
        <div data-testid="User-Name"><a href="/other/status/404"><time>1m</time></a></div>
      </article>
    </div>
  `;
  const { routing, document, window } = setup(tweetHtml);

  const clickEvent = (target, props = {}) => ({
    button: 0,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() {},
    ...props,
  });

  const tweet = document.getElementById("tweet-101");
  routing.setFrameEnabled(false);
  assert.equal(routing.resolveClickTarget(clickEvent(tweet)), null);

  routing.setFrameEnabled(true);
  assert.equal(routing.isFrameEnabled(), true);

  // Main tweet & timestamp
  assert.equal(routing.resolveClickTarget(clickEvent(tweet)), "/author/status/101");
  assert.equal(routing.resolveClickTarget(clickEvent(tweet.querySelector("time"))), "/author/status/101");

  // Quote list action link (including inner SVG)
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("quote-list-btn"))), "/author/status/101/quotes");
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("quote-svg"))), "/author/status/101/quotes");

  // Bare click on role="group" action bar padding is ignored
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("action-bar"))), null);

  // Quote tweet cards (tweetQuote & media-only role="link" card)
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("quote-permalink"))), "/quoted/status/202");
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("quote-card-1"))), "/quoted/status/202");
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("media-quote-text"))), "/quoted2/status/303");
  // Clicking photo inside quote card opens lightbox instead of routing
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("quote-photo"))), null);

  // Show-more link (even as <a href="/author/status/101">), external links, hashtags, buttons, dialogs
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("show-more"))), null);
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("ext-link"))), null);
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("hashtag"))), null);
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("reply-btn"))), null);
  assert.equal(routing.resolveClickTarget(clickEvent(document.getElementById("dialog-tweet"))), null);

  // Active non-collapsed text selection skips routing
  window.getSelection = () => ({ isCollapsed: false, toString: () => "selected text" });
  assert.equal(routing.resolveClickTarget(clickEvent(tweet)), null);
  window.getSelection = () => ({ isCollapsed: true, toString: () => "" });
  assert.equal(routing.resolveClickTarget(clickEvent(tweet)), "/author/status/101");
});

test("installFrame dynamically attaches click listener only while enabled and validates message origin", () => {
  const { routing, document, window } = setup();
  let addCount = 0;
  let removeCount = 0;
  const origAdd = document.addEventListener.bind(document);
  const origRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    if (type === "click") addCount++;
    return origAdd(type, fn, opts);
  };
  document.removeEventListener = (type, fn, opts) => {
    if (type === "click") removeCount++;
    return origRemove(type, fn, opts);
  };

  routing.installFrame({ getColumnId: () => "col1", getParentOrigin: () => "https://x.com" });
  // Disabled by default -> zero capture click listeners registered
  assert.equal(addCount, 0);

  routing.setFrameEnabled(true);
  assert.equal(addCount, 1);
  routing.setFrameEnabled(true); // idempotent
  assert.equal(addCount, 1);

  routing.setFrameEnabled(false);
  assert.equal(removeCount, 1);

  // Message origin & source validation
  let pushedUrl = null;
  window.history.pushState = (_s, _t, url) => { pushedUrl = url; };

  // Untrusted origin is rejected
  window.dispatchEvent({
    type: "message",
    source: window.parent,
    origin: "https://evil.example",
    data: { type: "yomikui-tweet-route-open", path: "/author/status/111" },
  });
  assert.equal(pushedUrl, null);

  // Wrong source is rejected
  window.dispatchEvent({
    type: "message",
    source: {},
    origin: "https://x.com",
    data: { type: "yomikui-tweet-route-open", path: "/author/status/111" },
  });
  assert.equal(pushedUrl, null);

  // Valid parent + x.com origin navigates cleanly
  window.dispatchEvent({
    type: "message",
    source: window.parent,
    origin: "https://x.com",
    data: { type: "yomikui-tweet-route-open", path: "/author/status/111" },
  });
  assert.equal(pushedUrl, "/author/status/111#yomikui-col1");
});

test("route checks columnComposing, scrolls only when offscreen, handles about:blank, and deduplicates focus timers", async () => {
  const { routing, document, window, clock } = setup(`
    <div id="scroller">
      <div data-column-id="s1"></div>
      <div data-column-id="t1"><iframe src="https://x.com/home#yomikui-t1"></iframe></div>
    </div>
  `);
  window.innerWidth = 1000;
  const scroller = document.getElementById("scroller");
  window.getComputedStyle = el => (el === scroller ? { overflowX: "auto" } : {});
  scroller.getBoundingClientRect = () => ({ left: 0, right: 1000 });

  const targetDiv = document.querySelector('[data-column-id="t1"]');
  let colBounds = { left: 200, right: 600 };
  let scrollCalls = 0;
  targetDiv.getBoundingClientRect = () => colBounds;
  targetDiv.scrollIntoView = () => { scrollCalls++; };

  const iframe = document.querySelector("iframe");
  let postedMessage = null;
  iframe.contentWindow = {
    location: { href: "https://x.com/home#yomikui-t1", origin: "https://x.com" },
    postMessage: msg => { postedMessage = msg; },
  };

  const cols = [
    { id: "s1", type: "home", openTweetsInTarget: true },
    { id: "t1", type: "search", tweetTarget: true },
  ];

  // Composing guard skips routing so drafts are preserved
  assert.equal(
    routing.route({ columns: cols, columnComposing: { t1: true }, sourceId: "s1", statusPath: "/author/status/555" }),
    false
  );
  assert.equal(postedMessage, null);

  // Visible target column: routes WITHOUT horizontal scrolling
  assert.equal(
    routing.route({ columns: cols, columnComposing: { t1: false }, sourceId: "s1", statusPath: "/author/status/555" }),
    true
  );
  assert.equal(postedMessage?.path, "/author/status/555");
  assert.equal(scrollCalls, 0);
  assert.equal(targetDiv.classList.contains("rd-column-focused"), true);

  // Offscreen target column + overlapping focus timer: scrolls and extends focus timer cleanly
  await clock.advance(1000);
  colBounds = { left: 800, right: 1200 };
  assert.equal(routing.route({ columns: cols, sourceId: "s1", statusPath: "/author/status/556" }), true);
  assert.equal(scrollCalls, 1);
  await clock.advance(700); // 1700ms after first click, 700ms after second -> must still be focused!
  assert.equal(targetDiv.classList.contains("rd-column-focused"), true);
  await clock.advance(900);
  assert.equal(targetDiv.classList.contains("rd-column-focused"), false);

  // about:blank iframe updates iframe.src directly instead of dropping postMessage
  postedMessage = null;
  iframe.contentWindow.location = { href: "about:blank", origin: "null" };
  assert.equal(routing.route({ columns: cols, sourceId: "s1", statusPath: "/author/status/557" }), true);
  assert.equal(postedMessage, null);
  assert.equal(iframe.src, "https://x.com/author/status/557#yomikui-t1");
});

test("openInPlace ignores pre-existing tweets/cells and cancels fallback reload once new content arrives", async () => {
  const html = `
    <div data-testid="primaryColumn" id="primary">
      <article data-testid="tweet" id="old-tweet"><a href="/author/status/888">Old</a></article>
      <div data-testid="UserCell" id="old-cell">Old user</div>
    </div>
  `;
  const { routing, document, window, observers, clock } = setup(html);
  let hrefReloads = 0;
  let currentHref = "https://x.com/home#yomikui-col1";
  window.location = {
    get href() { return currentHref; },
    set href(val) { currentHref = val; hrefReloads++; },
    pathname: "/home",
    hash: "#yomikui-col1",
  };
  window.history.pushState = (_s, _t, url) => {
    currentHref = `https://x.com${url}`;
    window.location.pathname = url.split("?")[0].split("#")[0];
  };

  // 1. Navigating to /author/status/888 must NOT false-match #old-tweet already in DOM
  routing.openInPlace("/author/status/888");
  const obs1 = observers.at(-1);
  assert.equal(obs1.connected, true);
  obs1.emit([{}]);
  await clock.advance(100);
  // Still waiting because #old-tweet was in priorNodes
  assert.equal(obs1.connected, true);

  // Now X mounts the new detail article -> observer disconnects and 2.5s reload is skipped!
  const primary = document.getElementById("primary");
  const newArticle = document.createElement("article");
  newArticle.setAttribute("data-testid", "tweet");
  newArticle.innerHTML = `<a href="/author/status/888">Focal</a>`;
  primary.appendChild(newArticle);
  obs1.emit([{}]);
  await clock.advance(100);
  assert.equal(obs1.connected, false);
  await clock.advance(3000);
  assert.equal(hrefReloads, 0);

  // 2. Navigating from /author/status/888 to /author/status/888/retweets is NOT skipped,
  //    does NOT false-match #old-cell, and resolves cleanly when the matching tab arrives
  routing.openInPlace("/author/status/888/retweets");
  const obs2 = observers.at(-1);
  assert.equal(obs2.connected, true);
  obs2.emit([{}]);
  await clock.advance(100);
  assert.equal(obs2.connected, true);

  const tab = document.createElement("a");
  tab.setAttribute("role", "tab");
  tab.setAttribute("href", "/author/status/888/retweets");
  primary.appendChild(tab);
  obs2.emit([{}]);
  await clock.advance(100);
  assert.equal(obs2.connected, false);
  await clock.advance(3000);
  assert.equal(hrefReloads, 0);
});

test("SettingsControls renders target and source options according to eligibility", () => {
  const { routing } = setup();
  const element = (type, props, key) => ({ type, props, key });
  const jsx = { jsx: element, jsxs: element, Fragment: "Fragment" };
  const t = (key, args) => `${key}:${args ? args.join(",") : ""}`;

  const col1 = { id: "col1", title: "Home", type: "home", tweetTarget: false, openTweetsInTarget: true };
  const col2 = { id: "col2", title: "Target Col", type: "search", tweetTarget: true };
  const columns = [col1, col2];

  const result1 = routing.SettingsControls({
    column: col1,
    columns,
    onChange: () => {},
    onSetTarget: () => {},
    Switch: "Switch",
    Label: "Label",
    jsx,
    t,
    rowClassName: "row",
  });
  assert.ok(result1);
  assert.equal(result1.props.children[0].key, "tweetTarget");
  assert.equal(result1.props.children[1].key, "openTweetsInTarget");

  const result2 = routing.SettingsControls({
    column: col2,
    columns,
    onChange: () => {},
    onSetTarget: () => {},
    Switch: "Switch",
    Label: "Label",
    jsx,
    t,
    rowClassName: "row",
  });
  assert.ok(result2);
  assert.equal(result2.props.children[0].key, "tweetTarget");
  assert.equal(result2.props.children[1], null);
});

test("contentDeck store setTweetTargetColumn enforces eligibility, mutual exclusion, and clears pending paths", () => {
  const deckSource = readFileSync(new URL("../contentDeck.js", import.meta.url), "utf8");
  const { context, routing, document } = setup(`<div data-column-id="c1"></div><div data-column-id="c2"></div>`);
  Object.assign(context, {
    crypto: { randomUUID },
    console: { log() {}, warn() {}, error() {} },
    chrome: { runtime: { getManifest: () => ({ version: "0.1.0" }) } },
    queueMicrotask,
  });
  vm.runInContext(readFileSync(new URL("../columnLayout.js", import.meta.url), "utf8"), context);
  const end = deckSource.indexOf(";var Im=[];");
  assert.ok(end > 0);
  vm.runInContext(
    deckSource.slice(0, end) + `;
    Ln = async () => undefined;
    ra = async () => {};
    globalThis.deckStore = Ut;
    globalThis.createColumn = _h;
  })();`,
    context
  );

  const { deckStore, createColumn } = context;
  const c1 = { ...createColumn("home", "#1d9bf0"), id: "c1" };
  const c2 = { ...createColumn("search", "#00ba7c"), id: "c2" };
  const cChat = { ...createColumn("chat", "#f91880"), id: "cChat" };
  const cLive = { ...createColumn("home", "#ffad1f"), id: "cLive", liveFeed: true };
  deckStore.setState({ activeWorkspaceId: "ws", columns: [c1, c2, cChat, cLive], workspaces: [] });

  // Ineligible columns cannot be marked as target
  deckStore.getState().setTweetTargetColumn("cChat", true);
  deckStore.getState().setTweetTargetColumn("cLive", true);
  assert.equal(routing.findTargetColumn(deckStore.getState().columns), null);

  // Mark c1 as target, queue a pending path on c1, then switch target to c2 -> c1 unset & pending cleared
  deckStore.getState().setTweetTargetColumn("c1", true);
  assert.equal(routing.findTargetColumn(deckStore.getState().columns)?.id, "c1");
  routing.route({ columns: deckStore.getState().columns, sourceId: "c2", statusPath: "/author/status/777" });
  assert.equal(routing.peekPendingSrc("c1", "https://x.com/home"), "https://x.com/author/status/777");

  deckStore.getState().setTweetTargetColumn("c2", true);
  assert.equal(routing.findTargetColumn(deckStore.getState().columns)?.id, "c2");
  assert.equal(deckStore.getState().columns.find(c => c.id === "c1").tweetTarget, false);
  assert.equal(routing.peekPendingSrc("c1", "https://x.com/home"), "https://x.com/home");
});

test("extension bundle and manifests integrate YomikuiTweetRouting correctly", () => {
  const deck = readFileSync(new URL("../contentDeck.js", import.meta.url), "utf8");
  const iframe = readFileSync(new URL("../contentIframe.js", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const jaLocale = JSON.parse(readFileSync(new URL("../_locales/ja/messages.json", import.meta.url), "utf8"));

  // Check contentDeck bundle integration (including [Ge,q] lazy-mount, peekPendingSrc, O(1) routeTweets, timeline fallback)
  assert.match(deck, /tweetTarget:Re\.boolean\(\)\.catch\(!1\)/);
  assert.match(deck, /openTweetsInTarget:Re\.boolean\(\)\.catch\(!0\)/);
  assert.match(deck, /setTweetTargetColumn\(columnId,enabled\)/);
  assert.match(deck, /globalThis\.YomikuiTweetRouting\?\.route/);
  assert.match(deck, /globalThis\.YomikuiTweetRouting\?\.peekPendingSrc/);
  assert.match(deck, /\[Ge,q\]/);
  assert.match(deck, /an\(kx\(it\.current,q\)\)\},\[kt,q\]/);
  assert.match(deck, /routeTweets:Boolean\(TtId&&TtId!==e\.id/);
  assert.match(deck, /if\(e\.type==="timeline"\)/);
  assert.match(deck, /globalThis\.YomikuiTweetRouting\.SettingsControls/);

  // Check contentIframe bundle integration (native + Live Feed)
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.setFrameEnabled/);
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.isFrameEnabled/);
  assert.match(iframe, /openLiveFeedTweetInSelf/);
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.installFrame/);

  // Check manifest content_scripts
  const deckScripts = manifest.content_scripts.find(cs => cs.matches.some(m => m.includes("/yomikui*"))).js;
  const iframeScripts = manifest.content_scripts.find(cs => cs.all_frames === true && cs.run_at === "document_start" && !cs.world).js;
  assert.ok(deckScripts.indexOf("tweetRouting.js") > deckScripts.indexOf("tweetActions.js"));
  assert.ok(iframeScripts.indexOf("tweetRouting.js") > iframeScripts.indexOf("tweetActions.js"));

  // Check translation keys in ja locale and fallback
  const keys = [
    "column_settings_tweet_target",
    "column_settings_tweet_target_desc",
    "column_settings_open_in_target",
    "column_settings_open_in_target_desc",
    "column_settings_open_in_target_none",
  ];
  for (const key of keys) {
    assert.ok(jaLocale[key], `_locales/ja/messages.json contains ${key}`);
    assert.ok(deck.includes(`"${key}":`), `contentDeck.js contains ${key}`);
  }
});
