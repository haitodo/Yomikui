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
    URLSearchParams,
    window,
    document,
    MutationObserver,
    PopStateEvent: Event,
  });
  vm.runInContext(navSource, context);
  vm.runInContext(actionsSource, context);
  const captureListeners = new Map();
  const addListener = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    if (options === true) captureListeners.set(type, listener);
    addListener(type, listener, options);
  };
  vm.runInContext(routingSource, context);

  // Linkedom dispatches bubbling listeners only. Exercise the registered capture handler.
  const activate = (id, options = {}, type = "click") => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: type === "auxclick" ? 1 : 0,
      target: document.getElementById(id),
      ...options,
    });
    captureListeners.get(type)?.(event);
    return event;
  };
  return { clock, document, window, observers, activate, context, routing: context.YomikuiTweetRouting };
}

test("normalizeRoutePath accepts X internal browseable pages and rejects modals/external URLs", () => {
  const { routing } = setup();
  // Tweets & engagement lists
  assert.equal(routing.normalizeRoutePath("/author/status/1234567890?s=20"), "/author/status/1234567890");
  assert.equal(routing.normalizeRoutePath("https://x.com/author/status/1234567890/retweets#yomikui"), "/author/status/1234567890/retweets");
  assert.equal(routing.normalizeRoutePath("/author/status/1234567890/quotes"), "/author/status/1234567890/quotes");
  assert.equal(routing.normalizeRoutePath("/author/status/1234567890/likes"), "/author/status/1234567890/likes");
  assert.equal(routing.normalizeRoutePath("https://twitter.com/i/web/status/9876543210"), "/i/web/status/9876543210");

  // User profiles, hashtags, search queries, lists
  assert.equal(routing.normalizeRoutePath("/target_user"), "/target_user");
  assert.equal(routing.normalizeRoutePath("https://x.com/target_user/"), "/target_user");
  assert.equal(routing.normalizeRoutePath("/target_user/with_replies"), "/target_user/with_replies");
  assert.equal(routing.normalizeRoutePath("/target_user/following"), "/target_user/following");
  assert.equal(routing.normalizeRoutePath("/hashtag/AI?src=hashtag_click"), "/hashtag/AI?src=hashtag_click");
  assert.equal(routing.normalizeRoutePath("/search?q=%24NVDA&yomikui=123"), "/search?q=%24NVDA");
  assert.equal(routing.normalizeRoutePath("/i/lists/55555"), "/i/lists/55555");

  // Rejected modals, media viewers, compose, auth, external links
  assert.equal(routing.normalizeRoutePath("/author/status/1234567890/photo/1"), null);
  assert.equal(routing.normalizeRoutePath("/author/status/1234567890/video/1"), null);
  assert.equal(routing.normalizeRoutePath("/author/status/1234567890/analytics"), null);
  assert.equal(routing.normalizeRoutePath("/target_user/photo"), null);
  assert.equal(routing.normalizeRoutePath("/target_user/header_photo"), null);
  assert.equal(routing.normalizeRoutePath("/compose/post"), null);
  assert.equal(routing.normalizeRoutePath("/intent/tweet"), null);
  assert.equal(routing.normalizeRoutePath("/settings/profile"), null);
  assert.equal(routing.normalizeRoutePath("/messages"), null);
  assert.equal(routing.normalizeRoutePath("/i/chat"), null);
  assert.equal(routing.normalizeRoutePath("/i/grok"), null);
  assert.equal(routing.normalizeRoutePath("/yomikui"), null);
  assert.equal(routing.normalizeRoutePath("/search?q=yomikui-timeline"), null);
  assert.equal(routing.normalizeRoutePath("https://t.co/abc123"), null);
  assert.equal(routing.normalizeRoutePath("https://example.com/target_user"), null);
  assert.equal(routing.normalizeRoutePath("//evil.com/target_user"), null);
  assert.equal(routing.normalizeRoutePath("javascript:alert(1)"), null);
  assert.equal(routing.normalizeRoutePath("/"), null);
  assert.equal(routing.normalizeRoutePath(""), null);
});

