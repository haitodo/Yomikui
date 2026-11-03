"use strict";

// Loaded before contentDeck.js. Keep the layout rules and controls readable
// while the existing dashboard is distributed as a prebuilt bundle.
(() => {
  const DEFAULT_WIDTH_REM = 32;
  const MIN_WIDTH_REM = 20;
  const MAX_WIDTH_REM = 45;

  function getFixedWidth(column) {
    return Number.isFinite(column.width) && column.width > 0
      ? column.width
      : DEFAULT_WIDTH_REM;
  }

  function getColumnStyle(column) {
    if (column.widthMode === "auto") {
      return { flex: "1 0 0rem", width: 0, minWidth: `${MIN_WIDTH_REM}rem` };
    }
    const width = `${getFixedWidth(column)}rem`;
    return { flex: `0 0 ${width}`, width, minWidth: width };
  }

  function equalizeColumns(columns) {
    if (columns.every(column => column.widthMode === "auto")) return columns;
    return columns.map(column => column.widthMode === "auto"
      ? column
      : { ...column, widthMode: "auto" });
  }

  function parseFixedWidth(value) {
    if (String(value).trim() === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(Math.max(MIN_WIDTH_REM, Math.min(MAX_WIDTH_REM, number)));
  }

  // Use the dashboard's JSX runtime and existing Slider/Input components.
  // The parent retains its slider state and debounced width updates.
  function WidthControl({ column, width, onWidthChange, onModeChange, Slider, Input, jsx, t }) {
    const mode = column.widthMode === "auto" ? "auto" : "fixed";
    const modeId = `rd-column-width-mode-${column.id}`;
    const descriptionId = `${modeId}-description`;
    const inputId = `rd-column-fixed-width-${column.id}`;
    const commitWidth = event => {
      const value = parseFixedWidth(event.currentTarget.value);
      event.currentTarget.value = String(value ?? width);
      if (value !== null && value !== width) onWidthChange(value);
    };

    return jsx.jsxs("div", {
      className: "flex flex-col gap-2",
      children: [
        jsx.jsxs("div", {
          className: "flex min-w-0 items-center justify-between gap-2",
          children: [
            jsx.jsx("label", {
              htmlFor: modeId,
              className: "shrink-0 text-sm text-foreground",
              children: t("column_settings_column_width"),
            }),
            jsx.jsxs("select", {
              id: modeId,
              value: mode,
              className: "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground",
              "aria-describedby": mode === "auto" ? descriptionId : undefined,
              onChange: event => onModeChange(event.currentTarget.value),
              children: [
                jsx.jsx("option", { value: "auto", children: t("column_settings_width_auto") }),
                jsx.jsx("option", { value: "fixed", children: t("column_settings_width_fixed") }),
              ],
            }),
          ],
        }),
        mode === "auto"
          ? jsx.jsx("p", {
            id: descriptionId,
            className: "text-xs text-muted-foreground",
            children: t("column_settings_width_auto_desc"),
          })
          : jsx.jsxs("div", {
            className: "flex flex-col gap-1",
            children: [
              jsx.jsxs("div", {
                className: "flex items-center justify-between gap-2",
                children: [
                  jsx.jsx("label", {
                    htmlFor: inputId,
                    className: "text-xs text-muted-foreground",
                    children: t("column_settings_width_fixed"),
                  }),
                  jsx.jsxs("div", {
                    className: "flex shrink-0 items-center gap-2",
                    children: [
                      jsx.jsx(Input, {
                        id: inputId,
                        type: "number",
                        min: MIN_WIDTH_REM,
                        max: MAX_WIDTH_REM,
                        step: 1,
                        defaultValue: width,
                        className: "h-8 text-sm tabular-nums",
                        style: { width: "5rem" },
                        onBlur: commitWidth,
                        onKeyDown: event => {
                          if (event.key !== "Enter" && event.key !== "Escape") return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.key === "Escape") event.currentTarget.value = String(width);
                          event.currentTarget.blur();
                        },
                      }, `${column.id}-${width}`),
                      jsx.jsx("span", {
                        className: "text-xs text-muted-foreground",
                        children: t("common_rem"),
                      }),
                    ],
                  }),
                ],
              }),
              jsx.jsx(Slider, {
                value: [width],
                min: MIN_WIDTH_REM,
                max: MAX_WIDTH_REM,
                step: 1,
                "aria-label": t("column_settings_width_fixed"),
                onValueChange: ([value]) => onWidthChange(value),
                className: "w-full",
              }),
            ],
          }),
      ],
    });
  }

  globalThis.YomikuiColumnLayout = Object.freeze({
    DEFAULT_WIDTH_REM,
    MIN_WIDTH_REM,
    MAX_WIDTH_REM,
    getFixedWidth,
    getColumnStyle,
    equalizeColumns,
    parseFixedWidth,
    WidthControl,
  });
})();
