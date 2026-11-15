"use strict";

// Loaded before contentDeck.js and contentIframe.js.
// Manages per-column routing of X internal links (tweets, quote/retweet lists,
// user profiles, hashtags, lists, etc.) to a user-configured target column.
(() => {
  if (globalThis.YomikuiTweetRouting) return;

  const EXCLUDED_TYPES = new Set(["timeline", "chat", "grok", "post"]);
  const ALLOWED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const STATUS_PATH_RE = /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+(?:\/(?:quotes|retweets|likes))?$/i;
  const EXCLUDED_STATUS_SUBPATH_RE = /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+\/(?:photo|video|media_tags|analytics|history|hidden)(?:\/|$)/i;
  const EXCLUDED_PROFILE_MODAL_RE = /^\/[A-Za-z0-9_]+\/(?:photo|header_photo)(?:\/|$)/i;
  const EXCLUDED_ROOT_ROUTE_RE = /^\/(?:compose|intent|login|logout|signup|settings|messages|account|privacy|tos|yomikui)(?:\/|$)/i;
  const EXCLUDED_INTERNAL_ROUTE_RE = /^\/i\/(?:flow|chat|grok|keyboard_shortcuts|display|verified-choose|premium_sign_up|spaces|broadcasts)(?:\/|$)/i;
  const PROFILE_PATH_RE = /^\/[A-Za-z0-9_]+$/;
  const STATUS_LIST_SUFFIX_RE = /\/status\/\d+\/(quotes|retweets|likes)$/i;
  const REVIEW_LIST_RE = /\/status\/\d+\/(quotes|retweets)$/i;
  const PROFILE_SECTION_PATH_RE = /^\/([A-Za-z0-9_]+)(?:\/(?:all|with_replies|highlights|media|articles))?$/i;
  const PROFILE_ALL_PATH_RE = /^\/([A-Za-z0-9_]+)\/all\/?$/i;
  const PRIMARY_COLUMN = '[data-testid="primaryColumn"]';
  const TWEET = 'article[data-testid="tweet"]';
  const USER_CELL = '[data-testid="UserCell"]';
  const USER_NAME = '[data-testid="User-Name"]';
  const TWEET_AVATAR = '[data-testid="Tweet-User-Avatar"]';
  const USER_DESCRIPTION = '[data-testid="UserDescription"]';
  const QUOTED_TWEET = '[data-testid="quoteTweet"], [data-testid="tweetQuote"]';
  const LAST_PROFILE_VIEWED = "data-yomikui-last-profile-viewed";

  const RESERVED_ROOT_PATHS = new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "search",
    "hashtag",
    "settings",
    "compose",
    "intent",
    "login",
    "logout",
    "signup",
    "account",
    "privacy",
    "tos",
    "yomikui",
    "i",
    "about",
    "jobs",
    "help",
    "x",
  ]);

  function withoutTrailingSlashes(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  }

  function isProfilePath(pathname) {
    if (!pathname || typeof pathname !== "string") return false;
    const clean = withoutTrailingSlashes(pathname);
    if (!PROFILE_PATH_RE.test(clean)) return false;
    const segment = clean.slice(1).toLowerCase();
    return !RESERVED_ROOT_PATHS.has(segment) && !EXCLUDED_ROOT_ROUTE_RE.test(clean);
  }

  function getProfileAllPath(value) {
    const parsed = parseInternalUrl(value);
    if (!parsed) return null;
    const pathname = withoutTrailingSlashes(parsed.pathname);
    if (isProfilePath(pathname)) return `${pathname}/all${parsed.search}`;
    if (pathname.endsWith("/all") && isProfilePath(pathname.slice(0, -4))) {
      return pathname + parsed.search;
    }
    return null;
  }

  function profileAllHandle(value) {
    const match = parseInternalUrl(value)?.pathname.match(PROFILE_ALL_PATH_RE);
    return match && isProfilePath(`/${match[1]}`) ? match[1].toLowerCase() : null;
  }

  const IGNORED_CONTAINERS_SELECTOR = [
    '[role="dialog"]',
    '[role="menu"]',
    '[role="tablist"]',
    'header[role="banner"]',
    'form',
    '[role="search"]',
    '[data-testid="BottomBar"]',
    '[data-testid="Dropdown"]',
    '[data-testid="sheetDialog"]',
    '[data-testid="typeaheadDropdown"]',
    '[data-testid="AccountSwitcher_LoggedInAccounts"]',
    '[data-testid="app-bar-back"]',
  ].join(", ");

  const CONTENT_SCOPE_SELECTOR = '[data-testid="primaryColumn"], main[role="main"], article[data-testid="tweet"], [data-testid="UserCell"]';

  const IGNORED_TAGS = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO", "SUMMARY", "LABEL"]);
  const IGNORED_ROLES = new Set([
    "button",
    "menuitem",
    "menuitemradio",
    "tab",
    "tablist",
    "checkbox",
    "radio",
    "switch",
    "menu",
    "dialog",
    "group",
    "combobox",
    "listbox",
    "option",
    "searchbox",
  ]);
  const IGNORED_TESTIDS = new Set([
    "tweetPhoto",
    "videoPlayer",
    "videoComponent",
    "card.wrapper",
    "tweet-text-show-more-link",
    "caret",
    "reply",
    "retweet",
    "unretweet",
    "like",
    "unlike",
    "bookmark",
    "removeBookmark",
    "app-bar-back",
  ]);

  const PENDING_TTL_MS = 15000;
  const FOCUS_DURATION_MS = 1500;
  const ARRIVAL_CHECK_DEBOUNCE_MS = 60;
  const FALLBACK_RELOAD_MS = 2500;
  const INITIAL_LIST_SCROLL_MS = FALLBACK_RELOAD_MS + 500;
  const SCROLL_INPUT_EVENTS = ["wheel", "touchmove", "pointerdown", "keydown"];
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  function isAllowedOrigin(origin) {
    if (typeof origin !== "string" || !origin.startsWith("https://")) return false;
    try {
      const host = new URL(origin).hostname.toLowerCase();
      return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
    } catch {
      return false;
    }
  }

  function parseInternalUrl(value) {
    if (typeof value !== "string" || !value) return null;
    if (value.charCodeAt(0) === 47) {
      if (value.charCodeAt(1) === 47) return null;
      const hashIdx = value.indexOf("#");
      const noHash = hashIdx === -1 ? value : value.slice(0, hashIdx);
      const qIdx = noHash.indexOf("?");
      return qIdx === -1
        ? { pathname: noHash, search: "" }
        : { pathname: noHash.slice(0, qIdx), search: noHash.slice(qIdx) };
    }
    try {
      const url = new URL(value, "https://x.com");
      if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
      return { pathname: url.pathname, search: url.search };
    } catch {
      return null;
    }
  }

  function normalizeStatusPath(value) {
    const parsed = parseInternalUrl(value);
    if (!parsed) return null;
    const pathname = withoutTrailingSlashes(parsed.pathname);
    return STATUS_PATH_RE.test(pathname) ? pathname : null;
  }

  function normalizeRoutePath(value) {
    const parsed = parseInternalUrl(value);
    if (!parsed) return null;
    const pathname = withoutTrailingSlashes(parsed.pathname);
    if (!pathname || pathname === "/" || !pathname.startsWith("/")) return null;

    if (
      EXCLUDED_STATUS_SUBPATH_RE.test(pathname) ||
      EXCLUDED_PROFILE_MODAL_RE.test(pathname) ||
      EXCLUDED_ROOT_ROUTE_RE.test(pathname) ||
      EXCLUDED_INTERNAL_ROUTE_RE.test(pathname)
    ) {
      return null;
    }

    if (STATUS_PATH_RE.test(pathname)) {
      return pathname;
    }

    if (!parsed.search || parsed.search === "?") {
      return pathname;
    }
    if (parsed.search.includes("q=yomikui-timeline")) {
      return null;
    }
    const params = new URLSearchParams(parsed.search);
    params.delete("yomikui");
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function isTargetEligible(column) {
    return isSourceEligible(column) && column.liveFeed !== true;
  }

  function isSourceEligible(column) {
    if (!column || typeof column !== "object") return false;
    return !EXCLUDED_TYPES.has(column.type);
  }

  function resolveNextColumn(sourceId, columns) {
    if (!sourceId || !Array.isArray(columns)) return null;
    const idx = columns.findIndex(c => c && c.id === sourceId);
    if (idx < 0 || idx + 1 >= columns.length) return null;
    const candidate = columns[idx + 1];
    return isTargetEligible(candidate) ? { column: candidate, index: idx + 1 } : null;
  }

  function resolveTargetColumn(source, columns) {
    if (!source || !isSourceEligible(source) || !Array.isArray(columns)) return null;
    const spec = typeof source.linkTarget === "string" ? source.linkTarget : "";
    if (!spec) return null;
    if (spec === "next") {
      return resolveNextColumn(source.id, columns)?.column ?? null;
    }
    if (spec === source.id) return null;
    const target = columns.find(c => c && c.id === spec) ?? null;
    return target && isTargetEligible(target) ? target : null;
  }

  function shouldRoute(source, columns) {
    return resolveTargetColumn(source, columns);
  }

  function sanitizeColumns(columns) {
    if (!Array.isArray(columns)) return columns;
    const validIds = new Set(columns.filter(Boolean).map(c => c.id));
    let changed = false;
    const next = columns.map(c => {
      if (!c) return c;
      const spec = typeof c.linkTarget === "string" ? c.linkTarget : "";
      if (!spec) return c.linkTarget === "" ? c : ((changed = true), { ...c, linkTarget: "" });
      if (!isSourceEligible(c)) {
        changed = true;
        return { ...c, linkTarget: "" };
      }
      if (spec === "next") return c;
      if (spec === c.id || !validIds.has(spec)) {
        changed = true;
        return { ...c, linkTarget: "" };
      }
      return c;
    });
    return changed ? next : columns;
  }

  function isFullyVisible(columnRect, viewportRect) {
    if (!columnRect || !viewportRect) return false;
    return columnRect.left >= viewportRect.left - 1 && columnRect.right <= viewportRect.right + 1;
  }

  function withPendingPath(src, routePath) {
    const clean = normalizeRoutePath(routePath);
    if (typeof src !== "string" || !src || !clean) return src;
    try {
      const base = new URL(src, "https://x.com");
      const target = new URL(clean, "https://x.com");
      const yomikuiParam = base.searchParams.get("yomikui");
      base.pathname = target.pathname;
      base.search = target.search;
      if (yomikuiParam !== null) {
        base.searchParams.set("yomikui", yomikuiParam);
      }
      return base.toString();
    } catch {
      return src;
    }
  }

  // --- Parent frame state & routing ---
  const pendingPaths = new Map();
  const pendingProfileReviews = new Map();
  const focusTimers = new WeakMap();
  let nextReviewId = 0;

  function readPendingPath(columnId, consume) {
    if (!columnId || !pendingPaths.has(columnId)) return null;
    const entry = pendingPaths.get(columnId);
    if (consume) pendingPaths.delete(columnId);
    if (!entry || Date.now() - entry.at > PENDING_TTL_MS) {
      pendingPaths.delete(columnId);
      return null;
    }
    return entry.path;
  }

  function peekPendingSrc(columnId, src) {
    const path = readPendingPath(columnId, false);
    return path ? withPendingPath(src, path) : src;
  }

  function takePendingSrc(columnId, src) {
    const path = readPendingPath(columnId, true);
    return path ? withPendingPath(src, path) : src;
  }

  function clearPending(columnId) {
    if (!columnId) return;
    pendingPaths.delete(columnId);
    for (const [targetId, review] of pendingProfileReviews) {
      if (targetId === columnId || review.sourceId === columnId) clearProfileReview(targetId);
    }
  }

  function findColumn(columnId) {
    const escapedId = globalThis.CSS?.escape
      ? globalThis.CSS.escape(columnId)
      : String(columnId).replace(/["\\]/g, "\\$&");
    return document.querySelector(`[data-column-id="${escapedId}"]`);
  }

  function clearProfileReview(targetId) {
    const pending = pendingProfileReviews.get(targetId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingProfileReviews.delete(targetId);
    if (!pendingProfileReviews.size) window.removeEventListener("message", onProfileReviewMessage);
  }

  function startProfileReview({ targetId, sourceId, sourceOrigin, reviewView, path }) {
    clearProfileReview(targetId);
    if (typeof reviewView !== "string" || !reviewView || !isAllowedOrigin(sourceOrigin)) return null;
    const handle = profileAllHandle(path);
    if (!handle) return null;

    const request = { id: ++nextReviewId, handle, deadline: Date.now() + PENDING_TTL_MS };
    const timeout = setTimeout(() => clearProfileReview(targetId), PENDING_TTL_MS);
    if (!pendingProfileReviews.size) window.addEventListener("message", onProfileReviewMessage);
    pendingProfileReviews.set(targetId, { request, timeout, sourceId, sourceOrigin, reviewView });
    return request;
  }

  function onProfileReviewMessage(event) {
    const message = event.data;
    const ready = message?.type === "yomikui-frame-ready";
    if (!(ready || message?.type === "yomikui-profile-review-displayed") || !isAllowedOrigin(event.origin)) return;
    for (const [targetId, pending] of pendingProfileReviews) {
      if (message.columnId && message.columnId !== targetId) continue;
      if (!ready && message.id !== pending.request.id) continue;
      const frame = findColumn(targetId)?.querySelector("iframe")?.contentWindow;
      if (!frame || event.source !== frame) continue;
      if (Date.now() >= pending.request.deadline) {
        clearProfileReview(targetId);
        return;
      }
      if (ready) {
        // Profile navigation replaces the iframe document. Its existing ready
        // message lets the new document pick up the in-memory request.
        frame.postMessage({ type: "yomikui-profile-review-watch", request: pending.request }, event.origin);
      } else {
        clearProfileReview(targetId);
        findColumn(pending.sourceId)?.querySelector("iframe")?.contentWindow?.postMessage({
          type: "yomikui-profile-review-mark",
          view: pending.reviewView,
          handle: pending.request.handle,
        }, pending.sourceOrigin);
      }
      return;
    }
  }

  function resolveIframeOrigin(iframe) {
    try {
      const liveOrigin = iframe.contentWindow?.location?.origin;
      if (isAllowedOrigin(liveOrigin)) return liveOrigin;
    } catch {
      const parentHost = window.location?.hostname?.toLowerCase?.() ?? "";
      if (parentHost.endsWith("twitter.com")) return "https://x.com";
      if (parentHost.endsWith("x.com")) return "https://twitter.com";
    }
    if (iframe.src) {
      try {
        const srcOrigin = new URL(iframe.src, window.location?.href || "https://x.com").origin;
        if (isAllowedOrigin(srcOrigin)) return srcOrigin;
      } catch {}
    }
    return "*";
  }

  function route({ columns, sourceId, statusPath, routePath, isComposing = false, columnComposing = null, reviewView, sourceOrigin }) {
    const path = normalizeRoutePath(routePath ?? statusPath);
    if (!path || !Array.isArray(columns)) return false;
    const source = columns.find(c => c && c.id === sourceId);
    if (!source) return false;
    const target = resolveTargetColumn(source, columns);
    if (!target) return false;
    if (isComposing || columnComposing?.[target.id]) return false;

    const el = findColumn(target.id);
    if (!el) return false;
    const iframe = el.querySelector("iframe");

    const isLiveFeed = target.liveFeed === true || (iframe?.src && iframe.src.includes("liveFeedShell.html"));
    let isAboutBlank = false;
    if (iframe?.contentWindow) {
      try {
        isAboutBlank = iframe.contentWindow.location?.href === "about:blank";
      } catch {}
    }
    const review = startProfileReview({
      targetId: target.id, sourceId, sourceOrigin, reviewView: isLiveFeed ? null : reviewView, path,
    });
    if (iframe?.contentWindow && !isLiveFeed && !isAboutBlank) {
      const origin = resolveIframeOrigin(iframe);
      const message = { type: "yomikui-tweet-route-open", path };
      if (review) message.review = review;
      try {
        iframe.contentWindow.postMessage(message, origin);
      } catch {
        iframe.contentWindow.postMessage(message, "*");
      }
      pendingPaths.delete(target.id);
    } else if (isAboutBlank && !isLiveFeed && iframe?.src) {
      iframe.src = withPendingPath(iframe.src, path);
      pendingPaths.delete(target.id);
    } else {
      pendingPaths.set(target.id, { path, at: Date.now() });
    }

    let container = el.parentElement;
    while (container && container !== document.body) {
      const style = window.getComputedStyle ? window.getComputedStyle(container) : null;
      if (style && (style.overflowX === "auto" || style.overflowX === "scroll")) break;
      container = container.parentElement;
    }
    const viewport = container && container.getBoundingClientRect
      ? container.getBoundingClientRect()
      : { left: 0, right: window.innerWidth ?? 0 };

    const colRect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!isFullyVisible(colRect, viewport)) {
      el.scrollIntoView?.({ behavior: "smooth", inline: "nearest", block: "nearest" });
    }

    const prevTimer = focusTimers.get(el);
    if (prevTimer !== undefined) clearTimeout(prevTimer);
    el.classList.add("rd-column-focused");
    focusTimers.set(el, setTimeout(() => {
      focusTimers.delete(el);
      el.classList.remove("rd-column-focused");
    }, FOCUS_DURATION_MS));
    return true;
  }

  // --- iframe frame-level handling ---
  let frameEnabled = false;
  let frameInstalled = false;
  let getColumnIdFn = null;
  let getParentOriginFn = null;
  let reviewList = null;
  let reviewColumnVisible = true;
  let profileWatch = null;

  function reviewListKey() {
    return normalizeStatusPath(window.location.pathname)?.match(REVIEW_LIST_RE)?.[0].toLowerCase();
  }

  function findProfileHandle(scope) {
    for (const link of scope?.querySelectorAll("a[href]") ?? []) {
      if (link.closest(`${USER_DESCRIPTION}, ${QUOTED_TWEET}`)) continue;
      const handle = profileAllHandle(getProfileAllPath(link.getAttribute("href")));
      if (handle) return handle;
    }
    return null;
  }

  function reviewRowHandle(row, selector) {
    return findProfileHandle(row.querySelector(USER_NAME)) ??
      findProfileHandle(selector === TWEET ? row.querySelector(TWEET_AVATAR) : row);
  }

  function reviewViewForClick(target, path) {
    const key = reviewListKey();
    const handle = key && profileAllHandle(path);
    if (!handle) return null;
    const selector = key.endsWith("/quotes") ? TWEET : USER_CELL;
    const row = target.closest(selector);
    if (!row?.closest(PRIMARY_COLUMN) || row.parentElement?.closest(selector)) return null;
    if (selector === TWEET && !row.querySelector(USER_NAME)?.contains(target) &&
        !row.querySelector(TWEET_AVATAR)?.contains(target)) return null;
    if (reviewRowHandle(row, selector) !== handle) return null;

    if (reviewList?.key !== key) {
      clearReviewList();
      reviewList = { key, selector, id: crypto.randomUUID(), last: null };
    }
    return reviewList.id;
  }

  function paintReviewRow(view, row) {
    if (row.parentElement?.closest(view.selector)) return;
    row.toggleAttribute(LAST_PROFILE_VIEWED, reviewRowHandle(row, view.selector) === view.last);
  }

  function paintChangedReviewRows(view, records) {
    if (reviewList !== view) return;
    if (reviewListKey() !== view.key) { clearReviewList(); return; }
    const primary = document.querySelector(PRIMARY_COLUMN);
    if (!primary) return;
    const rows = new Set();
    for (const { target, addedNodes } of records) {
      const row = target.closest?.(view.selector);
      if (row && primary.contains(row)) {
        rows.add(row);
        continue;
      }
      for (const node of addedNodes ?? []) {
        if (node.nodeType !== 1) continue;
        if (node.contains(primary)) {
          for (const row of primary.querySelectorAll(view.selector)) rows.add(row);
        } else if (primary.contains(node)) {
          if (node.matches(view.selector)) rows.add(node);
          for (const row of node.querySelectorAll(view.selector)) rows.add(row);
        }
      }
    }
    for (const row of rows) paintReviewRow(view, row);
  }

  function syncReviewMarks() {
    const view = reviewList;
    if (!view?.last) return;
    if (document.hidden || !reviewColumnVisible) {
      view.observer?.disconnect();
      view.observer = null;
      return;
    }
    if (!view.style?.isConnected) {
      const style = document.createElement("style");
      style.textContent = `
        [${LAST_PROFILE_VIEWED}] {
          /* Layer the tint over the column theme's background color. */
          background-image: linear-gradient(rgb(29 155 240 / 14%), rgb(29 155 240 / 14%));
          box-shadow: inset 3px 0 #1d9bf0;
        }
        @media (forced-colors: active) {
          [${LAST_PROFILE_VIEWED}] { outline: 2px solid Highlight; outline-offset: -2px; }
        }
      `;
      (document.head ?? document.documentElement).appendChild(style);
      view.style = style;
    }
    const primary = document.querySelector(PRIMARY_COLUMN);
    for (const row of primary?.querySelectorAll(view.selector) ?? []) paintReviewRow(view, row);
    if (!view.observer) {
      view.observer = new MutationObserver(records => paintChangedReviewRows(view, records));
      view.observer.observe(primary?.closest("main") ?? document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["href"],
      });
    }
  }

  function clearReviewList() {
    const view = reviewList;
    if (!view) return;
    reviewList = null;
    view.observer?.disconnect();
    view.style?.remove();
    if (!view.last) return;
    for (const row of document.querySelectorAll(`[${LAST_PROFILE_VIEWED}]`)) row.removeAttribute(LAST_PROFILE_VIEWED);
  }

  function markReviewedProfile(message) {
    if (!reviewList || reviewList.id !== message.view || typeof message.handle !== "string") return;
    if (reviewListKey() !== reviewList.key) { clearReviewList(); return; }
    reviewList.last = message.handle;
    syncReviewMarks();
  }

  function stopProfileWatch() {
    if (!profileWatch) return;
    profileWatch.observer?.disconnect();
    clearTimeout(profileWatch.scan);
    clearTimeout(profileWatch.timeout);
    profileWatch = null;
  }

  function watchProfileDisplay(request, origin) {
    const handle = profileAllHandle(window.location.pathname);
    const remaining = request?.deadline - Date.now();
    if (!handle || request?.handle !== handle || !Number.isSafeInteger(request.id) ||
        !(remaining > 0 && remaining <= PENDING_TTL_MS) || profileWatch?.id === request.id) return;
    stopProfileWatch();
    const watch = { id: request.id, handle, scan: null };
    profileWatch = watch;
    const check = () => {
      watch.scan = null;
      if (Date.now() >= request.deadline || profileAllHandle(window.location.pathname) !== handle) {
        stopProfileWatch();
        return;
      }
      const primary = document.querySelector(PRIMARY_COLUMN);
      if (!primary) return;
      const tab = primary.querySelector('[role="tab"][aria-selected="true"][href]');
      if (profileAllHandle(tab?.getAttribute("href")) !== handle ||
          primary.querySelector('[data-testid="error-detail"]') ||
          !primary.querySelector(`${TWEET}, [data-testid="emptyState"]`)) return;
      stopProfileWatch();
      window.parent.postMessage({ type: "yomikui-profile-review-displayed", id: watch.id }, origin);
    };
    check();
    if (profileWatch !== watch) return;
    watch.observer = new MutationObserver(() => {
      if (watch.scan === null) watch.scan = setTimeout(check, ARRIVAL_CHECK_DEBOUNCE_MS);
    });
    watch.observer.observe(document.body ?? document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected", "href"],
    });
    watch.timeout = setTimeout(stopProfileWatch, remaining);
  }

  function onReviewLocationChange() {
    if (reviewList && reviewListKey() !== reviewList.key) clearReviewList();
    if (profileWatch && profileAllHandle(window.location.pathname) !== profileWatch.handle) stopProfileWatch();
  }

  function extractQuoteStatusPath(quoteCard) {
    if (!quoteCard || typeof quoteCard.querySelectorAll !== "function") return null;
    const links = quoteCard.querySelectorAll('a[href*="/status/"]');
    let fallback = null;
    for (const link of links) {
      const href = link.getAttribute("href");
      const direct = normalizeStatusPath(href);
      if (direct) return direct;
      if (!fallback) fallback = globalThis.YomikuiTweetActions?.getStatusPath?.(href) ?? null;
    }
    return fallback;
  }

  function extractUserCellPath(cell) {
    if (!cell || typeof cell.querySelectorAll !== "function") return null;
    const links = cell.querySelectorAll("a[href]");
    let fallback = null;
    for (const link of links) {
      const allPath = getProfileAllPath(normalizeRoutePath(link.getAttribute("href")));
      if (!allPath) continue;
      if (!link.closest?.(USER_DESCRIPTION)) return allPath;
      if (!fallback) fallback = allPath;
    }
    return fallback;
  }

  function isIgnoredElement(node) {
    const tag = node.tagName?.toUpperCase?.();
    if (tag && IGNORED_TAGS.has(tag)) return true;
    const role = node.getAttribute?.("role");
    if (role && IGNORED_ROLES.has(role)) return true;
    if (node.getAttribute?.("contenteditable") === "true") return true;
    const testId = node.getAttribute?.("data-testid");
    if (testId && IGNORED_TESTIDS.has(testId)) return true;
    const cls = node.classList;
    if (cls) {
      if (
        cls.contains("yomikui-cbv-overlay") ||
        cls.contains("yomikui-add-label-btn") ||
        cls.contains("yomikui-edit-nickname-btn") ||
        cls.contains("yomikui-ocb-btn") ||
        cls.contains("yomikui-screenshot-btn")
      ) {
        return true;
      }
    }
    return false;
  }

  function resolveClickTarget(event) {
    if (!event) return null;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.defaultPrevented) {
      return null;
    }
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (!target || typeof target.closest !== "function") return null;

    if (target.closest(IGNORED_CONTAINERS_SELECTOR)) return null;

    const scope = target.closest(CONTENT_SCOPE_SELECTOR);
    if (!scope || target.closest(".rd-lf-tweet")) return null;

    const selection = window.getSelection?.();
    if (selection && selection.isCollapsed !== true && selection.toString().trim() !== "") {
      return null;
    }

    // Single upward pass from target up through scope (inclusive)
    for (let node = target; node; node = node === scope ? null : node.parentElement) {
      const testId = node.getAttribute?.("data-testid");

      // UserCell itself often carries role="button" or <button>; check before generic button ignore.
      // Inner Follow/Unfollow buttons inside UserCell are visited earlier and caught by isIgnoredElement.
      if (testId === "UserCell") {
        return extractUserCellPath(node);
      }

      if (isIgnoredElement(node)) {
        return null;
      }

      if (node.tagName?.toUpperCase?.() === "A" && node.hasAttribute?.("href")) {
        if (node.hasAttribute?.("download")) return null;
        const path = normalizeRoutePath(node.getAttribute("href"));
        return getProfileAllPath(path) ?? path;
      }

      if (
        testId === "quoteTweet" ||
        testId === "tweetQuote" ||
        (node.getAttribute?.("role") === "link" && node.closest?.('article[data-testid="tweet"]'))
      ) {
        return extractQuoteStatusPath(node);
      }

      if (testId === "tweet" && node.tagName?.toUpperCase?.() === "ARTICLE") {
        return globalThis.YomikuiTweetActions?.resolveTweetStatusPath?.(node) ?? null;
      }
    }

    return null;
  }

  function onLinkInteraction(event) {
    const click = event.type === "click";
    if (event.defaultPrevented || (click && event.button !== 0) || (event.type === "auxclick" && event.button !== 1)) return;
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const anchor = target?.closest?.("a[href]");
    const linkTarget = anchor?.getAttribute("target")?.toLowerCase();
    const sameTab = click && !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) &&
      (!linkTarget || linkTarget === "_self");
    const route = sameTab && frameInstalled && frameEnabled ? resolveClickTarget(event) : null;
    if (route) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const columnId = typeof getColumnIdFn === "function" ? getColumnIdFn() : null;
      const origin = (typeof getParentOriginFn === "function" ? getParentOriginFn() : null) || "*";
      const message = { type: "yomikui-open-tweet", statusPath: route, columnId };
      const view = reviewViewForClick(target, route);
      if (view) message.reviewView = view;
      try {
        window.parent.postMessage(message, origin);
      } catch {
        window.parent.postMessage(message, "*");
      }
      return;
    }

    if (anchor) {
      if (sameTab && frameInstalled && anchor.closest("[data-yomikui-tweet-action]")) {
        const path = normalizeStatusPath(anchor.getAttribute("href"));
        if (path && STATUS_LIST_SUFFIX_RE.test(path)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          openInPlace(path);
          return;
        }
      }
      const url = getProfileAllUrl(anchor);
      if (!url) return;
      // X's click handler can navigate using the original React link props.
      if (event.type !== "contextmenu") event.stopImmediatePropagation();
      if (sameTab && frameInstalled) {
        event.preventDefault();
        openInPlace(url.pathname + url.search);
      } else {
        anchor.setAttribute("href", url.href);
      }
      return;
    }

    if (!sameTab || !target?.closest?.('[data-testid="UserCell"]')) return;
    const path = getProfileAllPath(resolveClickTarget(event));
    if (!path) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openInPlace(path);
  }

  function setFrameEnabled(enabled) {
    frameEnabled = enabled === true;
  }

  function isFrameEnabled() {
    return frameEnabled;
  }

  let pendingNavigationTimer = null;
  let pendingCheckTimer = null;
  let pendingNavigationObserver = null;
  let pendingScrollFrame = null;
  let stopListScroll = null;
  const pendingScrollTimers = new Set();

  function cancelPendingScrollTimers() {
    if (pendingScrollFrame !== null) {
      cancelAnimationFrame(pendingScrollFrame);
      pendingScrollFrame = null;
    }
    for (const timer of pendingScrollTimers) {
      clearTimeout(timer);
    }
    pendingScrollTimers.clear();
  }

  function resetScrollerToTop(scroller) {
    try {
      scroller.scrollTo?.({ top: 0, left: 0, behavior: "instant" });
    } catch {
      try { scroller.scrollTo?.(0, 0); } catch {}
    }
    if (scroller !== window && scroller.scrollTop !== 0) scroller.scrollTop = 0;
  }

  function resetScrollToTop({ includeListScroller = false } = {}) {
    const primary = document.querySelector?.('[data-testid="primaryColumn"]');
    const candidates = new Set([
      window,
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.getElementById("yomikui-timeline-root"),
      primary,
      document.querySelector?.('main[role="main"]'),
    ]);
    if (includeListScroller) {
      const firstItem = primary?.querySelector('article[data-testid="tweet"], [data-testid="UserCell"]');
      for (let parent = firstItem?.parentElement ?? primary; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent.scrollTop > 0) candidates.add(parent);
      }
    }
    for (const scroller of candidates) if (scroller) resetScrollerToTop(scroller);
  }

  function isCurrentList(suffix) {
    return normalizeStatusPath(window.location.pathname)?.toLowerCase().endsWith(suffix) === true;
  }

  function keepInitialListScrollAtTop(suffix) {
    const options = { capture: true, passive: true };
    const leftList = () => {
      if (isCurrentList(suffix)) return false;
      cleanupPendingNavigation();
      return true;
    };
    const onScroll = ({ target }) => {
      if (leftList()) return;
      const pageScroll = target === document || target === window;
      const scroller = pageScroll ? document.scrollingElement ?? window : target;
      const top = scroller === window ? window.scrollY : scroller?.scrollTop;
      if (!(top > 0)) return;
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      if (pageScroll || scroller === document.scrollingElement ||
          (primary && (primary.contains(scroller) || scroller.contains(primary)))) {
        resetScrollerToTop(scroller);
      }
    };
    const onInput = event => {
      if (event.type !== "keydown" || SCROLL_KEYS.has(event.key)) stop();
    };
    const stop = () => {
      clearTimeout(timer);
      for (const type of SCROLL_INPUT_EVENTS) window.removeEventListener(type, onInput, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("popstate", leftList);
      stopListScroll = null;
    };

    // X can restore an old offset after the list renders. Correct it during
    // navigation until the user starts interacting with the destination.
    stopListScroll = stop;
    const timer = setTimeout(stop, INITIAL_LIST_SCROLL_MS);
    for (const type of SCROLL_INPUT_EVENTS) window.addEventListener(type, onInput, options);
    window.addEventListener("scroll", onScroll, options);
    window.addEventListener("popstate", leftList);
    resetScrollToTop({ includeListScroller: true });
  }

  function scheduleScrollToTop() {
    resetScrollToTop();
    if (typeof requestAnimationFrame === "function") {
      pendingScrollFrame = requestAnimationFrame(() => {
        pendingScrollFrame = null;
        resetScrollToTop();
      });
    }
    const schedule = (delay) => {
      const timer = setTimeout(() => {
        pendingScrollTimers.delete(timer);
        resetScrollToTop();
      }, delay);
      pendingScrollTimers.add(timer);
    };
    schedule(50);
    schedule(150);
  }

  function cleanupPendingArrival() {
    if (pendingNavigationTimer !== null) {
      clearTimeout(pendingNavigationTimer);
      pendingNavigationTimer = null;
    }
    if (pendingCheckTimer !== null) {
      clearTimeout(pendingCheckTimer);
      pendingCheckTimer = null;
    }
    if (pendingNavigationObserver !== null) {
      pendingNavigationObserver.disconnect();
      pendingNavigationObserver = null;
    }
  }

  function cleanupPendingNavigation() {
    cleanupPendingArrival();
    cancelPendingScrollTimers();
    stopListScroll?.();
  }

  function openInPlace(path) {
    const cleanPath = normalizeRoutePath(path);
    if (!cleanPath) return;

    const listMatch = normalizeStatusPath(cleanPath)?.match(STATUS_LIST_SUFFIX_RE);
    const listSuffix = listMatch?.[0].toLowerCase();
    const listKind = listMatch?.[1].toLowerCase();
    const currentRoute = normalizeRoutePath(window.location?.href);
    if (currentRoute === cleanPath) {
      if (listKind) resetScrollToTop({ includeListScroller: true });
      return;
    }

    cleanupPendingNavigation();

    if (getProfileAllPath(cleanPath) === cleanPath) {
      // Load X's All timeline directly, even when its profile tabs link to Posts.
      window.location.href = withPendingPath(window.location.href, cleanPath);
      return;
    }

    const ARRIVAL_NODES_SELECTOR = [
      'article[data-testid="tweet"]',
      '[data-testid="UserCell"]',
      '[data-testid="UserName"]',
      '[data-testid="emptyState"]',
      '[data-testid="error-detail"]',
    ].join(", ");

    const initialScope = document.querySelector?.('[data-testid="primaryColumn"]') || document;
    const priorNodes = new WeakSet(
      typeof initialScope.querySelectorAll === "function"
        ? initialScope.querySelectorAll(ARRIVAL_NODES_SELECTOR)
        : []
    );

    const url = cleanPath + (window.location?.hash || "");
    try {
      window.history.pushState(null, "", url);
    } catch {
      window.location.href = withPendingPath(window.location.href, cleanPath);
      return;
    }
    try { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); } catch {}

    if (listKind) keepInitialListScrollAtTop(listSuffix);
    else scheduleScrollToTop();

    const idMatch = cleanPath.match(/\/status\/(\d+)/);
    const tweetId = idMatch ? idMatch[1] : null;
    const profileMatch =
      !tweetId &&
      cleanPath.match(PROFILE_SECTION_PATH_RE);
    const isProfile = Boolean(
      profileMatch &&
        !RESERVED_ROOT_PATHS.has(profileMatch[1].toLowerCase()) &&
        !EXCLUDED_ROOT_ROUTE_RE.test(`/${profileMatch[1]}`)
    );
    const handleLower = isProfile ? profileMatch[1].toLowerCase() : null;

    const checkArrival = () => {
      const root = document.querySelector?.('[data-testid="primaryColumn"]') || document;
      if (listKind && tweetId) {
        if (root.querySelector(`a[role="tab"][href*="/status/${tweetId}/${listKind}"]`)) {
          return true;
        }
        for (const node of root.querySelectorAll(ARRIVAL_NODES_SELECTOR)) {
          if (!priorNodes.has(node)) return true;
        }
        return false;
      }
      if (tweetId) {
        for (const link of root.querySelectorAll(`article[data-testid="tweet"] a[href*="/status/${tweetId}"]`)) {
          const article = link.closest?.('article[data-testid="tweet"]');
          if (article && !priorNodes.has(article)) return true;
        }
        for (const node of root.querySelectorAll('[data-testid="emptyState"], [data-testid="error-detail"]')) {
          if (!priorNodes.has(node)) return true;
        }
        return false;
      }
      if (handleLower) {
        for (const tab of root.querySelectorAll('a[role="tab"][href]')) {
          const href = tab.getAttribute("href")?.toLowerCase() ?? "";
          if (href === `/${handleLower}` || href.startsWith(`/${handleLower}/`)) return true;
        }
        const userNameEl = root.querySelector('[data-testid="UserName"]');
        if (userNameEl && (!priorNodes.has(userNameEl) || userNameEl.textContent?.toLowerCase().includes(`@${handleLower}`))) {
          return true;
        }
        for (const node of root.querySelectorAll('[data-testid="emptyState"], [data-testid="error-detail"]')) {
          if (!priorNodes.has(node)) return true;
        }
        return false;
      }
      for (const node of root.querySelectorAll(ARRIVAL_NODES_SELECTOR)) {
        if (!priorNodes.has(node)) return true;
      }
      return false;
    };

    const finishIfArrived = () => {
      if (listKind && !isCurrentList(listSuffix)) {
        cleanupPendingNavigation();
        return true;
      }
      if (!checkArrival()) return false;
      cleanupPendingArrival();
      if (listKind) {
        if (stopListScroll) resetScrollToTop({ includeListScroller: true });
      } else {
        cancelPendingScrollTimers();
        scheduleScrollToTop();
      }
      return true;
    };

    if (typeof MutationObserver === "function") {
      pendingNavigationObserver = new MutationObserver(() => {
        if (pendingCheckTimer !== null) return;
        pendingCheckTimer = setTimeout(() => {
          pendingCheckTimer = null;
          finishIfArrived();
        }, ARRIVAL_CHECK_DEBOUNCE_MS);
      });
      const root = document.body || document.documentElement;
      if (root) {
        pendingNavigationObserver.observe(root, { childList: true, subtree: true });
      }
    }

    pendingNavigationTimer = setTimeout(() => {
      if (finishIfArrived()) return;
      cleanupPendingNavigation();
      try {
        const fullUrl = new URL(url, window.location?.href || "https://x.com").href;
        if (window.location) window.location.href = fullUrl;
      } catch {}
    }, FALLBACK_RELOAD_MS);
  }

  function installFrame({ getColumnId, getParentOrigin }) {
    if (frameInstalled) return;
    frameInstalled = true;
    getColumnIdFn = getColumnId;
    getParentOriginFn = getParentOrigin;

    window.addEventListener("pagehide", () => {
      cleanupPendingNavigation();
      clearReviewList();
      stopProfileWatch();
    });
    window.addEventListener("popstate", onReviewLocationChange);
    window.navigation?.addEventListener("currententrychange", onReviewLocationChange);
    document.addEventListener("visibilitychange", syncReviewMarks);
    window.addEventListener("yomikui-frame-column-visibility", event => {
      reviewColumnVisible = event.detail?.visible !== false;
      syncReviewMarks();
    });

    // A newly mounted column can load the list directly. History traversal
    // should continue to restore the position from the previous visit.
    const freshList = normalizeStatusPath(window.location.pathname)?.match(STATUS_LIST_SUFFIX_RE);
    if (freshList && window.performance?.getEntriesByType("navigation")[0]?.type === "navigate") {
      keepInitialListScrollAtTop(freshList[0].toLowerCase());
    }

    window.addEventListener("message", event => {
      if (event.source !== window.parent || !isAllowedOrigin(event.origin)) return;
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type === "yomikui-tweet-route-open") {
        const path = normalizeRoutePath(event.data.path);
        if (!path) return;
        const alreadyOpen = normalizeRoutePath(window.location.href) === path;
        stopProfileWatch();
        openInPlace(path);
        if (alreadyOpen && event.data.review) watchProfileDisplay(event.data.review, event.origin);
      } else if (event.data.type === "yomikui-profile-review-watch") {
        watchProfileDisplay(event.data.request, event.origin);
      } else if (event.data.type === "yomikui-profile-review-mark") {
        markReviewedProfile(event.data);
      }
    });
  }

  function replacePlaceholders(template, args) {
    if (typeof template !== "string") return "";
    let out = template;
    for (let i = 0; i < args.length; i++) {
      out = out.replace(new RegExp(`\\$${i + 1}\\$?`, "g"), String(args[i]));
    }
    return out;
  }

  function LinkIcon({ jsx }) {
    return jsx.jsxs("svg", {
      xmlns: "http://www.w3.org/2000/svg",
      width: 14,
      height: 14,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: "shrink-0 text-muted-foreground",
      "aria-hidden": true,
      focusable: "false",
      children: [
        jsx.jsx("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
        jsx.jsx("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }),
      ],
    });
  }

  // --- Settings UI Component (placed in Column Settings -> General) ---
  // Rendered as a compact row matching other settings items: label on the left,
  // segmented mode buttons on the right ([この列] [右隣] [指定…]).
  // Selecting "指定…" reveals an inline target column picker chip-row directly beneath it.
  function SettingsControls({
    column,
    columns,
    onChange,
    formatColumnName,
    jsx,
    t,
    Label,
    rowClassName = "flex min-h-9 items-center justify-between gap-4",
    disabled = false,
  }) {
    if (!column || !isSourceEligible(column)) return null;

    const tr = (key, fallback) => {
      if (typeof t !== "function") return fallback;
      const val = t(key);
      return val && typeof val === "string" && val !== key && !val.startsWith("column_settings_")
        ? val
        : fallback;
    };

    const cols = Array.isArray(columns) ? columns : [];
    const nameOf = col => (typeof formatColumnName === "function" ? formatColumnName(col) : col?.title) || "";
    const formatItem = (idx, col) => {
      const msg = tr("column_settings_link_target_col_item", "$1列目: $2");
      return replacePlaceholders(msg, [idx + 1, nameOf(col)]);
    };

    const nextInfo = resolveNextColumn(column.id, cols);
    const nextOptionTitle = nextInfo
      ? (() => {
          const itemLabel = formatItem(nextInfo.index, nextInfo.column);
          const msg = tr("column_settings_link_target_next_with_name", "右隣の列（$1）");
          return replacePlaceholders(msg, [itemLabel]);
        })()
      : tr("column_settings_link_target_next_unavailable", "右隣の列（現在対象なし）");

    const eligibleTargets = [];
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      if (!col || col.id === column.id || !isTargetEligible(col)) continue;
      eligibleTargets.push({ id: col.id, label: formatItem(i, col) });
    }

    const rawValue = typeof column.linkTarget === "string" ? column.linkTarget : "";
    const effectiveValue =
      rawValue === "next" || eligibleTargets.some(item => item.id === rawValue) ? rawValue : "";

    const isCustom = effectiveValue !== "" && effectiveValue !== "next";
    const currentMode = effectiveValue === "" ? "self" : effectiveValue === "next" ? "next" : "custom";

    const defaultDesc = tr(
      "column_settings_link_target_desc",
      "ツイート・一覧・ユーザー・ハッシュタグ等の遷移先を開く列を指定します。"
    );
    const descText =
      effectiveValue === "next" && !nextInfo
        ? `${defaultDesc} ${tr("column_settings_link_target_next_missing_note", "※右隣に表示可能な列がない間は、この列で開きます。")}`
        : defaultDesc;

    const labelText = tr("column_settings_link_target", "リンクの表示先");

    const labelNode = jsx.jsxs("span", {
      className: "shrink-0 flex items-center gap-1.5 text-sm text-foreground whitespace-nowrap",
      title: descText,
      children: [
        jsx.jsx(LinkIcon, { jsx }),
        jsx.jsx("span", { className: "whitespace-nowrap", children: labelText }),
      ],
    });

    const selfLabel = tr("column_settings_link_target_mode_self", "この列");
    const nextLabel = tr("column_settings_link_target_mode_next", "右隣");
    const customLabel = tr("column_settings_link_target_mode_custom", "指定…");

    const buttonBaseClass =
      "flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors";
    const activeClass = "bg-accent text-accent-foreground";
    const inactiveClass = "text-muted-foreground hover:bg-muted/50";

    const primaryRow = jsx.jsxs("div", {
      className: rowClassName,
      children: [
        labelNode,
        jsx.jsxs("div", {
          role: "group",
          "aria-label": labelText,
          className: "flex shrink-0 overflow-hidden rounded-lg border border-border",
          children: [
            jsx.jsx("button", {
              type: "button",
              "aria-pressed": currentMode === "self",
              disabled,
              title: tr("column_settings_link_target_self", "この列で開く（標準）"),
              className: `${buttonBaseClass} ${currentMode === "self" ? activeClass : inactiveClass}`,
              onClick: () => {
                if (currentMode !== "self") onChange({ linkTarget: "" });
              },
              children: selfLabel,
            }, "self"),
            jsx.jsx("button", {
              type: "button",
              "aria-pressed": currentMode === "next",
              disabled: disabled || !nextInfo,
              title: nextOptionTitle,
              className: `${buttonBaseClass} ${
                currentMode === "next"
                  ? activeClass
                  : !nextInfo
                    ? "opacity-50 cursor-not-allowed text-muted-foreground"
                    : inactiveClass
              }`,
              onClick: () => {
                if (nextInfo && currentMode !== "next") onChange({ linkTarget: "next" });
              },
              children: nextLabel,
            }, "next"),
            jsx.jsx("button", {
              type: "button",
              "aria-pressed": currentMode === "custom",
              disabled: disabled || eligibleTargets.length === 0,
              title: tr("column_settings_link_target_desc", "特定の列を指定して開きます"),
              className: `${buttonBaseClass} ${
                currentMode === "custom"
                  ? activeClass
                  : eligibleTargets.length === 0
                    ? "opacity-50 cursor-not-allowed text-muted-foreground"
                    : inactiveClass
              }`,
              onClick: () => {
                if (eligibleTargets.length > 0 && currentMode !== "custom") {
                  onChange({ linkTarget: eligibleTargets[0].id });
                }
              },
              children: customLabel,
            }, "custom"),
          ],
        }),
      ],
    });

    const customRow = isCustom && eligibleTargets.length > 0
      ? jsx.jsxs("div", {
          className: "flex flex-wrap items-center gap-1.5 pl-5 pb-1",
          children: [
            jsx.jsx("span", {
              className: "text-xs text-muted-foreground shrink-0 mr-0.5 whitespace-nowrap",
              children: tr("column_settings_link_target_select_col", "送り先:"),
            }),
            ...eligibleTargets.map(item => {
              const isSelected = effectiveValue === item.id;
              return jsx.jsx("button", {
                type: "button",
                "aria-pressed": isSelected,
                disabled,
                title: item.label,
                className:
                  "rounded-md border px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors " +
                  (isSelected
                    ? "border-primary bg-primary text-primary-foreground shadow-xs"
                    : "border-border bg-background text-foreground hover:bg-muted/60"),
                onClick: () => {
                  if (!isSelected) onChange({ linkTarget: item.id });
                },
                children: item.label,
              }, item.id);
            }),
          ],
        })
      : null;

    const nextMissingNote =
      currentMode === "next" && !nextInfo
        ? jsx.jsx("p", {
            className: "text-xs text-muted-foreground pl-5 pb-1",
            children: tr(
              "column_settings_link_target_next_missing_note",
              "※右隣に表示可能な列がない間は、この列で開きます。"
            ),
          })
        : null;

    if (!customRow && !nextMissingNote) {
      return primaryRow;
    }

    return jsx.jsxs("div", {
      className: "flex flex-col gap-1.5",
      children: [primaryRow, customRow, nextMissingNote].filter(Boolean),
    });
  }

  function getProfileAllUrl(anchor) {
    if (anchor.hasAttribute("download") || anchor.closest('[role="tablist"], [role="tab"]')) return null;
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#") || href.startsWith("?")) return null;
    try {
      const url = new URL(anchor.href, window.location.href);
      if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
      const path = getProfileAllPath(url.pathname);
      if (!path) return null;
      url.pathname = path;
      return url;
    } catch {
      return null;
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", onLinkInteraction, true);
    document.addEventListener("auxclick", onLinkInteraction, true);
    document.addEventListener("contextmenu", onLinkInteraction, true);
  }

  globalThis.YomikuiTweetRouting = Object.freeze({
    isAllowedOrigin,
    isProfilePath,
    normalizeStatusPath,
    normalizeRoutePath,
    isTargetEligible,
    isSourceEligible,
    resolveNextColumn,
    resolveTargetColumn,
    shouldRoute,
    sanitizeColumns,
    isFullyVisible,
    withPendingPath,
    peekPendingSrc,
    takePendingSrc,
    clearPending,
    route,
    setFrameEnabled,
    isFrameEnabled,
    resolveClickTarget,
    resetScrollToTop,
    openInPlace,
    installFrame,
    SettingsControls,
  });
})();