test("resolveTargetColumn supports specific column IDs, 'next' right-neighbor chaining, and sanitizeColumns", () => {
  const { routing } = setup();
  const c1 = { id: "c1", type: "home", linkTarget: "" };
  const c2 = { id: "c2", type: "home", linkTarget: "c3" };
  const c3 = { id: "c3", type: "search", linkTarget: "next" };
  const c4 = { id: "c4", type: "customUrl", linkTarget: "next" };
  const cols = [c1, c2, c3, c4];

  assert.equal(routing.resolveTargetColumn(c1, cols), null);
  assert.equal(routing.resolveTargetColumn(c2, cols)?.id, "c3"); // Col 2 -> Col 3 (by ID)
  assert.equal(routing.resolveTargetColumn(c3, cols)?.id, "c4"); // Col 3 -> Col 4 ("next")
  assert.equal(routing.resolveTargetColumn(c4, cols), null);     // Rightmost "next" -> null

  // If Col 4 switches to Live Feed, Col 3's "next" becomes ineligible -> null
  const colsWithLive = [c1, c2, c3, { ...c4, liveFeed: true }];
  assert.equal(routing.resolveTargetColumn(c3, colsWithLive), null);

  // sanitizeColumns preserves valid IDs and "next", clears deleted IDs and self-links
  const dirty = [
    { id: "c1", type: "home", linkTarget: "deleted_id" },
    { id: "c2", type: "home", linkTarget: "c2" },
    { id: "c3", type: "search", linkTarget: "next" },
    { id: "c4", type: "chat", linkTarget: "c1" },
  ];
  const cleaned = routing.sanitizeColumns(dirty);
  assert.equal(cleaned[0].linkTarget, "");
  assert.equal(cleaned[1].linkTarget, "");
  assert.equal(cleaned[2].linkTarget, "next");
  assert.equal(cleaned[3].linkTarget, "");
});

test("chained 4-column workflow: Col 2 -> Col 3 (retweet list) -> Col 4 (user profile)", () => {
  const { routing, document } = setup(`
    <div data-column-id="c1"><iframe src="https://x.com/home#yomikui-c1"></iframe></div>
    <div data-column-id="c2"><iframe src="https://x.com/home#yomikui-c2"></iframe></div>
    <div data-column-id="c3"><iframe src="https://x.com/search#yomikui-c3"></iframe></div>
    <div data-column-id="c4"><iframe src="https://x.com/search#yomikui-c4"></iframe></div>
  `);

  const received = {};
  for (const id of ["c1", "c2", "c3", "c4"]) {
    const iframe = document.querySelector(`[data-column-id="${id}"] iframe`);
    iframe.contentWindow = {
      location: { href: iframe.src, origin: "https://x.com" },
      postMessage: msg => { received[id] = msg; },
    };
  }

  const columns = [
    { id: "c1", type: "notifications", linkTarget: "" },
    { id: "c2", type: "home", linkTarget: "c3" },
    { id: "c3", type: "search", linkTarget: "c4" },
    { id: "c4", type: "customUrl", linkTarget: "" },
  ];

  // Step 1: In Col 2, open a tweet's retweet list -> opens in Col 3
  assert.equal(routing.route({ columns, sourceId: "c2", statusPath: "/author/status/101/retweets" }), true);
  assert.equal(received.c3?.path, "/author/status/101/retweets");
  assert.equal(received.c4, undefined);

  // Step 2: In Col 3, open a user from the retweet list -> opens in Col 4
  assert.equal(routing.route({ columns, sourceId: "c3", statusPath: "/retweeter_user" }), true);
  assert.equal(received.c4?.path, "/retweeter_user");

  // Step 3: In Col 4 (linkTarget: ""), route returns false so Col 4 navigates in-place
  assert.equal(routing.route({ columns, sourceId: "c4", statusPath: "/retweeter_user/status/999" }), false);
});

test("withPendingPath replaces stale search queries while preserving yomikui param and hash", () => {
  const { routing } = setup();
  const searchSrc = "https://x.com/search?q=old_query&yomikui=abc#yomikui-c3";
  assert.equal(
    routing.withPendingPath(searchSrc, "/target_user"),
    "https://x.com/target_user?yomikui=abc#yomikui-c3"
  );
  assert.equal(
    routing.withPendingPath(searchSrc, "/search?q=new_topic"),
    "https://x.com/search?q=new_topic&yomikui=abc#yomikui-c3"
  );
});

