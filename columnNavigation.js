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

  globalThis.YomikuiColumnNavigation = Object.freeze({ pageKey, restorableTab, displayTitle, ResetButton });
})();
