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
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    return STATUS_PATH_RE.test(pathname) ? pathname : null;
  }

  function normalizeRoutePath(value) {
    const parsed = parseInternalUrl(value);
    if (!parsed) return null;
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
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
    if (!column || typeof column !== "object") return false;
    return !EXCLUDED_TYPES.has(column.type) && column.liveFeed !== true;
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
      if (!path || !PROFILE_PATH_RE.test(path)) continue;
      if (!link.closest?.('[data-testid="UserDescription"]')) return path;
      if (!fallback) fallback = path;
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
        return normalizeRoutePath(node.getAttribute("href"));
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
    const isProfile = !tweetId && PROFILE_PATH_RE.test(cleanPath);
    const handleLower = isProfile ? cleanPath.slice(1).toLowerCase() : null;

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
      const token = `$${i + 1}`;
      out = out.replace(new RegExp(`\\$${i + 1}\\$?`, "g"), String(args[i]));
    }
    return out;
  }

  // --- Settings UI Component (placed in Column Settings -> General) ---
  function SettingsControls({ column, columns, onChange, formatColumnName, jsx, t, disabled = false }) {
    if (!column || !isSourceEligible(column)) return null;
    const cols = Array.isArray(columns) ? columns : [];
    const nameOf = col => (typeof formatColumnName === "function" ? formatColumnName(col) : col?.title) || "";
    const formatItem = (idx, col) => {
      const msg = t("column_settings_link_target_col_item", [idx + 1, nameOf(col)]);
      return msg && !msg.includes("$1") ? msg : replacePlaceholders(msg || "$1列目: $2", [idx + 1, nameOf(col)]);
    };

    const nextInfo = resolveNextColumn(column.id, cols);
    const nextOptionLabel = nextInfo
      ? (() => {
          const itemLabel = formatItem(nextInfo.index, nextInfo.column);
          const msg = t("column_settings_link_target_next_with_name", [itemLabel]);
          return msg && !msg.includes("$1") ? msg : replacePlaceholders(msg || "右隣の列（$1）", [itemLabel]);
        })()
      : t("column_settings_link_target_next_unavailable");

    const eligibleTargets = [];
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      if (!col || col.id === column.id || !isTargetEligible(col)) continue;
      eligibleTargets.push({ id: col.id, label: formatItem(i, col) });
    }

    const rawValue = typeof column.linkTarget === "string" ? column.linkTarget : "";
    const effectiveValue =
      rawValue === "next" || eligibleTargets.some(item => item.id === rawValue) ? rawValue : "";

    const selectId = `yomikui-link-target-${column.id}`;
    const descId = `${selectId}-desc`;
    const descText =
      effectiveValue === "next" && !nextInfo
        ? `${t("column_settings_link_target_desc")} ${t("column_settings_link_target_next_missing_note")}`
        : t("column_settings_link_target_desc");

    return jsx.jsxs("div", {
      className: "flex flex-col gap-2 py-1",
      children: [
        jsx.jsx("label", {
          htmlFor: selectId,
          className: "text-sm text-foreground",
          children: t("column_settings_link_target"),
        }),
        jsx.jsxs("select", {
          id: selectId,
          value: effectiveValue,
          disabled,
          "aria-describedby": descId,
          className: "h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground",
          onChange: event => {
            onChange({ linkTarget: event.currentTarget.value || "" });
          },
          children: [
            jsx.jsx("option", { value: "", children: t("column_settings_link_target_self") }, "self"),
            jsx.jsx("option", { value: "next", children: nextOptionLabel }, "next"),
            ...eligibleTargets.map(item =>
              jsx.jsx("option", { value: item.id, children: item.label }, item.id)
            ),
          ],
        }),
        jsx.jsx("p", {
          id: descId,
          className: "text-xs text-muted-foreground",
          children: descText,
        }),
      ],
    });
  }

  globalThis.YomikuiTweetRouting = Object.freeze({
    isAllowedOrigin,
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