test("resolveClickTarget handles tweets, UserCell rows, profiles, hashtags, and excludes tabs/search/modals", () => {
  const html = `
    <header role="banner"><a href="/home" id="nav-home">Home</a></header>
    <div data-testid="primaryColumn">
      <button data-testid="app-bar-back" id="back-btn">Back</button>
      <form role="search"><input id="search-input" /><a href="/search?q=typed" id="search-form-link">Go</a></form>
      <div role="tablist">
        <a role="tab" href="/target_user/with_replies" id="profile-tab">Replies</a>
      </div>

      <article data-testid="tweet" id="tweet-101">
        <div data-testid="Tweet-User-Avatar"><a href="/tweet_author" id="author-avatar">Avatar</a></div>
        <div data-testid="User-Name"><a href="/tweet_author/status/101"><time id="tweet-time">Now</time></a></div>
        <div data-testid="tweetText">
          Hello <a href="/mentioned_user" id="mention">@mentioned_user</a>
          <a href="/hashtag/Yomikui?src=hashtag_click" id="hashtag">#Yomikui</a>
          <a href="https://t.co/ext123" id="tco-link">https://example.com</a>
          <a href="/tweet_author/status/101" data-testid="tweet-text-show-more-link" id="show-more">Show more</a>
        </div>
        <div data-testid="tweetQuote" id="quote-card">
          <a href="/quoted_user/status/202" id="quote-link">Quoted</a>
        </div>
        <div role="group" id="action-bar">
          <button data-testid="like" id="like-btn">Like</button>
          <div data-yomikui-tweet-action="retweets"><a href="https://x.com/tweet_author/status/101/retweets#yomikui" id="rt-list-btn">RTs</a></div>
        </div>
      </article>

      <div data-testid="UserCell" role="button" id="user-cell">
        <a href="/cell_owner" id="cell-avatar">Img</a>
        <a href="/cell_owner" id="cell-name">Cell Owner</a>
        <button data-testid="123-follow" id="cell-follow-btn">Follow</button>
        <div data-testid="UserDescription" id="cell-bio">
          Bio mentioning <a href="/bio_friend" id="cell-bio-mention">@bio_friend</a>
          <span id="cell-bio-plain">and plain bio text</span>
        </div>
      </div>
    </div>
  `;
  const { routing, document } = setup(html);
  routing.setFrameEnabled(true);

  const click = (id, props = {}) => ({
    button: 0,
    target: document.getElementById(id),
    defaultPrevented: false,
    ...props,
  });

  // Tweet & quote & engagement list links
  assert.equal(routing.resolveClickTarget(click("tweet-101")), "/tweet_author/status/101");
  assert.equal(routing.resolveClickTarget(click("tweet-time")), "/tweet_author/status/101");
  assert.equal(routing.resolveClickTarget(click("quote-card")), "/quoted_user/status/202");
  assert.equal(routing.resolveClickTarget(click("rt-list-btn")), "/tweet_author/status/101/retweets");

  // Author profile, @mention, #hashtag -> profiles default to /all, hashtag remains
  assert.equal(routing.resolveClickTarget(click("author-avatar")), "/tweet_author/all");
  assert.equal(routing.resolveClickTarget(click("mention")), "/mentioned_user/all");
  assert.equal(routing.resolveClickTarget(click("hashtag")), "/hashtag/Yomikui?src=hashtag_click");

  // UserCell in Retweet list: avatar, name, plain bio/row background -> /cell_owner/all; bio @mention -> /bio_friend/all; Follow button -> null!
  assert.equal(routing.resolveClickTarget(click("cell-avatar")), "/cell_owner/all");
  assert.equal(routing.resolveClickTarget(click("cell-name")), "/cell_owner/all");
  assert.equal(routing.resolveClickTarget(click("cell-bio-plain")), "/cell_owner/all");
  assert.equal(routing.resolveClickTarget(click("user-cell")), "/cell_owner/all");
  assert.equal(routing.resolveClickTarget(click("cell-bio-mention")), "/bio_friend/all");
  assert.equal(routing.resolveClickTarget(click("cell-follow-btn")), null);

  // Excluded UI controls (tabs, search bar, header nav, back button, t.co external link, show-more, like button, action bar padding)
  assert.equal(routing.resolveClickTarget(click("profile-tab")), null);
  assert.equal(routing.resolveClickTarget(click("search-form-link")), null);
  assert.equal(routing.resolveClickTarget(click("nav-home")), null);
  assert.equal(routing.resolveClickTarget(click("back-btn")), null);
  assert.equal(routing.resolveClickTarget(click("tco-link")), null);
  assert.equal(routing.resolveClickTarget(click("show-more")), null);
  assert.equal(routing.resolveClickTarget(click("like-btn")), null);
  assert.equal(routing.resolveClickTarget(click("action-bar")), null);
});

