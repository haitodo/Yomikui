"use strict";

// Shared by the dashboard and native X frames; the existing UI is a bundle.
(() => {
  function pageKey(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, "https://x.com");
      if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return null;
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
      : (typeof window !== "undefined" && window?.location?.origin && /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:x|twitter)\.com$/i.test(window.location.origin))
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

  globalThis.YomikuiColumnNavigation = Object.freeze({
    pageKey,
    restorableTab,
    displayTitle,
    ResetButton,
    cleanUrl,
    getColumnUrl,
    copyToClipboard,
    CopyUrlButton,
  });
})();
