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

  function isProfilePath(pathname) {
    if (!pathname || typeof pathname !== "string") return false;
    const clean = withoutTrailingSlashes(pathname);
    if (!PROFILE_PATH_RE.test(clean)) return false;
    const segment = clean.slice(1).toLowerCase();
    return !RESERVED_ROOT_PATHS.has(segment) && !EXCLUDED_ROOT_ROUTE_RE.test(clean);
  }

  function toProfileAllPath(pathname) {
    if (!pathname || typeof pathname !== "string") return pathname;
    const clean = withoutTrailingSlashes(pathname);
    if (isProfilePath(clean)) {
      return `${clean}/all`;
    }
    return pathname;
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

  function withoutTrailingSlashes(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
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
  const focusTimers = new WeakMap();

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
    if (columnId) pendingPaths.delete(columnId);
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

  function route({ columns, sourceId, statusPath, routePath, isComposing = false, columnComposing = null }) {
    const path = normalizeRoutePath(routePath ?? statusPath);
    if (!path || !Array.isArray(columns)) return false;
    const source = columns.find(c => c && c.id === sourceId);
    if (!source) return false;
    const target = resolveTargetColumn(source, columns);
    if (!target) return false;
    if (isComposing || columnComposing?.[target.id]) return false;

    const escapedId = globalThis.CSS?.escape
      ? globalThis.CSS.escape(target.id)
      : String(target.id).replace(/["\\]/g, "\\$&");
    const el = document.querySelector(`[data-column-id="${escapedId}"]`);
    if (!el) return false;
    const iframe = el.querySelector("iframe");

    const isLiveFeed = target.liveFeed === true || (iframe?.src && iframe.src.includes("liveFeedShell.html"));
    let isAboutBlank = false;
    if (iframe?.contentWindow) {
      try {
        isAboutBlank = iframe.contentWindow.location?.href === "about:blank";
      } catch {}
    }
    if (iframe?.contentWindow && !isLiveFeed && !isAboutBlank) {
      const origin = resolveIframeOrigin(iframe);
      try {
        iframe.contentWindow.postMessage({ type: "yomikui-tweet-route-open", path }, origin);
      } catch {
        iframe.contentWindow.postMessage({ type: "yomikui-tweet-route-open", path }, "*");
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
  let clickListenerAttached = false;
  let getColumnIdFn = null;
  let getParentOriginFn = null;

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
      const path = normalizeRoutePath(link.getAttribute("href"));
      if (!path || !isProfilePath(path)) continue;
      const allPath = toProfileAllPath(path);
      if (!link.closest?.('[data-testid="UserDescription"]')) return allPath;
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
    if (!frameEnabled || !event) return null;
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
        const normalized = normalizeRoutePath(node.getAttribute("href"));
        if (!normalized) return null;
        if (isProfilePath(normalized)) {
          return toProfileAllPath(normalized);
        }
        return normalized;
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

  function onDocumentClick(event) {
    const path = resolveClickTarget(event);
    if (!path) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const columnId = typeof getColumnIdFn === "function" ? getColumnIdFn() : null;
    const origin = (typeof getParentOriginFn === "function" ? getParentOriginFn() : null) || "*";
    try {
      window.parent.postMessage({ type: "yomikui-open-tweet", statusPath: path, columnId }, origin);
    } catch {
      window.parent.postMessage({ type: "yomikui-open-tweet", statusPath: path, columnId }, "*");
    }
  }

  function syncClickListener() {
    const shouldAttach = frameInstalled && frameEnabled;
    if (shouldAttach === clickListenerAttached) return;
    clickListenerAttached = shouldAttach;
    if (shouldAttach) {
      document.addEventListener("click", onDocumentClick, true);
    } else {
      document.removeEventListener("click", onDocumentClick, true);
    }
  }

  function setFrameEnabled(enabled) {
    const next = enabled === true;
    if (frameEnabled === next) return;
    frameEnabled = next;
    syncClickListener();
  }

  function isFrameEnabled() {
    return frameEnabled;
  }

  let pendingNavigationTimer = null;
  let pendingCheckTimer = null;
  let pendingNavigationObserver = null;

  function cleanupPendingNavigation() {
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

  function openInPlace(path) {
    const cleanPath = normalizeRoutePath(path);
    if (!cleanPath) return;

    const currentRoute = normalizeRoutePath(window.location?.href);
    if (currentRoute && currentRoute.toLowerCase() === cleanPath.toLowerCase() && currentRoute === cleanPath) {
      return;
    }

    cleanupPendingNavigation();

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
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    } catch {}

    const idMatch = cleanPath.match(/\/status\/(\d+)/);
    const tweetId = idMatch ? idMatch[1] : null;
    const listMatch = cleanPath.match(/\/status\/\d+\/(quotes|retweets|likes)$/i);
    const listKind = listMatch ? listMatch[1].toLowerCase() : null;
    const profileMatch =
      !tweetId &&
      cleanPath.match(/^\/([A-Za-z0-9_]+)(?:\/(?:all|with_replies|highlights|media|articles))?$/i);
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

    if (typeof MutationObserver === "function") {
      pendingNavigationObserver = new MutationObserver(() => {
        if (pendingCheckTimer !== null) return;
        pendingCheckTimer = setTimeout(() => {
          pendingCheckTimer = null;
          if (checkArrival()) cleanupPendingNavigation();
        }, ARRIVAL_CHECK_DEBOUNCE_MS);
      });
      const root = document.body || document.documentElement;
      if (root) {
        pendingNavigationObserver.observe(root, { childList: true, subtree: true });
      }
    }

    pendingNavigationTimer = setTimeout(() => {
      if (checkArrival()) {
        cleanupPendingNavigation();
        return;
      }
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
    syncClickListener();

    window.addEventListener("pagehide", cleanupPendingNavigation);

    window.addEventListener("message", event => {
      if (event.source !== window.parent || !isAllowedOrigin(event.origin)) return;
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type === "yomikui-tweet-route-open") {
        const path = normalizeRoutePath(event.data.path);
        if (path) openInPlace(path);
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

  function rewriteProfileAnchor(node) {
    if (!node || typeof node.closest !== "function") return null;
    if (node.closest('[role="tablist"], [role="tab"]')) return null;
    const anchor =
      node.tagName?.toUpperCase?.() === "A" && node.hasAttribute?.("href")
        ? node
        : node.closest("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return null;

    const href = anchor.getAttribute("href");
    if (!href) return null;

    const parsed = parseInternalUrl(href);
    if (!parsed) return null;
    const pathname = withoutTrailingSlashes(parsed.pathname);
    if (!isProfilePath(pathname)) return null;

    const targetPath = `${pathname}/all`;
    const search = parsed.search || "";
    const hash = anchor.hash || "";
    const newHref = `${targetPath}${search}${hash}`;

    if (anchor.getAttribute("href") !== newHref) {
      anchor.setAttribute("href", newHref);
    }
    return targetPath;
  }

  function handleProfileLinkInteraction(event) {
    const target = event?.target?.nodeType === 1 ? event.target : event?.target?.parentElement;
    if (!target) return;
    rewriteProfileAnchor(target);
    const userCell = target.closest?.('[data-testid="UserCell"]');
    if (userCell && typeof userCell.querySelectorAll === "function") {
      const cellLinks = userCell.querySelectorAll("a[href]");
      for (let i = 0; i < cellLinks.length; i++) {
        rewriteProfileAnchor(cellLinks[i]);
      }
    }
  }

  // --- Auto-select /all tab on profile navigation ---
  let userSelectedTab = false;
  let activeProfileHandle = null;
  let autoTabObserver = null;

  function getCurrentProfileHandle() {
    if (typeof window === "undefined" || !window.location) return null;
    const pathname = withoutTrailingSlashes(window.location.pathname || "");
    if (!pathname) return null;
    const match = pathname.match(/^\/([A-Za-z0-9_]+)(?:\/(all|with_replies|highlights|articles|media))?$/i);
    if (!match) return null;
    const handle = match[1];
    if (RESERVED_ROOT_PATHS.has(handle.toLowerCase()) || EXCLUDED_ROOT_ROUTE_RE.test(`/${handle}`)) {
      return null;
    }
    const subtab = match[2] ? match[2].toLowerCase() : "";
    return { handle: handle.toLowerCase(), subtab };
  }

  function tryClickAllTab() {
    const profile = getCurrentProfileHandle();
    if (!profile) {
      activeProfileHandle = null;
      userSelectedTab = false;
      return false;
    }

    if (activeProfileHandle !== profile.handle) {
      activeProfileHandle = profile.handle;
      userSelectedTab = false;
    }

    if (profile.subtab === "all" || userSelectedTab) {
      return true;
    }

    const root = document.querySelector?.('[data-testid="primaryColumn"]') || document;
    if (!root || typeof root.querySelectorAll !== "function") return false;

    const tabs = root.querySelectorAll('a[role="tab"]');
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const href = (tab.getAttribute?.("href") || "").toLowerCase();
      const text = (tab.textContent || "").trim();
      const isAllTab =
        href.endsWith("/all") ||
        href.includes(`/${profile.handle}/all`) ||
        text === "すべて" ||
        text === "All";

      if (isAllTab) {
        if (tab.getAttribute?.("aria-selected") !== "true") {
          tab.click?.();
        }
        return true;
      }
    }

    return false;
  }

  function startAutoTabObserver() {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    if (autoTabObserver) return;

    autoTabObserver = new MutationObserver(() => {
      tryClickAllTab();
    });

    const attach = () => {
      const target = document.documentElement || document.body;
      if (!target || typeof autoTabObserver.observe !== "function") return false;
      try {
        autoTabObserver.observe(target, { childList: true, subtree: true });
        return true;
      } catch {
        return false;
      }
    };

    if (!attach()) {
      document.addEventListener?.(
        "DOMContentLoaded",
        () => {
          attach();
          tryClickAllTab();
        },
        { once: true }
      );
    }

    tryClickAllTab();
  }

  function hookHistoryForProfileNavigation() {
    if (typeof window === "undefined" || !window.history) return;

    const onNavChange = () => {
      const profile = getCurrentProfileHandle();
      if (!profile) {
        activeProfileHandle = null;
        userSelectedTab = false;
      } else if (activeProfileHandle !== profile.handle) {
        activeProfileHandle = profile.handle;
        userSelectedTab = false;
      }
      tryClickAllTab();
    };

    try {
      const origPush = window.history.pushState?.bind(window.history);
      if (origPush) {
        window.history.pushState = function(...args) {
          const res = origPush(...args);
          onNavChange();
          return res;
        };
      }
      const origReplace = window.history.replaceState?.bind(window.history);
      if (origReplace) {
        window.history.replaceState = function(...args) {
          const res = origReplace(...args);
          onNavChange();
          return res;
        };
      }
    } catch {}

    window.addEventListener?.("popstate", onNavChange);
    document.addEventListener?.(
      "click",
      (e) => {
        const tab = e.target?.closest?.('a[role="tab"], [role="tab"]');
        if (tab) {
          userSelectedTab = true;
        }
      },
      true
    );
  }

  function initProfileLinkRewriter() {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    document.addEventListener("pointerdown", handleProfileLinkInteraction, true);
    document.addEventListener("click", handleProfileLinkInteraction, true);
    hookHistoryForProfileNavigation();
    startAutoTabObserver();
  }

  initProfileLinkRewriter();

  globalThis.YomikuiTweetRouting = Object.freeze({
    isAllowedOrigin,
    isProfilePath,
    toProfileAllPath,
    rewriteProfileAnchor,
    handleProfileLinkInteraction,
    getCurrentProfileHandle,
    tryClickAllTab,
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
    openInPlace,
    installFrame,
    SettingsControls,
  });
})();