test("openInPlace detects SPA arrival for user profiles as well as tweets and retweet lists without reloading", async () => {
  const html = `
    <div data-testid="primaryColumn" id="primary">
      <div data-testid="UserName" id="old-username">@alice</div>
      <a role="tab" href="/alice/with_replies" id="old-tab">Replies</a>
    </div>
  `;
  const { routing, document, window, observers, clock } = setup(html);
  let hrefReloads = 0;
  let currentHref = "https://x.com/alice#yomikui-col4";
  window.location = {
    get href() { return currentHref; },
    set href(val) { currentHref = val; hrefReloads++; },
    pathname: "/alice",
    hash: "#yomikui-col4",
  };
  window.history.pushState = (_s, _t, url) => {
    currentHref = `https://x.com${url}`;
    window.location.pathname = url.split("?")[0].split("#")[0];
  };

  // Navigate from @alice to @bob -> must NOT false-match @alice's existing UserName or tab
  routing.openInPlace("/bob");
  const obs = observers.at(-1);
  assert.equal(obs.connected, true);
  obs.emit([{}]);
  await clock.advance(100);
  assert.equal(obs.connected, true);

  // X updates UserName to @bob -> arrival detected, observer disconnects, zero full reloads!
  document.getElementById("old-username").textContent = "Bob (@bob)";
  obs.emit([{}]);
  await clock.advance(100);
  assert.equal(obs.connected, false);
  await clock.advance(3000);
  assert.equal(hrefReloads, 0);
});

