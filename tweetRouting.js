"use strict";

// Loaded before contentDeck.js and contentIframe.js.
// Manages routing tweet links opened in timeline columns to a designated target column.
(() => {
  if (globalThis.YomikuiTweetRouting) return;

  const EXCLUDED_TYPES = new Set(["timeline", "chat"]);
  const ALLOWED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const STATUS_PATH_RE = /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+(?:\/(?:quotes|retweets))?(?=\/?$)/;
  const STATUS_KEY_RE = /\/status\/\d+(?:\/(?:quotes|retweets))?$/;
  const IGNORED_TAGS = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO", "SUMMARY"]);
  const IGNORED_ROLES = new Set(["button", "menuitem", "tab", "checkbox", "switch", "menu", "dialog", "group"]);
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

  function normalizeStatusPath(value) {
    if (typeof value !== "string" || !value) return null;
    let pathname = value;
    if (value.charCodeAt(0) === 47 && value.charCodeAt(1) !== 47) {
      const q = value.indexOf("?");
      const h = value.indexOf("#");
      const cut = q === -1 ? h : (h === -1 ? q : Math.min(q, h));
      if (cut !== -1) pathname = value.slice(0, cut);
    } else {
      try {
        const url = new URL(value, "https://x.com");
        if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
        pathname = url.pathname;
      } catch {
        return null;
      }
    }
    const match = pathname.match(STATUS_PATH_RE);
    return match ? match[0] : null;
  }

  function statusRouteKey(value) {
    const path = normalizeStatusPath(value);
    return path ? (path.match(STATUS_KEY_RE)?.[0] ?? path) : null;
  }

  function isTargetEligible(column) {
    if (!column || typeof column !== "object") return false;
    return !EXCLUDED_TYPES.has(column.type) && column.liveFeed !== true;
  }

  function isSourceEligible(column) {
    if (!column || typeof column !== "object") return false;
    return !EXCLUDED_TYPES.has(column.type);
  }

  const targetColumnCache = new WeakMap();

  function findTargetColumn(columns) {
    if (!Array.isArray(columns)) return null;
    if (targetColumnCache.has(columns)) return targetColumnCache.get(columns);
    const found = columns.find(c => c && c.tweetTarget === true && isTargetEligible(c)) ?? null;
    targetColumnCache.set(columns, found);
    return found;
  }

  function normalizeTargets(columns) {
    if (!Array.isArray(columns)) return columns;
    let targetFound = false;
    let changed = false;
    const next = columns.map(c => {
      if (!c || c.tweetTarget !== true) return c;
      if (!isTargetEligible(c)) {
        changed = true;
        return { ...c, tweetTarget: false };
      }
      if (!targetFound) {
        targetFound = true;
        return c;
      }
      changed = true;
      return { ...c, tweetTarget: false };
    });
    return changed ? next : columns;
  }

  function shouldRoute(source, columns) {
    if (!source || !isSourceEligible(source) || source.openTweetsInTarget === false) return null;
    const target = findTargetColumn(columns);
    if (!target || target.id === source.id) return null;
    return target;
  }

  function isFullyVisible(columnRect, viewportRect) {
    if (!columnRect || !viewportRect) return false;
    return columnRect.left >= viewportRect.left - 1 && columnRect.right <= viewportRect.right + 1;
  }

  function withPendingPath(src, path) {
    if (typeof src !== "string" || !src || typeof path !== "string" || !path) return src;
    try {
      const url = new URL(src, "https://x.com");
      url.pathname = path;
      return url.toString();
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

  function route({ columns, sourceId, statusPath, isComposing = false, columnComposing = null }) {
    const path = normalizeStatusPath(statusPath);
    if (!path || !Array.isArray(columns)) return false;
    const source = columns.find(c => c && c.id === sourceId);
    if (!source) return false;
    const target = shouldRoute(source, columns);
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

  function isIgnoredElement(node) {
    const tag = node.tagName?.toUpperCase?.();
    if (tag && IGNORED_TAGS.has(tag)) return true;
    const role = node.getAttribute?.("role");
    if (role && IGNORED_ROLES.has(role)) return true;
    if (node.getAttribute?.("contenteditable") === "true") return true;
    const testId = node.getAttribute?.("data-testid");
    if (testId && IGNORED_TESTIDS.has(testId)) return true;
    const cls = node.classList;
    if (cls && (cls.contains("yomikui-cbv-overlay") || cls.contains("yomikui-add-label-btn") || cls.contains("yomikui-edit-nickname-btn"))) {
      return true;
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

    // Fast bailout for any click outside a native X tweet
    const tweet = target.closest('article[data-testid="tweet"]');
    if (!tweet || tweet.classList?.contains("rd-lf-tweet")) return null;
    if (tweet.closest?.('[role="dialog"], [role="menu"]')) return null;

    const selection = window.getSelection?.();
    if (selection && selection.isCollapsed !== true && selection.toString().trim() !== "") {
      return null;
    }

    // Single upward pass from target to tweet boundary
    for (let node = target; node && node !== tweet; node = node.parentElement) {
      if (isIgnoredElement(node)) {
        return null;
      }
      if (node.tagName?.toUpperCase?.() === "A" && node.hasAttribute?.("href")) {
        return normalizeStatusPath(node.getAttribute("href"));
      }
      const testId = node.getAttribute?.("data-testid");
      if (testId === "quoteTweet" || testId === "tweetQuote" || node.getAttribute?.("role") === "link") {
        return extractQuoteStatusPath(node);
      }
    }

    return globalThis.YomikuiTweetActions?.resolveTweetStatusPath?.(tweet) ?? null;
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
    const cleanPath = normalizeStatusPath(path);
    if (!cleanPath) return;

    const currentKey = statusRouteKey(window.location?.href)
      ?? globalThis.YomikuiColumnNavigation?.pageKey?.(window.location?.href);
    const targetKey = statusRouteKey(cleanPath) ?? cleanPath;
    if (currentKey && currentKey === targetKey) return;

    cleanupPendingNavigation();

    const ARRIVAL_NODES_SELECTOR = 'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="emptyState"], [data-testid="error-detail"]';
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
    const listKind = cleanPath.endsWith("/quotes")
      ? "quotes"
      : (cleanPath.endsWith("/retweets") ? "retweets" : null);

    const checkArrival = () => {
      const root = document.querySelector?.('[data-testid="primaryColumn"]') || document;
      if (listKind) {
        if (tweetId && root.querySelector(`a[role="tab"][href*="/status/${tweetId}/${listKind}"]`)) {
          return true;
        }
        for (const node of root.querySelectorAll(ARRIVAL_NODES_SELECTOR)) {
          if (!priorNodes.has(node)) return true;
        }
        return false;
      }
      if (!tweetId) return false;
      for (const link of root.querySelectorAll(`article[data-testid="tweet"] a[href*="/status/${tweetId}"]`)) {
        const article = link.closest?.('article[data-testid="tweet"]');
        if (article && !priorNodes.has(article)) return true;
      }
      for (const node of root.querySelectorAll('[data-testid="emptyState"], [data-testid="error-detail"]')) {
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
        const path = normalizeStatusPath(event.data.path);
        if (path) openInPlace(path);
      }
    });
  }

  // --- Settings UI Component ---
  function SettingsControls({ column, columns, onChange, onSetTarget, Switch, Label, jsx, t, rowClassName, disabled = false }) {
    if (!column) return null;
    const targetEligible = isTargetEligible(column);
    const sourceEligible = isSourceEligible(column) && !column.tweetTarget;
    if (!targetEligible && !sourceEligible) return null;

    const targetColumn = findTargetColumn(columns);
    const targetName = targetColumn ? targetColumn.title : "";
    const hasTarget = !!targetColumn && targetColumn.id !== column.id;

    const targetDesc = t("column_settings_tweet_target_desc");
    let openDesc = hasTarget
      ? t("column_settings_open_in_target_desc", [targetName])
      : t("column_settings_open_in_target_none");
    if (hasTarget && openDesc && openDesc.includes("$1")) {
      openDesc = openDesc.replace(/\$1\$?/g, targetName);
    }

    return jsx.jsxs(jsx.Fragment, {
      children: [
        targetEligible ? jsx.jsxs("div", {
          className: rowClassName,
          children: [
            jsx.jsx(Label, { label: t("column_settings_tweet_target"), description: targetDesc }),
            jsx.jsx(Switch, {
              checked: column.tweetTarget === true,
              disabled,
              "aria-label": t("column_settings_tweet_target"),
              onCheckedChange: checked => {
                onSetTarget(column.id, checked === true);
              },
            }),
          ],
        }, "tweetTarget") : null,
        sourceEligible ? jsx.jsxs("div", {
          className: rowClassName,
          children: [
            jsx.jsx(Label, { label: t("column_settings_open_in_target"), description: openDesc }),
            jsx.jsx(Switch, {
              checked: column.openTweetsInTarget !== false,
              disabled: disabled || !hasTarget,
              "aria-label": t("column_settings_open_in_target"),
              onCheckedChange: checked => {
                onChange({ openTweetsInTarget: checked === true });
              },
            }),
          ],
        }, "openTweetsInTarget") : null,
      ],
    });
  }

  globalThis.YomikuiTweetRouting = Object.freeze({
    isAllowedOrigin,
    normalizeStatusPath,
    isTargetEligible,
    isSourceEligible,
    findTargetColumn,
    normalizeTargets,
    shouldRoute,
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
