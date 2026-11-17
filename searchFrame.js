"use strict";

// Only URL validation and search navigation are needed inside the columns.
(() => {
  if (globalThis.YomikuiSearchFrame) return;

  const ALLOWED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const VALID_TABS = new Set(["top", "live", "media", "user", "list"]);
  const isSearchTab = tab => VALID_TABS.has(tab);

  function isTrustedOrigin(origin) {
    if (typeof origin !== "string" || !origin.startsWith("https://")) return false;
    try {
      return ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function searchUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, "https://x.com");
      if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
      if (url.pathname.replace(/\/+$/, "").toLowerCase() !== "/search") return null;
      return url.searchParams.get("q") === "yomikui-timeline" ? null : url;
    } catch {
      return null;
    }
  }

  function parseSearchUrl(value) {
    const url = searchUrl(value);
    if (!url) return null;
    const q = url.searchParams.get("q") ?? "";
    const rawTab = (url.searchParams.get("f") || "top").toLowerCase();
    return { q, tab: isSearchTab(rawTab) ? rawTab : "top" };
  }

  function installFrameSearchBridge(frameDoc, frameWin) {
    let lastReportedPath = null;
    let clickTimer = null;

    const reportPath = (force = false) => {
      try {
        const path = `${frameWin.location.pathname || "/"}${frameWin.location.search || ""}`;
        if (!force && path === lastReportedPath) return;
        lastReportedPath = path;
        frameWin.parent?.postMessage?.({ type: "yomikui-search-location", path }, "*");
      } catch {}
    };

    const scheduleClickCheck = () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        reportPath(false);
      }, 80);
    };

    const onMessage = (event) => {
      if (event.source !== frameWin.parent || !isTrustedOrigin(event.origin)) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "yomikui-search-location-request") {
        reportPath(true);
        return;
      }
      if (data.type === "yomikui-search-navigate") {
        const url = searchUrl(data.path);
        if (!url || !url.pathname.startsWith("/search")) return;
        const nextPath = `${url.pathname}${url.search}`;
        if (typeof globalThis.YomikuiTweetRouting?.openInPlace === "function") {
          globalThis.YomikuiTweetRouting.openInPlace(nextPath);
        } else {
          try {
            const fullUrl = new URL(nextPath + (frameWin.location?.hash || ""), frameWin.location?.href || "https://x.com").href;
            frameWin.location.href = fullUrl;
          } catch {}
        }
        lastReportedPath = nextPath;
      }
    };

    const onNavEvent = () => reportPath(false);
    const onInitialLoad = () => reportPath(true);

    reportPath(true);
    if (frameDoc.readyState === "loading") {
      frameDoc.addEventListener?.("DOMContentLoaded", onInitialLoad, { once: true });
    }
    frameWin.addEventListener?.("load", onInitialLoad, { once: true });
    frameWin.addEventListener?.("message", onMessage);
    frameWin.addEventListener?.("popstate", onNavEvent);
    frameWin.addEventListener?.("hashchange", onNavEvent);
    frameWin.navigation?.addEventListener?.("currententrychange", onNavEvent);
    frameWin.navigation?.addEventListener?.("navigatesuccess", onNavEvent);
    frameDoc.addEventListener?.("click", scheduleClickCheck, true);
  }

  globalThis.YomikuiSearchFrame = Object.freeze({ isTrustedOrigin, isSearchTab, parseSearchUrl });

  if (typeof window !== "undefined" && typeof document !== "undefined" && window.parent !== window &&
      !window.location?.pathname?.startsWith?.("/yomikui")) {
    installFrameSearchBridge(document, window);
  }
})();