test("SettingsControls renders compact segmented buttons (self, next, custom) and inline target chips", () => {
  const { routing } = setup();
  const element = (type, props, key) => ({ type, props, key });
  const jsx = { jsx: element, jsxs: element, Fragment: "Fragment" };
  const dict = {
    column_settings_link_target: "リンクの表示先の列",
    column_settings_link_target_desc: "説明",
    column_settings_link_target_self: "この列で開く（標準）",
    column_settings_link_target_mode_self: "この列",
    column_settings_link_target_mode_next: "右隣",
    column_settings_link_target_mode_custom: "指定…",
    column_settings_link_target_select_col: "送り先:",
    column_settings_link_target_next_with_name: "右隣の列（$1$）",
    column_settings_link_target_next_unavailable: "右隣の列（現在対象なし）",
    column_settings_link_target_col_item: "$1$列目: $2$",
    column_settings_link_target_next_missing_note: "※対象なし",
  };
  const t = key => dict[key] || key;

  const cols = [
    { id: "c1", title: "通知", type: "notifications", linkTarget: "" },
    { id: "c2", title: "ホーム", type: "home", linkTarget: "c3" },
    { id: "c3", title: "検索", type: "search", linkTarget: "next" },
    { id: "c4", title: "プロフィール用", type: "customUrl", linkTarget: "" },
  ];

  const changes = [];
  // cols[1] は linkTarget: "c3" なので custom モード、ピル行が展開される
  const tree = routing.SettingsControls({
    column: cols[1], // 2列目
    columns: cols,
    onChange: patch => changes.push(patch),
    formatColumnName: col => col.title,
    jsx,
    t,
  });

  // custom モードなので [primaryRow, customRow] のコンテナ
  assert.equal(tree.type, "div");
  const [primaryRow, customRow] = tree.props.children;

  const segGroup = primaryRow.props.children[1];
  assert.equal(segGroup.props.role, "group");
  const buttons = segGroup.props.children;
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].props["aria-pressed"], false); // この列
  assert.equal(buttons[1].props["aria-pressed"], false); // 右隣
  assert.equal(buttons[2].props["aria-pressed"], true); // 指定…

  // 「右隣」ボタンをクリック
  buttons[1].props.onClick();
  assert.equal(changes[0].linkTarget, "next");

  // 「この列」ボタンをクリック
  buttons[0].props.onClick();
  assert.equal(changes[1].linkTarget, "");

  // customRow のピル一覧を検証
  const chips = customRow.props.children.slice(1); // 先頭の "送り先:" を除く
  assert.equal(chips.length, 3);
  assert.equal(chips[0].key, "c1");
  assert.equal(chips[0].props.children, "1列目: 通知");
  assert.equal(chips[0].props["aria-pressed"], false);

  assert.equal(chips[1].key, "c3");
  assert.equal(chips[1].props.children, "3列目: 検索");
  assert.equal(chips[1].props["aria-pressed"], true);

  assert.equal(chips[2].key, "c4");
  assert.equal(chips[2].props.children, "4列目: プロフィール用");
  assert.equal(chips[2].props["aria-pressed"], false);

  // ピル c1 をクリック
  chips[0].props.onClick();
  assert.equal(changes[2].linkTarget, "c1");

  // 通常モード（linkTarget: ""）では単一の行のみが返されることを検証
  const selfTree = routing.SettingsControls({
    column: cols[0],
    columns: cols,
    onChange: patch => changes.push(patch),
    formatColumnName: col => col.title,
    jsx,
    t,
  });
  // customRow がないので primaryRow 自体が返る
  assert.equal(selfTree.props.className, "flex min-h-9 items-center justify-between gap-4");
  const selfButtons = selfTree.props.children[1].props.children;
  assert.equal(selfButtons[0].props["aria-pressed"], true); // この列が active
});

test("installFrame routes clicks while enabled and validates message origin", () => {
  const { routing, activate, window } = setup(`
    <main role="main"><a id="tweet" href="/alice/status/123">Tweet</a></main>
  `);
  const messages = [];
  window.parent.postMessage = (message, origin) => messages.push({ ...message, origin });
  routing.installFrame({ getColumnId: () => "col2", getParentOrigin: () => "https://x.com" });
  assert.equal(activate("tweet").defaultPrevented, false);
  routing.setFrameEnabled(true);
  assert.equal(activate("tweet").defaultPrevented, true);
  routing.setFrameEnabled(false);
  assert.equal(activate("tweet").defaultPrevented, false);
  assert.deepEqual(messages, [{
    type: "yomikui-open-tweet", statusPath: "/alice/status/123", columnId: "col2", origin: "https://x.com",
  }]);

  let pushedUrl = null;
  window.history.pushState = (_s, _t, url) => { pushedUrl = url; };

  window.dispatchEvent({
    type: "message",
    source: window.parent,
    origin: "https://evil.example",
    data: { type: "yomikui-tweet-route-open", path: "/target_user" },
  });
  assert.equal(pushedUrl, null);

  window.dispatchEvent({
    type: "message",
    source: window.parent,
    origin: "https://x.com",
    data: { type: "yomikui-tweet-route-open", path: "/target_user" },
  });
  assert.equal(pushedUrl, "/target_user#yomikui-col1");
});

