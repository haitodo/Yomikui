"use strict";

// Shared by the dashboard and native X frames; the existing UI is a bundle.
(() => {
  const ALLOWED_PAGE_HOSTS = new Set(["x.com", "twitter.com"]);
  const HOST_ORIGIN_RE = /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:x|twitter)\.com$/i;

  function pageKey(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, "https://x.com");
      if (url.protocol !== "https:" || !ALLOWED_PAGE_HOSTS.has(url.hostname)) return null;
      return url.pathname.replace(/\/+$/, "") || "/";
    } catch { return null; }
  }

  function restorableTab(tab, savedPath, currentUrl) {
    const path = pageKey(currentUrl);
    // Search encodes its selected tab in the URL (e.g. f=live). Clicking a
    // remembered tab would add history and could override that explicit URL.
    if (!path || path === "/search" || pageKey(savedPath) !== path) return null;
    return typeof tab === "string" && tab.trim() ? tab.trim() : null;
  }

  function displayTitle(column, activeTab, defaultTitle, typeLabel) {
    if (column.title !== typeLabel && column.title !== defaultTitle) return column.title;
    const tab = typeof activeTab === "string" ? activeTab.trim() : "";
    return tab && tab !== defaultTitle ? `${defaultTitle} · ${tab}` : defaultTitle;
  }

  function ResetButton({ column, onReset, Button, jsx, t }) {
    if (column.type === "timeline" || column.type === "chat") return null;
    return jsx.jsx(Button, {
      type: "button", variant: "ghost", size: "sm",
      className: "rd-column-action-reset shrink-0",
      onClick: onReset,
      title: t("column_reset_page"),
      "aria-label": t("column_reset_page"),
      children: jsx.jsxs("svg", {
        viewBox: "0 0 24 24", width: 14, height: 14, fill: "none",
        stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": true,
        children: [
          jsx.jsx("path", { d: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" }),
          jsx.jsx("path", { d: "M9 21v-8h6v8" }),
        ],
      }),
    });
  }

  function cleanUrl(rawUrl, defaultOrigin) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      return defaultOrigin || "https://x.com";
    }
    const origin = (typeof defaultOrigin === "string" && defaultOrigin.startsWith("http"))
      ? defaultOrigin
      : (typeof window !== "undefined" && window?.location?.origin && HOST_ORIGIN_RE.test(window.location.origin))
        ? window.location.origin
        : "https://x.com";
    try {
      const url = new URL(rawUrl, origin);

      if (url.pathname.includes("liveFeedShell")) {
        const cu = url.searchParams.get("cu");
        if (cu) return cleanUrl(cu, origin);
        const fp = url.searchParams.get("fp") || "/home";
        const fs = url.searchParams.get("fs") || "";
        return cleanUrl(`${fp}${fs}`, origin);
      }

      url.searchParams.delete("yomikui");

      if (url.hash.startsWith("#yomikui-") || url.hash === "#yomikui") {
        url.hash = "";
      }

      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  function getColumnUrl(column, iframe, defaultOrigin) {
    const frameEl = iframe && typeof iframe === "object" && "current" in iframe ? iframe.current : iframe;
    let rawUrl = null;
    try {
      const href = frameEl?.contentWindow?.location?.href;
      if (typeof href === "string" && href && href !== "about:blank") {
        rawUrl = href;
      }
    } catch {}

    if (!rawUrl) {
      if (column?.rememberLastPage && column?.lastPath) {
        rawUrl = column.lastPath;
      } else if (column?.type === "customUrl" && column?.customUrl) {
        rawUrl = column.customUrl;
      } else if (column?.path) {
        rawUrl = column.path;
      } else {
        rawUrl = "/home";
      }
    }

    return cleanUrl(rawUrl, defaultOrigin);
  }

  async function copyToClipboard(text) {
    if (typeof text !== "string" || !text) return false;
    try {
      if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      if (typeof document !== "undefined") {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.select();
        const success = document.execCommand("copy");
        document.body.removeChild(textArea);
        return success;
      }
    } catch {}
    return false;
  }

  function CopyUrlButton({ column, iframe, iframeRef, onCopy, Button, jsx, t, useState, useEffect }) {
    const frame = iframeRef ?? iframe;
    const [copied, setCopied] = useState ? useState(false) : [false, () => {}];

    if (useEffect) {
      useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => {
          setCopied(false);
        }, 2000);
        return () => clearTimeout(timer);
      }, [copied]);
    }

    const handleCopy = async (ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      const url = getColumnUrl(column, frame);
      const success = await copyToClipboard(url);
      if (success) {
        setCopied(true);
      }
      if (typeof onCopy === "function") {
        onCopy(url, success);
      }
    };

    const label = copied
      ? (t("column_copy_url_copied") || "URLをコピーしました")
      : (t("column_copy_url") || "この列のURLをコピー");

    return jsx.jsx(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      className: `rd-column-action-copy-url shrink-0 ${copied ? "text-emerald-500 hover:text-emerald-500" : ""}`,
      onClick: handleCopy,
      title: label,
      "aria-label": label,
      children: copied
        ? jsx.jsx("svg", {
            viewBox: "0 0 24 24", width: 14, height: 14, fill: "none",
            stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
            "aria-hidden": true,
            children: jsx.jsx("polyline", { points: "20 6 9 17 4 12" }),
          })
        : jsx.jsxs("svg", {
            viewBox: "0 0 24 24", width: 14, height: 14, fill: "none",
            stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
            "aria-hidden": true,
            children: [
              jsx.jsx("rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }),
              jsx.jsx("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }),
            ],
          }),
    });
  }

  function isInputActive(targetDoc = (typeof document !== "undefined" ? document : null)) {
    if (!targetDoc) return false;
    try {
      const active = targetDoc.activeElement;
      if (!active) return false;
      const tag = active.tagName?.toUpperCase?.();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (active.isContentEditable) return true;
      const role = active.getAttribute?.("role");
      if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
      if (active.closest?.('[contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], form, [data-testid="tweetTextarea_0"]')) {
        return true;
      }
    } catch {}
    return false;
  }

  function installDeckHoverFocus(rootDoc = (typeof document !== "undefined" ? document : null)) {
    if (!rootDoc || rootDoc.__yomikuiDeckHoverFocusInstalled) return () => {};
    rootDoc.__yomikuiDeckHoverFocusInstalled = true;

    let lastFocusedIframe = null;
    let lastBackMessageTime = -Infinity;
    const BACK_BUTTON_DEBOUNCE_MS = 250;

    const handlePointerOver = (event) => {
      if (event?.buttons !== 0) return;
      if (isInputActive(rootDoc)) return;

      const columnEl = event?.target?.closest?.(".rd-column");
      if (!columnEl) return;

      const iframeEl = columnEl.querySelector?.("iframe");
      if (!iframeEl || iframeEl === lastFocusedIframe) return;

      if (rootDoc.activeElement === iframeEl) {
        lastFocusedIframe = iframeEl;
        return;
      }

      try {
        iframeEl.focus();
        lastFocusedIframe = iframeEl;
      } catch {}
    };

    const handleMouseBackButton = (event) => {
      if (event?.button !== 3) return;

      event.preventDefault?.();
      event.stopPropagation?.();

      const now = Date.now();
      if (now - lastBackMessageTime < BACK_BUTTON_DEBOUNCE_MS) return;
      lastBackMessageTime = now;

      const columnEl = event?.target?.closest?.(".rd-column");
      const iframeEl = columnEl?.querySelector?.("iframe") || lastFocusedIframe;
      if (!iframeEl) return;

      try {
        iframeEl.focus?.();
        iframeEl.contentWindow?.postMessage?.({ type: "yomikui-go-back" }, "*");
      } catch {}
    };

    rootDoc.addEventListener("pointerover", handlePointerOver, { passive: true, capture: true });
    rootDoc.addEventListener("mouseover", handlePointerOver, { passive: true, capture: true });
    rootDoc.addEventListener("pointerdown", handleMouseBackButton, true);
    rootDoc.addEventListener("mousedown", handleMouseBackButton, true);
    rootDoc.addEventListener("auxclick", handleMouseBackButton, true);
    rootDoc.addEventListener("mouseup", handleMouseBackButton, true);

    return () => {
      rootDoc.removeEventListener("pointerover", handlePointerOver, { capture: true });
      rootDoc.removeEventListener("mouseover", handlePointerOver, { capture: true });
      rootDoc.removeEventListener("pointerdown", handleMouseBackButton, true);
      rootDoc.removeEventListener("mousedown", handleMouseBackButton, true);
      rootDoc.removeEventListener("auxclick", handleMouseBackButton, true);
      rootDoc.removeEventListener("mouseup", handleMouseBackButton, true);
      delete rootDoc.__yomikuiDeckHoverFocusInstalled;
    };
  }

  function installFrameHoverFocus(frameDoc = (typeof document !== "undefined" ? document : null), frameWin = (typeof window !== "undefined" ? window : null)) {
    if (!frameDoc || !frameWin || frameDoc.__yomikuiFrameHoverFocusInstalled) return () => {};
    frameDoc.__yomikuiFrameHoverFocusInstalled = true;

    const handlePointerMove = (event) => {
      if (event?.buttons !== 0) return;
      if (typeof frameDoc.hasFocus === "function" && frameDoc.hasFocus()) return;
      if (isInputActive(frameDoc)) return;

      try {
        frameWin.focus();
      } catch {}
    };

    const handlePointerDown = (event) => {
      if (event?.button === 3) {
        if (typeof frameDoc.hasFocus === "function" && !frameDoc.hasFocus()) {
          try {
            frameWin.focus();
          } catch {}
        }
      }
    };

    frameWin.addEventListener("pointermove", handlePointerMove, { passive: true });
    frameWin.addEventListener("mousemove", handlePointerMove, { passive: true });
    frameWin.addEventListener("pointerenter", handlePointerMove, { passive: true });
    frameWin.addEventListener("pointerdown", handlePointerDown, true);
    frameWin.addEventListener("mousedown", handlePointerDown, true);
    frameWin.addEventListener("auxclick", handlePointerDown, true);

    return () => {
      frameWin.removeEventListener("pointermove", handlePointerMove);
      frameWin.removeEventListener("mousemove", handlePointerMove);
      frameWin.removeEventListener("pointerenter", handlePointerMove);
      frameWin.removeEventListener("pointerdown", handlePointerDown, true);
      frameWin.removeEventListener("mousedown", handlePointerDown, true);
      frameWin.removeEventListener("auxclick", handlePointerDown, true);
      delete frameDoc.__yomikuiFrameHoverFocusInstalled;
    };
  }

  const ACCOUNT_STORAGE_KEY = "yomikui_current_account_v1";

  /**
   * DOM から現在ログイン中の X アカウント情報を抽出する
   */
  function extractAccountInfo(doc = (typeof document !== "undefined" ? document : null)) {
    if (!doc) return null;

    let avatarUrl = null;
    let name = null;
    let screenName = null;

    // 1. [data-testid="SideNav_AccountSwitcher_Button"] またはアカウントメニューボタン
    const switcherBtn = doc.querySelector?.(
      '[data-testid="SideNav_AccountSwitcher_Button"], button[aria-label*="Account"], button[aria-label*="アカウント"]'
    );

    if (switcherBtn) {
      const img = switcherBtn.querySelector?.('img[src*="profile_images"], img');
      if (img) {
        avatarUrl = img.getAttribute?.("src") || img.src || null;
        const alt = img.getAttribute?.("alt");
        if (alt && !alt.startsWith("@")) {
          name = alt.trim();
        }
      }

      const text = switcherBtn.innerText || switcherBtn.textContent || "";
      const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})/);
      if (handleMatch) {
        screenName = handleMatch[1];
      }

      if (!name) {
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        const handleIdx = lines.findIndex(l => l.startsWith("@"));
        if (handleIdx > 0) {
          name = lines[handleIdx - 1];
        } else if (lines.length > 0 && !lines[0].startsWith("@")) {
          name = lines[0];
        }
      }
    }

    // 2. フォールバック: AppTabBar_Profile_Link
    if (!screenName) {
      const profileLink = doc.querySelector?.(
        'a[data-testid="AppTabBar_Profile_Link"], a[href^="/"][aria-label*="Profile"], a[href^="/"][aria-label*="プロフィール"]'
      );
      if (profileLink) {
        const href = profileLink.getAttribute?.("href") || "";
        const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
        if (match) {
          const candidate = match[1].toLowerCase();
          const reserved = ["home", "explore", "notifications", "messages", "search", "i", "settings", "compose", "login", "logout"];
          if (!reserved.includes(candidate)) {
            screenName = match[1];
          }
        }
      }
    }

    // 3. フォールバック: プロフィール画像の再探索
    if (!avatarUrl && screenName) {
      const profileImg = doc.querySelector?.(`a[href*="/${screenName}"] img[src*="profile_images"]`);
      if (profileImg) {
        avatarUrl = profileImg.getAttribute?.("src") || profileImg.src || null;
      }
    }

    if (screenName || avatarUrl) {
      if (avatarUrl && typeof avatarUrl === "string") {
        avatarUrl = avatarUrl.replace(/_normal(\.[a-zA-Z0-9]+)$/, "_bigger$1");
      }
      return {
        screenName: screenName || "",
        name: name || screenName || "",
        avatarUrl: avatarUrl || "",
      };
    }

    return null;
  }

  function installAccountReporter(frameDoc = (typeof document !== "undefined" ? document : null), frameWin = (typeof window !== "undefined" ? window : null)) {
    if (!frameDoc || !frameWin || frameDoc.__yomikuiAccountReporterInstalled) return () => {};
    frameDoc.__yomikuiAccountReporterInstalled = true;

    let lastSent = null;

    const reportIfChanged = () => {
      try {
        const info = extractAccountInfo(frameDoc);
        if (!info) return;
        if (
          !lastSent ||
          lastSent.screenName !== info.screenName ||
          lastSent.name !== info.name ||
          lastSent.avatarUrl !== info.avatarUrl
        ) {
          lastSent = info;
          frameWin.parent?.postMessage?.({
            type: "yomikui-current-account-info",
            account: info,
          }, "*");
        }
      } catch {}
    };

    reportIfChanged();
    if (frameDoc.readyState === "loading") {
      frameDoc.addEventListener?.("DOMContentLoaded", reportIfChanged, { once: true });
    }
    frameWin.addEventListener?.("load", reportIfChanged, { once: true });

    const handleMessage = (event) => {
      if (event?.data?.type === "yomikui-request-account-info") {
        reportIfChanged();
      }
    };
    frameWin.addEventListener?.("message", handleMessage);

    let observer = null;
    try {
      const target = frameDoc.body || frameDoc.documentElement;
      if (target && typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => {
          reportIfChanged();
        });
        observer.observe(target, { childList: true, subtree: true });
      }
    } catch {}

    return () => {
      frameWin.removeEventListener?.("message", handleMessage);
      if (observer) observer.disconnect();
      delete frameDoc.__yomikuiAccountReporterInstalled;
    };
  }

  async function loadStoredAccount() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
        const res = await chrome.storage.local.get(ACCOUNT_STORAGE_KEY);
        return res?.[ACCOUNT_STORAGE_KEY] || null;
      }
    } catch {}
    return null;
  }

  async function saveStoredAccount(account) {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
        await chrome.storage.local.set({ [ACCOUNT_STORAGE_KEY]: account });
      }
    } catch {}
  }

  async function clearStoredAccount() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.remove) {
        await chrome.storage.local.remove(ACCOUNT_STORAGE_KEY);
      }
    } catch {}
  }

  function installAccountReceiver(rootWin = (typeof window !== "undefined" ? window : null), onAccountChange) {
    if (!rootWin) return () => {};

    const handleMessage = (event) => {
      if (event?.data?.type === "yomikui-current-account-info" && event.data.account) {
        const account = event.data.account;
        saveStoredAccount(account);
        onAccountChange?.(account);
      }
    };

    rootWin.addEventListener?.("message", handleMessage);
    return () => {
      rootWin.removeEventListener?.("message", handleMessage);
    };
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const isTopDeck = window.parent === window || (window.location?.pathname?.startsWith?.("/yomikui") ?? false);
    if (isTopDeck) {
      installDeckHoverFocus(document);
    } else {
      installFrameHoverFocus(document, window);
      installAccountReporter(document, window);
    }
  }

  globalThis.YomikuiColumnNavigation = Object.freeze({
    pageKey,
    restorableTab,
    displayTitle,
    ResetButton,
    cleanUrl,
    getColumnUrl,
    copyToClipboard,
    CopyUrlButton,
    isInputActive,
    installDeckHoverFocus,
    installFrameHoverFocus,
    extractAccountInfo,
    installAccountReporter,
    installAccountReceiver,
    loadStoredAccount,
    saveStoredAccount,
    clearStoredAccount,
    ACCOUNT_STORAGE_KEY,
  });
})();