test("route respects columnComposing guard and scrolls horizontally only when target is offscreen", () => {
  const { routing, document, window } = setup(`
    <div id="scroller">
      <div data-column-id="c2"></div>
      <div data-column-id="c3"><iframe src="https://x.com/home#yomikui-c3"></iframe></div>
    </div>
  `);
  const scroller = document.getElementById("scroller");
  window.getComputedStyle = el => (el === scroller ? { overflowX: "auto" } : {});
  scroller.getBoundingClientRect = () => ({ left: 0, right: 1000 });

  const targetDiv = document.querySelector('[data-column-id="c3"]');
  let bounds = { left: 200, right: 600 };
  let scrollCalls = 0;
  targetDiv.getBoundingClientRect = () => bounds;
  targetDiv.scrollIntoView = () => { scrollCalls++; };

  const iframe = targetDiv.querySelector("iframe");
  iframe.contentWindow = {
    location: { href: iframe.src, origin: "https://x.com" },
    postMessage() {},
  };

  const cols = [
    { id: "c2", type: "home", linkTarget: "c3" },
    { id: "c3", type: "search", linkTarget: "" },
  ];

  // Composing draft in c3 skips routing
  assert.equal(routing.route({ columns: cols, columnComposing: { c3: true }, sourceId: "c2", statusPath: "/bob" }), false);

  // Fully visible -> no scroll
  assert.equal(routing.route({ columns: cols, columnComposing: { c3: false }, sourceId: "c2", statusPath: "/bob" }), true);
  assert.equal(scrollCalls, 0);

  // Offscreen -> scrolls into view
  bounds = { left: 850, right: 1250 };
  assert.equal(routing.route({ columns: cols, sourceId: "c2", statusPath: "/alice" }), true);
  assert.equal(scrollCalls, 1);
});

test("contentDeck store resets linkTarget when the referenced target column is removed", () => {
  const deckSource = readFileSync(new URL("../contentDeck.js", import.meta.url), "utf8");
  const { context, routing } = setup(`<div data-column-id="c3"></div>`);
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
  const c2 = { ...createColumn("home", "#1d9bf0"), id: "c2", linkTarget: "c3" };
  const c3 = { ...createColumn("search", "#00ba7c"), id: "c3", linkTarget: "next" };
  deckStore.setState({ activeWorkspaceId: "ws", columns: [c2, c3], workspaces: [] });

  routing.route({ columns: deckStore.getState().columns, sourceId: "c2", statusPath: "/author/status/123" });
  assert.equal(routing.peekPendingSrc("c3", "https://x.com/home"), "https://x.com/author/status/123");

  // Removing c3 resets c2.linkTarget to "" and clears c3's pending path
  deckStore.getState().removeColumn("c3");
  assert.equal(deckStore.getState().columns.find(c => c.id === "c2").linkTarget, "");
  assert.equal(routing.peekPendingSrc("c3", "https://x.com/home"), "https://x.com/home");
});

test("extension bundle and manifests integrate per-column link routing in General settings", () => {
  const deck = readFileSync(new URL("../contentDeck.js", import.meta.url), "utf8");
  const iframe = readFileSync(new URL("../contentIframe.js", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const jaLocale = JSON.parse(readFileSync(new URL("../_locales/ja/messages.json", import.meta.url), "utf8"));

  // Ensure old global target fields are completely gone
  assert.equal(deck.includes("tweetTarget"), false);
  assert.equal(deck.includes("openTweetsInTarget"), false);

  // Check new linkTarget integration in contentDeck.js
  assert.match(deck, /linkTarget:Re\.string\(\)\.catch\(""\)/);
  assert.match(deck, /resolvedTargetId:globalThis\.YomikuiTweetRouting\?\.resolveTargetColumn/);
  assert.match(deck, /routeTweets:Boolean\(TtId\)/);
  assert.match(deck, /globalThis\.YomikuiTweetRouting\.SettingsControls/);

  // Check contentIframe.js integration
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.setFrameEnabled/);
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.isFrameEnabled/);
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.normalizeRoutePath/);
  assert.match(iframe, /globalThis\.YomikuiTweetRouting\?\.installFrame/);

  // Check manifest ordering
  const deckScripts = manifest.content_scripts.find(cs => cs.matches.some(m => m.includes("/yomikui*"))).js;
  const iframeScripts = manifest.content_scripts.find(cs => cs.all_frames === true && cs.run_at === "document_start" && !cs.world).js;
  assert.ok(deckScripts.indexOf("tweetRouting.js") > deckScripts.indexOf("tweetActions.js"));
  assert.ok(iframeScripts.indexOf("tweetRouting.js") > iframeScripts.indexOf("tweetActions.js"));

  // Check translation keys
  const keys = [
    "column_settings_link_target",
    "column_settings_link_target_desc",
    "column_settings_link_target_self",
    "column_settings_link_target_next_with_name",
    "column_settings_link_target_next_unavailable",
    "column_settings_link_target_col_item",
    "column_settings_link_target_next_missing_note",
  ];
  for (const key of keys) {
    assert.ok(jaLocale[key], `_locales/ja/messages.json contains ${key}`);
    assert.ok(deck.includes(`"${key}":`), `contentDeck.js contains ${key}`);
  }
});

test("profile links use native /all navigation while preserving modifiers and explicit tab switches", () => {
  const { document, activate } = setup(`
    <div data-testid="primaryColumn">
      <a href="/Alice_123/?s=20#bio"><span id="name">Alice</span></a>
      <a href="https://twitter.com/bob?ref=src#bio" id="middle">Bob</a>
      <a href="/charlie" target="_blank" id="new-tab">Charlie</a>
      <a href="/home" id="home">Home</a>
      <a href="https://example.com/alice" id="external">External</a>
      <a href="/alice/status/123" id="status">Post</a>
      <div role="tablist">
        <a role="tab" href="/alice" id="tab-posts">Posts</a>
        <a role="tab" href="/alice/with_replies" id="tab-replies">Replies</a>
      </div>
    </div>
  `);
  const nameLink = document.getElementById("name").closest("a");
  for (const options of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const click = activate("name", options);
    assert.equal(click.cancelBubble, true);
    assert.equal(click.defaultPrevented, false);
    assert.equal(nameLink.getAttribute("href"), "https://x.com/Alice_123/all?s=20#bio");
  }
  const middle = activate("middle", {}, "auxclick");
  assert.equal(middle.cancelBubble, true);
  assert.equal(middle.defaultPrevented, false);
  assert.equal(document.getElementById("middle").getAttribute("href"), "https://twitter.com/bob/all?ref=src#bio");
  assert.equal(activate("new-tab").defaultPrevented, false);
  assert.equal(document.getElementById("new-tab").getAttribute("href"), "https://x.com/charlie/all");
  for (const id of ["home", "external", "status", "tab-posts", "tab-replies"]) {
    const link = document.getElementById(id);
    const href = link.getAttribute("href");
    assert.equal(activate(id).cancelBubble, false);
    assert.equal(link.getAttribute("href"), href);
  }
});

test("profile clicks and routed arrivals load /all with the destination column metadata", () => {
  const { routing, activate, window } = setup(`
    <main role="main">
      <div data-testid="UserCell" role="button">
        <a href="/eve?s=20" id="name">Eve</a>
        <span id="bio">Bio text</span>
        <button id="follow">Follow</button>
      </div>
    </main>
  `);
  const messages = [];
  window.parent.postMessage = (message, origin) => messages.push({ ...message, origin });
  window.location.href = "https://x.com/home?yomikui=1#yomikui-col1";
  window.history.pushState = () => assert.fail("Profile routing must load the X page directly");
  routing.installFrame({ getColumnId: () => "col1", getParentOrigin: () => "https://x.com" });

  const click = activate("name");
  assert.equal(click.cancelBubble, true);
  assert.equal(click.defaultPrevented, true);
  assert.equal(window.location.href, "https://x.com/eve/all?s=20&yomikui=1#yomikui-col1");
  assert.equal(activate("follow").defaultPrevented, false);
  assert.equal(activate("bio").defaultPrevented, true);
  assert.equal(messages.length, 0);

  routing.setFrameEnabled(true);
  assert.equal(activate("name").defaultPrevented, true);
  assert.deepEqual(messages, [{
    type: "yomikui-open-tweet", statusPath: "/eve/all?s=20", columnId: "col1", origin: "https://x.com",
  }]);
  window.dispatchEvent({
    type: "message", source: window.parent, origin: "https://x.com",
    data: { type: "yomikui-tweet-route-open", path: "/frank/all" },
  });
  assert.equal(window.location.href, "https://x.com/frank/all?yomikui=1#yomikui-col1");
});
