"use strict";

// Shared by the dashboard and native X frames.
// Provides quick search-operator filter chips and reusable filter presets for /search columns.
(() => {
  if (globalThis.YomikuiSearchFilters) return;

  const PRESETS_STORAGE_KEY = "yomikui_search_filter_presets_v1";
  const ALLOWED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const RECENCY_DAYS = Object.freeze([1, 7, 30]);
  const FAVES_PRESETS = Object.freeze([10, 50, 100, 500, 1000]);
  const RETWEETS_PRESETS = Object.freeze([10, 50, 100, 500]);
  const MEDIA_OPTIONS = Object.freeze([
    { value: "images", labelKey: "search_filter_media_images", fallback: "画像" },
    { value: "videos", labelKey: "search_filter_media_videos", fallback: "動画" },
    { value: "media", labelKey: "search_filter_media_all", fallback: "メディア" },
  ]);
  const BOOLEAN_OPTIONS = Object.freeze([
    { key: "excludeRetweets", token: "-filter:retweets", labelKey: "search_filter_exclude_retweets", fallback: "RT除外" },
    { key: "excludeReplies", token: "-filter:replies", labelKey: "search_filter_exclude_replies", fallback: "返信除外" },
    { key: "excludeLinks", token: "-filter:links", labelKey: "search_filter_exclude_links", fallback: "リンク除外" },
    { key: "langJa", token: "lang:ja", labelKey: "search_filter_lang_ja", fallback: "日本語" },
  ]);
  const RECENCY_OPTIONS = Object.freeze([
    { days: 1, labelKey: "search_filter_since_1d", fallback: "24時間" },
    { days: 7, labelKey: "search_filter_since_7d", fallback: "7日" },
    { days: 30, labelKey: "search_filter_since_30d", fallback: "30日" },
  ]);
  const TAB_OPTIONS = Object.freeze([
    { value: "top", labelKey: "search_filter_tab_top", fallback: "話題" },
    { value: "live", labelKey: "search_filter_tab_live", fallback: "最新" },
    { value: "media", labelKey: "search_filter_tab_media", fallback: "メディア" },
  ]);
  const PERIOD_UNITS = Object.freeze([
    { value: "day", labelKey: "search_filter_unit_day", fallback: "日", currentKey: "search_filter_current_day", currentFallback: "今日" },
    { value: "week", labelKey: "search_filter_unit_week", fallback: "週", currentKey: "search_filter_current_week", currentFallback: "今週" },
    { value: "month", labelKey: "search_filter_unit_month", fallback: "月", currentKey: "search_filter_current_month", currentFallback: "今月" },
    { value: "year", labelKey: "search_filter_unit_year", fallback: "年", currentKey: "search_filter_current_year", currentFallback: "今年" },
  ]);
  const VALID_TABS = new Set(["top", "live", "media", "user", "list"]);
  const VALID_PERIOD_UNITS = new Set(["day", "week", "month", "year"]);

  const DEFAULT_PRESETS = Object.freeze([
    {
      id: "starter-images-popular",
      name: "画像・高評価",
      filters: { media: "images", excludeRetweets: true, minFaves: 100 },
      tab: null,
      includeQuery: false,
      query: "",
    },
    {
      id: "starter-primary-ja",
      name: "一次情報・最新",
      filters: { excludeRetweets: true, excludeReplies: true, langJa: true },
      tab: "live",
      includeQuery: false,
      query: "",
    },
    {
      id: "starter-videos",
      name: "動画のみ",
      filters: { media: "videos", excludeRetweets: true },
      tab: null,
      includeQuery: false,
      query: "",
    },
  ]);

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const NON_NEG_INT_RE = /^\d+$/;

  function tr(t, key, fallback) {
    try {
      const value = typeof t === "function" ? t(key) : null;
      if (typeof value === "string" && value && value !== key) return value;
    } catch {}
    try {
      if (typeof chrome !== "undefined" && chrome?.i18n?.getMessage) {
        const msg = chrome.i18n.getMessage(key);
        if (msg) return msg;
      }
    } catch {}
    return fallback;
  }

  function isTrustedOrigin(origin) {
    if (typeof origin !== "string" || !origin.startsWith("https://")) return false;
    try {
      return ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function parseYmd(value) {
    if (typeof value !== "string" || !DATE_RE.test(value)) return null;
    const [y, m, d] = value.split("-").map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() + 1 !== m ||
      probe.getUTCDate() !== d
    ) {
      return null;
    }
    return { y, m, d };
  }

  function formatUtcYmd(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function todayYmd(now = Date.now()) {
    const date = new Date(now);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function addDaysYmd(ymd, deltaDays) {
    const parsed = parseYmd(ymd);
    if (!parsed) return null;
    const date = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + Math.trunc(deltaDays)));
    return formatUtcYmd(date);
  }

  function addMonthsYmd(ymd, deltaMonths) {
    const parsed = parseYmd(ymd);
    if (!parsed) return null;
    const targetMonthStart = new Date(Date.UTC(parsed.y, parsed.m - 1 + Math.trunc(deltaMonths), 1));
    const targetY = targetMonthStart.getUTCFullYear();
    const targetM = targetMonthStart.getUTCMonth() + 1;
    const maxDay = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate();
    const clampedD = Math.min(parsed.d, maxDay);
    return formatUtcYmd(new Date(Date.UTC(targetY, targetM - 1, clampedD)));
  }

  function getPeriodBounds(unit, anchorYmd) {
    const parsed = parseYmd(anchorYmd);
    if (!parsed) return null;
    let startYmd;
    let endYmd;
    if (unit === "day") {
      startYmd = anchorYmd;
      endYmd = anchorYmd;
    } else if (unit === "week") {
      const dow = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).getUTCDay();
      const offsetFromMonday = (dow + 6) % 7;
      startYmd = addDaysYmd(anchorYmd, -offsetFromMonday);
      endYmd = addDaysYmd(startYmd, 6);
    } else if (unit === "month") {
      const mm = String(parsed.m).padStart(2, "0");
      const lastDay = new Date(Date.UTC(parsed.y, parsed.m, 0)).getUTCDate();
      startYmd = `${parsed.y}-${mm}-01`;
      endYmd = `${parsed.y}-${mm}-${String(lastDay).padStart(2, "0")}`;
    } else if (unit === "year") {
      startYmd = `${parsed.y}-01-01`;
      endYmd = `${parsed.y}-12-31`;
    } else {
      return null;
    }
    return {
      startYmd,
      endYmd,
      sinceDate: startYmd,
      untilDate: addDaysYmd(endYmd, 1),
    };
  }

  function detectPeriodUnit(sinceDate, untilDate) {
    const s = parseYmd(sinceDate);
    const u = parseYmd(untilDate);
    if (!s || !u) return null;
    if (untilDate === addDaysYmd(sinceDate, 1)) return "day";
    const sDow = new Date(Date.UTC(s.y, s.m - 1, s.d)).getUTCDay();
    if (sDow === 1 && untilDate === addDaysYmd(sinceDate, 7)) return "week";
    if (s.d === 1 && untilDate === addMonthsYmd(sinceDate, 1)) return "month";
    if (s.m === 1 && s.d === 1 && u.y === s.y + 1 && u.m === 1 && u.d === 1) return "year";
    return null;
  }

  function isMatchingCurrentPeriod(unit, sinceDate, untilDate, now = Date.now()) {
    if (!unit || !sinceDate || !untilDate) return false;
    const current = getPeriodBounds(unit, todayYmd(now));
    return Boolean(current && current.sinceDate === sinceDate && current.untilDate === untilDate);
  }

  function shiftPeriodRange(unit, currentSince, currentUntil, delta = 0, now = Date.now()) {
    if (delta === 0) {
      return getPeriodBounds(unit, todayYmd(now));
    }
    const baseAnchor = parseYmd(currentSince)
      ? currentSince
      : parseYmd(currentUntil)
        ? addDaysYmd(currentUntil, -1)
        : todayYmd(now);
    let shiftedAnchor;
    if (unit === "day") {
      shiftedAnchor = addDaysYmd(baseAnchor, delta);
    } else if (unit === "week") {
      shiftedAnchor = addDaysYmd(baseAnchor, delta * 7);
    } else if (unit === "month") {
      shiftedAnchor = addMonthsYmd(baseAnchor, delta);
    } else if (unit === "year") {
      shiftedAnchor = addMonthsYmd(baseAnchor, delta * 12);
    } else {
      return null;
    }
    return getPeriodBounds(unit, shiftedAnchor);
  }

  function formatPeriodLabel(filters) {
    const f = normalizeFilters(filters);
    if (f.relativePeriod) {
      const meta = PERIOD_UNITS.find(u => u.value === f.relativePeriod);
      return meta ? meta.currentFallback : "";
    }
    if (!f.sinceDate && !f.untilDate) return "";
    const unit = detectPeriodUnit(f.sinceDate, f.untilDate);
    if (unit === "year") {
      return `${f.sinceDate.slice(0, 4)}年`;
    }
    if (unit === "month") {
      const p = parseYmd(f.sinceDate);
      return `${p.y}年${p.m}月`;
    }
    if (unit === "week") {
      return `${f.sinceDate.slice(5).replace("-", "/")}週`;
    }
    if (unit === "day") {
      return f.sinceDate;
    }
    const endInclusive = f.untilDate ? addDaysYmd(f.untilDate, -1) : null;
    if (f.sinceDate && endInclusive) return `${f.sinceDate}〜${endInclusive}`;
    if (f.sinceDate) return `${f.sinceDate}〜`;
    return `〜${endInclusive}`;
  }

  function formatDaysAgo(days, now = Date.now()) {
    const safeDays = Math.max(1, Math.trunc(Number(days) || 0));
    const date = new Date(now - safeDays * 86400000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function normalizePositiveInt(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const intVal = Math.trunc(num);
    return intVal > 0 ? intVal : null;
  }

  function normalizeFilters(raw = {}) {
    const media = raw?.media === "images" || raw?.media === "videos" || raw?.media === "media" ? raw.media : null;
    const rawRelativePeriod = typeof raw?.relativePeriod === "string" ? raw.relativePeriod.toLowerCase() : null;
    const relativePeriod = rawRelativePeriod && VALID_PERIOD_UNITS.has(rawRelativePeriod) ? rawRelativePeriod : null;
    const untilDate = !relativePeriod && parseYmd(raw?.untilDate) ? raw.untilDate : null;
    const rawDays = Number(raw?.sinceDays);
    const sinceDays = !relativePeriod && !untilDate && Number.isInteger(rawDays) && rawDays > 0 ? rawDays : null;
    const sinceDate = !relativePeriod && !sinceDays && parseYmd(raw?.sinceDate)
      ? raw.sinceDate
      : null;
    return {
      media,
      excludeRetweets: raw?.excludeRetweets === true,
      excludeReplies: raw?.excludeReplies === true,
      excludeLinks: raw?.excludeLinks === true,
      langJa: raw?.langJa === true,
      minFaves: normalizePositiveInt(raw?.minFaves),
      minRetweets: normalizePositiveInt(raw?.minRetweets),
      sinceDays,
      ...(relativePeriod ? { relativePeriod } : {}),
      sinceDate,
      untilDate,
    };
  }

  function resolveFilterPeriod(filters, now = Date.now()) {
    const f = normalizeFilters(filters);
    if (!f.relativePeriod) return f;
    const bounds = getPeriodBounds(f.relativePeriod, todayYmd(now));
    const { relativePeriod: _ignored, ...rest } = f;
    if (!bounds) return rest;
    return {
      ...rest,
      sinceDays: null,
      sinceDate: bounds.sinceDate,
      untilDate: bounds.untilDate,
    };
  }

  function countActiveFilters(filters) {
    const f = normalizeFilters(filters);
    let count = 0;
    if (f.media) count++;
    if (f.excludeRetweets) count++;
    if (f.excludeReplies) count++;
    if (f.excludeLinks) count++;
    if (f.langJa) count++;
    if (f.minFaves) count++;
    if (f.minRetweets) count++;
    if (f.sinceDays || f.relativePeriod || f.sinceDate || f.untilDate) count++;
    return count;
  }

  function filtersEqual(a, b) {
    const fa = normalizeFilters(a);
    const fb = normalizeFilters(b);
    return (
      fa.media === fb.media &&
      fa.excludeRetweets === fb.excludeRetweets &&
      fa.excludeReplies === fb.excludeReplies &&
      fa.excludeLinks === fb.excludeLinks &&
      fa.langJa === fb.langJa &&
      fa.minFaves === fb.minFaves &&
      fa.minRetweets === fb.minRetweets &&
      fa.sinceDays === fb.sinceDays &&
      (fa.relativePeriod ?? null) === (fb.relativePeriod ?? null) &&
      fa.sinceDate === fb.sinceDate &&
      fa.untilDate === fb.untilDate
    );
  }

  /**
   * Split an X search query into top-level tokens while preserving quoted phrases and parenthesized groups.
   */
  function tokenizeQuery(q) {
    if (typeof q !== "string" || !q.trim()) return [];
    const tokens = [];
    let current = "";
    let inQuotes = false;
    let parenDepth = 0;

    for (let i = 0; i < q.length; i++) {
      const ch = q[i];
      if (ch === '"' && q[i - 1] !== "\\") {
        inQuotes = !inQuotes;
        current += ch;
      } else if (!inQuotes && ch === "(") {
        parenDepth++;
        current += ch;
      } else if (!inQuotes && ch === ")" && parenDepth > 0) {
        parenDepth--;
        current += ch;
      } else if (!inQuotes && parenDepth === 0 && /\s/.test(ch)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  function parseSearchQuery(q, now = Date.now()) {
    const tokens = tokenizeQuery(q);
    const baseTokens = [];
    const filters = normalizeFilters();
    const recencyDates = new Map(RECENCY_DAYS.map(days => [formatDaysAgo(days, now), days]));
    let rawSinceDate = null;

    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === "-filter:retweets" || lower === "-filter:nativeretweets" || lower === "-is:retweet") {
        filters.excludeRetweets = true;
      } else if (lower === "-filter:replies" || lower === "-is:reply") {
        filters.excludeReplies = true;
      } else if (lower === "-filter:links") {
        filters.excludeLinks = true;
      } else if (lower === "filter:images") {
        filters.media = "images";
      } else if (lower === "filter:videos") {
        filters.media = "videos";
      } else if (lower === "filter:media") {
        filters.media = "media";
      } else if (lower === "lang:ja") {
        filters.langJa = true;
      } else if (lower.startsWith("min_faves:") && NON_NEG_INT_RE.test(lower.slice(10))) {
        filters.minFaves = normalizePositiveInt(lower.slice(10));
      } else if (lower.startsWith("min_retweets:") && NON_NEG_INT_RE.test(lower.slice(13))) {
        filters.minRetweets = normalizePositiveInt(lower.slice(13));
      } else if (lower.startsWith("since:") && parseYmd(lower.slice(6))) {
        rawSinceDate = lower.slice(6);
      } else if (lower.startsWith("until:") && parseYmd(lower.slice(6))) {
        filters.untilDate = lower.slice(6);
      } else {
        baseTokens.push(token);
      }
    }

    if (rawSinceDate) {
      const matchedDays = !filters.untilDate ? (recencyDates.get(rawSinceDate) ?? null) : null;
      if (matchedDays) {
        filters.sinceDays = matchedDays;
        filters.sinceDate = null;
      } else {
        filters.sinceDays = null;
        filters.sinceDate = rawSinceDate;
      }
    }

    return {
      baseText: baseTokens.join(" "),
      filters,
    };
  }

  function buildSearchQuery(baseText, filters, now = Date.now()) {
    const f = resolveFilterPeriod(filters, now);
    const parts = [];
    const trimmedBase = typeof baseText === "string" ? baseText.trim() : "";
    if (trimmedBase) parts.push(trimmedBase);
    if (f.media) parts.push(`filter:${f.media}`);
    for (const opt of BOOLEAN_OPTIONS) {
      if (f[opt.key]) parts.push(opt.token);
    }
    if (f.minFaves) parts.push(`min_faves:${f.minFaves}`);
    if (f.minRetweets) parts.push(`min_retweets:${f.minRetweets}`);
    if (f.sinceDays) {
      parts.push(`since:${formatDaysAgo(f.sinceDays, now)}`);
    } else if (f.sinceDate) {
      parts.push(`since:${f.sinceDate}`);
    }
    if (f.untilDate) {
      parts.push(`until:${f.untilDate}`);
    }
    return parts.join(" ");
  }

  function parseSearchUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
    try {
      const url = new URL(rawUrl, "https://x.com");
      if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
      const pathname = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
      if (pathname !== "/search") return null;
      const q = url.searchParams.get("q") ?? "";
      if (q === "yomikui-timeline") return null;
      const rawTab = (url.searchParams.get("f") || "top").toLowerCase();
      const tab = VALID_TABS.has(rawTab) ? rawTab : "top";
      return { q, tab };
    } catch {
      return null;
    }
  }

  function buildSearchPath(baseText, filters, tab = "top", now = Date.now()) {
    const query = buildSearchQuery(baseText, filters, now);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    const normalizedTab = typeof tab === "string" ? tab.toLowerCase() : "top";
    if (normalizedTab && normalizedTab !== "top" && VALID_TABS.has(normalizedTab)) {
      params.set("f", normalizedTab);
    }
    const qs = params.toString();
    return qs ? `/search?${qs}` : "/search";
  }

  function suggestPresetName(filters, baseText = "", includeQuery = false) {
    const f = normalizeFilters(filters);
    const labels = [];
    if (includeQuery && baseText.trim()) {
      labels.push(baseText.trim().slice(0, 16));
    }
    const mediaOpt = MEDIA_OPTIONS.find(opt => opt.value === f.media);
    if (mediaOpt) labels.push(mediaOpt.fallback);
    for (const opt of BOOLEAN_OPTIONS) {
      if (f[opt.key]) labels.push(opt.fallback);
    }
    if (f.minFaves) labels.push(`♥${f.minFaves}+`);
    if (f.minRetweets) labels.push(`RT${f.minRetweets}+`);
    if (f.sinceDays) {
      const rec = RECENCY_OPTIONS.find(r => r.days === f.sinceDays);
      labels.push(rec ? rec.fallback : `${f.sinceDays}日`);
    } else if (f.relativePeriod || f.sinceDate || f.untilDate) {
      labels.push(formatPeriodLabel(f));
    }
    return labels.length ? labels.slice(0, 3).join(" · ") : "マイプリセット";
  }

  function normalizePreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return null;
    const rawTab = typeof raw.tab === "string" ? raw.tab.toLowerCase() : null;
    const tab = rawTab && VALID_TABS.has(rawTab) ? rawTab : null;
    const includeQuery = raw.includeQuery === true;
    const query = includeQuery && typeof raw.query === "string" ? raw.query.trim() : "";
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : createId(),
      name: name.slice(0, 40),
      filters: normalizeFilters(raw.filters),
      tab,
      includeQuery,
      query,
    };
  }

  function createId() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {}
    return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function cloneDefaultPresets() {
    return DEFAULT_PRESETS.map(item => normalizePreset(item)).filter(Boolean);
  }

  const presetListeners = new Set();
  let savingPresets = Promise.resolve();

  function notifyPresetListeners(presets) {
    for (const listener of [...presetListeners]) {
      try { listener(presets); } catch {}
    }
  }

  function subscribePresets(listener) {
    if (typeof listener !== "function") return () => {};
    presetListeners.add(listener);
    return () => { presetListeners.delete(listener); };
  }

  async function readPresetsFromStorage() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
        const result = await chrome.storage.local.get(PRESETS_STORAGE_KEY);
        const stored = result?.[PRESETS_STORAGE_KEY];
        if (stored === undefined) return cloneDefaultPresets();
        if (Array.isArray(stored)) return stored.map(normalizePreset).filter(Boolean);
      }
    } catch {}
    return cloneDefaultPresets();
  }

  async function writePresetsToStorage(presets) {
    const normalized = (Array.isArray(presets) ? presets : []).map(normalizePreset).filter(Boolean);
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
        await chrome.storage.local.set({ [PRESETS_STORAGE_KEY]: normalized });
      }
    } catch {}
    notifyPresetListeners(normalized);
    return normalized;
  }

  function mutatePresets(updater) {
    savingPresets = savingPresets.then(async () => {
      const current = await readPresetsFromStorage();
      const next = await updater(current);
      return writePresetsToStorage(next);
    });
    return savingPresets;
  }

  async function loadPresets() {
    await savingPresets;
    return readPresetsFromStorage();
  }

  function savePresets(presets) {
    savingPresets = savingPresets.then(() => writePresetsToStorage(presets));
    return savingPresets;
  }

  function addPreset(input) {
    const candidate = normalizePreset(input);
    if (!candidate) return loadPresets();
    return mutatePresets(current => [candidate, ...current]);
  }

  function deletePreset(id) {
    if (!id) return loadPresets();
    return mutatePresets(current => current.filter(item => item.id !== id));
  }

  function applyPresetToUrl(currentUrl, preset, now = Date.now()) {
    const parsedUrl = parseSearchUrl(currentUrl) ?? { q: "", tab: "top" };
    const { baseText } = parseSearchQuery(parsedUrl.q, now);
    const nextBase = preset?.includeQuery ? (preset.query ?? "") : baseText;
    const nextFilters = resolveFilterPeriod(preset?.filters, now);
    const nextTab = preset?.tab || parsedUrl.tab || "top";
    return buildSearchPath(nextBase, nextFilters, nextTab, now);
  }

  // --- Frame bridge (runs inside X iframes) ---

  function getFramePath() {
    return `${window.location.pathname || "/"}${window.location.search || ""}`;
  }

  function installFrameSearchBridge(frameDoc = (typeof document !== "undefined" ? document : null), frameWin = (typeof window !== "undefined" ? window : null)) {
    if (!frameDoc || !frameWin || frameDoc.__yomikuiSearchFilterBridgeInstalled) return () => {};
    frameDoc.__yomikuiSearchFilterBridgeInstalled = true;

    let lastReportedPath = null;
    let clickTimer = null;

    const reportPath = (force = false) => {
      try {
        const path = getFramePath();
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
        const parsed = parseSearchUrl(data.path);
        if (!parsed) return;
        const nextUrl = new URL(data.path, "https://x.com");
        const nextPath = `${nextUrl.pathname}${nextUrl.search}`;
        if (!nextPath.startsWith("/search")) return;
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

    reportPath(true);
    if (frameDoc.readyState === "loading") {
      frameDoc.addEventListener?.("DOMContentLoaded", () => reportPath(true), { once: true });
    }
    frameWin.addEventListener?.("load", () => reportPath(true), { once: true });
    frameWin.addEventListener?.("message", onMessage);
    frameWin.addEventListener?.("popstate", onNavEvent);
    frameWin.addEventListener?.("hashchange", onNavEvent);
    frameWin.navigation?.addEventListener?.("currententrychange", onNavEvent);
    frameWin.navigation?.addEventListener?.("navigatesuccess", onNavEvent);
    frameDoc.addEventListener?.("click", scheduleClickCheck, true);

    return () => {
      if (clickTimer) clearTimeout(clickTimer);
      frameWin.removeEventListener?.("message", onMessage);
      frameWin.removeEventListener?.("popstate", onNavEvent);
      frameWin.removeEventListener?.("hashchange", onNavEvent);
      frameWin.navigation?.removeEventListener?.("currententrychange", onNavEvent);
      frameWin.navigation?.removeEventListener?.("navigatesuccess", onNavEvent);
      frameDoc.removeEventListener?.("click", scheduleClickCheck, true);
      delete frameDoc.__yomikuiSearchFilterBridgeInstalled;
    };
  }

  // --- Dashboard hook & UI components ---

  function resolveFallbackUrl(column) {
    if (typeof globalThis.YomikuiColumnNavigation?.getColumnUrl === "function") {
      return globalThis.YomikuiColumnNavigation.getColumnUrl(column, null);
    }
    if (column?.rememberLastPage && column?.lastPath) return column.lastPath;
    if (column?.type === "customUrl" && column?.customUrl) return column.customUrl;
    return column?.path || "/home";
  }

  function readLiveIframeUrl(column, iframeRef) {
    const frameEl = iframeRef && typeof iframeRef === "object" && "current" in iframeRef ? iframeRef.current : iframeRef;
    try {
      const href = frameEl?.contentWindow?.location?.href;
      if (typeof href === "string" && href && href !== "about:blank") {
        if (typeof globalThis.YomikuiColumnNavigation?.cleanUrl === "function") {
          return globalThis.YomikuiColumnNavigation.cleanUrl(href);
        }
        return href;
      }
    } catch {}
    return null;
  }

  function resolveOriginForFrame(iframeEl) {
    try {
      const origin = iframeEl?.contentWindow?.location?.origin;
      if (isTrustedOrigin(origin)) return origin;
    } catch {}
    if (iframeEl?.src) {
      try {
        const origin = new URL(iframeEl.src, "https://x.com").origin;
        if (isTrustedOrigin(origin)) return origin;
      } catch {}
    }
    return "*";
  }

  function useColumnSearch({ column, iframeRef, useState, useEffect, useRef }) {
    const [open, setOpen] = useState(false);
    const [livePath, setLivePath] = useState(() => resolveFallbackUrl(column));
    const [presets, setPresets] = useState([]);
    const columnIdentityRef = useRef({ id: column?.id, path: column?.path, customUrl: column?.customUrl, type: column?.type });
    const optimisticRef = useRef({ path: null, until: 0 });

    useEffect(() => {
      const prev = columnIdentityRef.current;
      if (
        prev.id !== column?.id ||
        prev.path !== column?.path ||
        prev.customUrl !== column?.customUrl ||
        prev.type !== column?.type
      ) {
        columnIdentityRef.current = { id: column?.id, path: column?.path, customUrl: column?.customUrl, type: column?.type };
        optimisticRef.current = { path: null, until: 0 };
        setLivePath(resolveFallbackUrl(column));
      }
    }, [column?.id, column?.path, column?.customUrl, column?.type]);

    useEffect(() => {
      let cancelled = false;
      loadPresets().then(items => {
        if (!cancelled) setPresets(items);
      });
      const unsubscribe = subscribePresets(items => {
        if (!cancelled) setPresets(items);
      });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }, []);

    useEffect(() => {
      if (typeof window === "undefined") return;
      const acceptPath = (candidate) => {
        if (!candidate) return;
        const opt = optimisticRef.current;
        if (opt.path && Date.now() < opt.until && candidate !== opt.path) {
          return;
        }
        if (candidate === opt.path) {
          optimisticRef.current = { path: null, until: 0 };
        }
        setLivePath(candidate);
      };
      const syncFromFrame = () => {
        const direct = readLiveIframeUrl(column, iframeRef);
        if (direct) acceptPath(direct);
      };
      const onMessage = (event) => {
        const frameWin = iframeRef?.current?.contentWindow;
        if (!frameWin || event.source !== frameWin || !isTrustedOrigin(event.origin)) return;
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "yomikui-search-location" && typeof data.path === "string" && data.path.startsWith("/")) {
          acceptPath(data.path);
        } else if (data.type === "yomikui-frame-ready") {
          syncFromFrame();
          try {
            frameWin.postMessage({ type: "yomikui-search-location-request" }, resolveOriginForFrame(iframeRef.current));
          } catch {}
        }
      };
      window.addEventListener("message", onMessage);
      syncFromFrame();
      return () => window.removeEventListener("message", onMessage);
    }, [column?.id, iframeRef]);

    const currentUrl = livePath || readLiveIframeUrl(column, iframeRef) || resolveFallbackUrl(column);
    const parsedSearch = parseSearchUrl(currentUrl);
    const isLiveFeed = column?.liveFeed === true;
    const isSearchPage = !isLiveFeed && parsedSearch !== null;
    const parsedQuery = parsedSearch ? parseSearchQuery(parsedSearch.q) : { baseText: "", filters: normalizeFilters() };
    const activeCount = countActiveFilters(parsedQuery.filters);

    useEffect(() => {
      if (!isSearchPage && open) setOpen(false);
    }, [isSearchPage, open]);

    const navigateSearch = (nextPath) => {
      if (!parseSearchUrl(nextPath)) return;
      optimisticRef.current = { path: nextPath, until: Date.now() + 600 };
      setLivePath(nextPath);
      const iframeEl = iframeRef?.current;
      if (!iframeEl) return;
      const frameWin = iframeEl.contentWindow;
      if (frameWin) {
        try {
          frameWin.postMessage({ type: "yomikui-search-navigate", path: nextPath }, resolveOriginForFrame(iframeEl));
          return;
        } catch {}
      }
      if (typeof globalThis.YomikuiTweetRouting?.withPendingPath === "function" && iframeEl.src) {
        iframeEl.src = globalThis.YomikuiTweetRouting.withPendingPath(iframeEl.src, nextPath);
      } else {
        iframeEl.src = `https://x.com${nextPath}`;
      }
    };

    const toggleOpen = () => {
      if (Date.now() >= optimisticRef.current.until) {
        const direct = readLiveIframeUrl(column, iframeRef);
        if (direct) setLivePath(direct);
      }
      setOpen(prev => !prev);
    };

    return {
      open,
      setOpen,
      toggleOpen,
      isSearchPage,
      isLiveFeed,
      currentUrl,
      tab: parsedSearch?.tab ?? "top",
      baseText: parsedQuery.baseText,
      filters: parsedQuery.filters,
      activeCount,
      presets,
      navigateSearch,
      addPreset,
      deletePreset,
    };
  }

  function FilterButton({ searchState, Button, jsx, t }) {
    if (!searchState?.isSearchPage || searchState?.isLiveFeed) return null;
    const activeCount = searchState.activeCount || 0;
    const open = Boolean(searchState.open);
    const label = tr(t, "search_filter_button", "検索フィルター");

    return jsx.jsxs(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      className: `rd-column-action-search-filters relative shrink-0 ${
        open ? "bg-accent text-accent-foreground" : activeCount > 0 ? "text-primary hover:text-primary" : ""
      }`,
      onClick: (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        searchState.toggleOpen();
      },
      title: activeCount > 0 ? `${label} (${activeCount})` : label,
      "aria-label": label,
      "aria-expanded": open,
      "aria-pressed": open,
      children: [
        jsx.jsx("svg", {
          viewBox: "0 0 24 24",
          width: 14,
          height: 14,
          fill: activeCount > 0 ? "currentColor" : "none",
          fillOpacity: activeCount > 0 ? 0.18 : 0,
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          children: jsx.jsx("polygon", { points: "22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" }),
        }),
        activeCount > 0
          ? jsx.jsx("span", {
              className: "rd-search-filter-badge pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground",
              children: activeCount,
            })
          : null,
      ],
    });
  }

  function FilterPanel({ searchState, jsx, t, useState, useEffect }) {
    const [showSaveForm, setShowSaveForm] = useState(false);
    const [presetName, setPresetName] = useState("");
    const [includeQuery, setIncludeQuery] = useState(false);
    const [includeTab, setIncludeTab] = useState(true);
    const [keywordDraft, setKeywordDraft] = useState(searchState?.baseText ?? "");
    const [customMinFaves, setCustomMinFaves] = useState(searchState?.filters?.minFaves ? String(searchState.filters.minFaves) : "");
    const [customMinRetweets, setCustomMinRetweets] = useState(searchState?.filters?.minRetweets ? String(searchState.filters.minRetweets) : "");
    const [periodOpen, setPeriodOpen] = useState(false);
    const [periodUnit, setPeriodUnit] = useState(() => detectPeriodUnit(searchState?.filters?.sinceDate, searchState?.filters?.untilDate) || "month");
    const [startDateDraft, setStartDateDraft] = useState(() => searchState?.filters?.sinceDate ?? "");
    const [endDateDraft, setEndDateDraft] = useState(() => (
      searchState?.filters?.untilDate ? (addDaysYmd(searchState.filters.untilDate, -1) ?? "") : ""
    ));
    const [saveAsRelativePeriod, setSaveAsRelativePeriod] = useState(false);

    useEffect(() => {
      setKeywordDraft(searchState?.baseText ?? "");
    }, [searchState?.baseText]);

    useEffect(() => {
      setCustomMinFaves(searchState?.filters?.minFaves ? String(searchState.filters.minFaves) : "");
    }, [searchState?.filters?.minFaves]);

    useEffect(() => {
      setCustomMinRetweets(searchState?.filters?.minRetweets ? String(searchState.filters.minRetweets) : "");
    }, [searchState?.filters?.minRetweets]);

    useEffect(() => {
      const s = searchState?.filters?.sinceDate ?? "";
      const u = searchState?.filters?.untilDate ?? "";
      setStartDateDraft(s);
      setEndDateDraft(u ? (addDaysYmd(u, -1) ?? "") : "");
      const detected = detectPeriodUnit(s || null, u || null);
      if (detected) setPeriodUnit(detected);
      setSaveAsRelativePeriod(isMatchingCurrentPeriod(detected, s || null, u || null));
    }, [searchState?.filters?.sinceDate, searchState?.filters?.untilDate]);

    useEffect(() => {
      if (!searchState?.open || typeof window === "undefined") return;
      const onKeyDown = (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault?.();
        ev.stopPropagation?.();
        if (showSaveForm) {
          setShowSaveForm(false);
        } else {
          searchState.setOpen(false);
        }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [searchState?.open, showSaveForm]);

    if (!searchState?.isSearchPage || searchState?.isLiveFeed) return null;

    const { filters, baseText, tab, activeCount, presets = [] } = searchState;
    const isOpen = Boolean(searchState.open);
    const hasCustomPeriod = Boolean(filters.sinceDate || filters.untilDate);
    const periodLabel = formatPeriodLabel(filters);
    const currentUnitMeta = PERIOD_UNITS.find(u => u.value === periodUnit) ?? PERIOD_UNITS[2];
    if (!isOpen && !hasCustomPeriod) return null;

    const activeBaseText = isOpen ? keywordDraft : baseText;
    const detectedPeriodUnit = detectPeriodUnit(filters.sinceDate, filters.untilDate);
    const detectedPeriodMeta = detectedPeriodUnit
      ? PERIOD_UNITS.find(u => u.value === detectedPeriodUnit) ?? null
      : null;
    const isCurrentPeriod = isMatchingCurrentPeriod(detectedPeriodUnit, filters.sinceDate, filters.untilDate);
    const filtersForSave = saveAsRelativePeriod && detectedPeriodUnit
      ? normalizeFilters({
          ...filters,
          sinceDays: null,
          sinceDate: null,
          untilDate: null,
          relativePeriod: detectedPeriodUnit,
        })
      : normalizeFilters(filters);

    const updateFilters = (patch, nextTab = tab, nextBase = activeBaseText) => {
      const nextFilters = normalizeFilters({ ...filters, ...patch });
      searchState.navigateSearch(buildSearchPath(nextBase, nextFilters, nextTab));
    };

    const applyPeriodBounds = (bounds) => {
      if (!bounds) return;
      setStartDateDraft(bounds.startYmd);
      setEndDateDraft(bounds.endYmd);
      updateFilters({ sinceDays: null, sinceDate: bounds.sinceDate, untilDate: bounds.untilDate });
    };

    const stepPeriod = (delta) => {
      applyPeriodBounds(shiftPeriodRange(periodUnit, filters.sinceDate, filters.untilDate, delta));
    };

    const applyCustomDateRange = () => {
      let start = parseYmd(startDateDraft) ? startDateDraft : null;
      let end = parseYmd(endDateDraft) ? endDateDraft : null;
      if (start && end && start > end) {
        [start, end] = [end, start];
        setStartDateDraft(start);
        setEndDateDraft(end);
      }
      updateFilters({
        sinceDays: null,
        sinceDate: start,
        untilDate: end ? addDaysYmd(end, 1) : null,
      });
    };

    const clearCustomDateRange = () => {
      setStartDateDraft("");
      setEndDateDraft("");
      updateFilters({ sinceDate: null, untilDate: null });
    };

    const submitKeyword = () => {
      searchState.navigateSearch(buildSearchPath(keywordDraft, filters, tab));
    };

    const commitThreshold = (field, rawValue) => {
      const trimmed = String(rawValue ?? "").trim();
      const nextVal = trimmed === "" ? null : normalizePositiveInt(trimmed);
      if (filters[field] !== nextVal) {
        updateFilters({ [field]: nextVal });
      }
    };

    const handleSavePreset = async (ev) => {
      ev?.preventDefault?.();
      const fallbackName = suggestPresetName(filtersForSave, baseText, includeQuery);
      const finalName = presetName.trim() || fallbackName;
      await searchState.addPreset({
        name: finalName,
        filters: filtersForSave,
        tab: includeTab ? tab : null,
        includeQuery: Boolean(includeQuery && baseText.trim()),
        query: includeQuery ? baseText.trim() : "",
      });
      setPresetName("");
      setShowSaveForm(false);
    };

    const chipBase = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer";
    const chipActive = "border-primary bg-primary/15 text-primary";
    const chipIdle = "border-border bg-background text-foreground hover:bg-muted/60";
    const miniBtnBase = "rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer";
    const FragmentComp = jsx.Fragment ?? "div";

    const miniBar = hasCustomPeriod
      ? jsx.jsxs("div", {
          className: "rd-search-period-minibar flex h-7 min-h-7 flex-nowrap items-center justify-between gap-1 overflow-x-auto border-b border-border bg-card/90 px-2 text-[11px] text-foreground select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          onClick: (ev) => ev?.stopPropagation?.(),
          children: [
            jsx.jsxs("div", {
              className: "flex min-w-0 shrink-0 items-center gap-0.5",
              children: [
                jsx.jsx("button", {
                  type: "button",
                  className: "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[10px] hover:bg-muted/60 cursor-pointer",
                  "aria-label": "前の期間",
                  title: "前の期間",
                  onClick: () => stepPeriod(-1),
                  children: "◀",
                }),
                jsx.jsx("button", {
                  type: "button",
                  className: "h-5 max-w-[8.5rem] truncate rounded px-1.5 font-medium text-primary hover:bg-primary/10 cursor-pointer",
                  title: "詳細・日付指定を開く",
                  onClick: () => {
                    setPeriodOpen(true);
                    searchState.setOpen(true);
                  },
                  children: periodLabel,
                }),
                jsx.jsx("button", {
                  type: "button",
                  className: "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[10px] hover:bg-muted/60 cursor-pointer",
                  "aria-label": "次の期間",
                  title: "次の期間",
                  onClick: () => stepPeriod(1),
                  children: "▶",
                }),
              ],
            }),
            jsx.jsxs("div", {
              className: "flex shrink-0 items-center gap-1",
              children: [
                jsx.jsx("div", {
                  role: "group",
                  "aria-label": tr(t, "search_filter_period_unit", "期間単位"),
                  className: "flex shrink-0 overflow-hidden rounded border border-border bg-background",
                  children: PERIOD_UNITS.map(u => jsx.jsx("button", {
                    type: "button",
                    "aria-pressed": periodUnit === u.value,
                    className: `px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors cursor-pointer ${
                      periodUnit === u.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
                    }`,
                    onClick: () => setPeriodUnit(u.value),
                    children: tr(t, u.labelKey, u.fallback),
                  }, `mini-${u.value}`)),
                }),
                jsx.jsx("button", {
                  type: "button",
                  className: "h-5 shrink-0 rounded border border-border bg-background px-1.5 text-[10px] font-medium hover:bg-muted/60 cursor-pointer",
                  onClick: () => stepPeriod(0),
                  children: tr(t, currentUnitMeta.currentKey, currentUnitMeta.currentFallback),
                }),
                jsx.jsx("button", {
                  type: "button",
                  className: "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground cursor-pointer",
                  "aria-label": "期間を解除",
                  title: "期間を解除",
                  onClick: clearCustomDateRange,
                  children: "×",
                }),
              ],
            }),
          ],
        })
      : null;

    if (!isOpen) {
      return miniBar;
    }

    const popover = jsx.jsxs(FragmentComp, {
      children: [
        jsx.jsx("div", {
          className: "rd-search-filter-backdrop fixed inset-0 z-[900]",
          "aria-hidden": true,
          onClick: () => searchState.setOpen(false),
        }),
        jsx.jsx("div", {
          className: "relative z-[1000] h-0 overflow-visible",
          children: jsx.jsxs("div", {
            className: "rd-search-filter-panel absolute left-1.5 right-1.5 top-1 flex max-h-[min(32rem,calc(100vh-7rem))] flex-col gap-2 overflow-y-auto overscroll-y-contain rounded-xl border border-border bg-popover px-2.5 py-2 text-xs text-foreground shadow-xl select-none",
            onClick: (ev) => ev?.stopPropagation?.(),
            children: [
        // 1. Presets header + list
        jsx.jsxs("div", {
          className: "flex flex-col gap-1.5",
          children: [
            jsx.jsxs("div", {
              className: "flex items-center justify-between gap-2",
              children: [
                jsx.jsx("span", {
                  className: "text-[11px] font-semibold text-muted-foreground",
                  children: tr(t, "search_filter_presets", "プリセット"),
                }),
                jsx.jsxs("div", {
                  className: "flex items-center gap-1",
                  children: [
                    activeCount > 0
                      ? jsx.jsx("button", {
                          type: "button",
                          className: `${miniBtnBase} text-muted-foreground hover:bg-muted/60 hover:text-foreground`,
                          onClick: () => searchState.navigateSearch(buildSearchPath(keywordDraft, normalizeFilters(), tab)),
                          children: tr(t, "search_filter_clear", "解除"),
                        })
                      : null,
                    jsx.jsx("button", {
                      type: "button",
                      className: `${miniBtnBase} border border-border bg-background text-foreground hover:bg-muted/60`,
                      onClick: () => {
                        setShowSaveForm(v => !v);
                        setIncludeQuery(false);
                        setIncludeTab(tab !== "top");
                        setSaveAsRelativePeriod(isCurrentPeriod);
                      },
                      children: showSaveForm ? tr(t, "common_cancel", "キャンセル") : `+ ${tr(t, "search_filter_save_preset", "保存")}`,
                    }),
                    jsx.jsx("button", {
                      type: "button",
                      className: `${miniBtnBase} text-muted-foreground hover:bg-muted/60 hover:text-foreground`,
                      "aria-label": tr(t, "common_close", "閉じる"),
                      title: tr(t, "common_close", "閉じる"),
                      onClick: () => searchState.setOpen(false),
                      children: "×",
                    }),
                  ],
                }),
              ],
            }),
            presets.length > 0
              ? jsx.jsx("div", {
                  className: "flex flex-wrap items-center gap-1",
                  children: presets.map(preset => {
                    const isMatched =
                      filtersEqual(resolveFilterPeriod(preset.filters), filters) &&
                      (!preset.tab || preset.tab === tab) &&
                      (!preset.includeQuery || (preset.query ?? "") === baseText);
                    const relativeLabel = preset.filters?.relativePeriod ? formatPeriodLabel(preset.filters) : "";
                    const presetTitle = [
                      preset.name,
                      preset.includeQuery && preset.query ? `(${preset.query})` : "",
                      relativeLabel ? `[実行時の${relativeLabel}]` : "",
                    ].filter(Boolean).join(" ");
                    return jsx.jsxs("div", {
                      className: `rd-search-preset-chip group inline-flex items-center rounded-md border text-[11px] font-medium transition-colors ${
                        isMatched ? chipActive : chipIdle
                      }`,
                      children: [
                        jsx.jsx("button", {
                          type: "button",
                          className: "px-2 py-0.5 text-left cursor-pointer",
                          title: presetTitle,
                          onClick: () => searchState.navigateSearch(applyPresetToUrl(searchState.currentUrl, preset)),
                          children: preset.name,
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          className: "pr-1.5 pl-0.5 py-0.5 text-muted-foreground opacity-70 hover:text-destructive hover:opacity-100 cursor-pointer",
                          "aria-label": `${preset.name} を削除`,
                          title: "削除",
                          onClick: (ev) => {
                            ev?.stopPropagation?.();
                            searchState.deletePreset(preset.id);
                          },
                          children: "×",
                        }),
                      ],
                    }, preset.id);
                  }),
                })
              : jsx.jsx("span", {
                  className: "text-[11px] text-muted-foreground",
                  children: tr(t, "search_filter_no_presets", "保存済みのプリセットはありません"),
                }),
            showSaveForm
              ? jsx.jsxs("form", {
                  className: "flex flex-col gap-1.5 rounded-lg border border-border bg-background/80 p-2",
                  onSubmit: handleSavePreset,
                  children: [
                    jsx.jsxs("div", {
                      className: "flex items-center gap-1.5",
                      children: [
                        jsx.jsx("input", {
                          type: "text",
                          value: presetName,
                          placeholder: suggestPresetName(filtersForSave, baseText, includeQuery),
                          className: "h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary",
                          onChange: (ev) => setPresetName(ev.currentTarget.value),
                          onKeyDown: (ev) => {
                            if (ev.key === "Escape") {
                              ev.stopPropagation();
                              setShowSaveForm(false);
                            }
                          },
                        }),
                        jsx.jsx("button", {
                          type: "submit",
                          className: "h-7 shrink-0 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 cursor-pointer",
                          children: tr(t, "common_save", "保存"),
                        }),
                      ],
                    }),
                    jsx.jsxs("div", {
                      className: "flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground",
                      children: [
                        baseText.trim()
                          ? jsx.jsxs("label", {
                              className: "inline-flex items-center gap-1 cursor-pointer",
                              children: [
                                jsx.jsx("input", {
                                  type: "checkbox",
                                  checked: includeQuery,
                                  onChange: (ev) => setIncludeQuery(ev.currentTarget.checked),
                                }),
                                jsx.jsx("span", { children: "キーワードも含める" }),
                              ],
                            })
                          : null,
                        jsx.jsxs("label", {
                          className: "inline-flex items-center gap-1 cursor-pointer",
                          children: [
                            jsx.jsx("input", {
                              type: "checkbox",
                              checked: includeTab,
                              onChange: (ev) => setIncludeTab(ev.currentTarget.checked),
                            }),
                            jsx.jsx("span", { children: `タブ (${TAB_OPTIONS.find(x => x.value === tab)?.fallback ?? tab}) も含める` }),
                          ],
                        }),
                        detectedPeriodMeta
                          ? jsx.jsxs("label", {
                              className: "inline-flex items-center gap-1 cursor-pointer",
                              children: [
                                jsx.jsx("input", {
                                  type: "checkbox",
                                  checked: saveAsRelativePeriod,
                                  onChange: (ev) => setSaveAsRelativePeriod(ev.currentTarget.checked),
                                }),
                                jsx.jsx("span", {
                                  children: `相対期間として保存 (実行時の${tr(t, detectedPeriodMeta.currentKey, detectedPeriodMeta.currentFallback)})`,
                                }),
                              ],
                            })
                          : null,
                      ],
                    }),
                  ],
                })
              : null,
          ],
        }),

        // 2. Keyword + Tab selector
        jsx.jsxs("div", {
          className: "flex flex-wrap items-center gap-1.5",
          children: [
            jsx.jsxs("div", {
              className: "flex min-w-[8rem] flex-1 items-center gap-1",
              children: [
                jsx.jsx("input", {
                  type: "text",
                  value: keywordDraft,
                  placeholder: tr(t, "search_filter_keyword_placeholder", "キーワード (Enterで検索)"),
                  "aria-label": tr(t, "search_filter_keyword_label", "検索キーワード"),
                  className: "h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary",
                  onChange: (ev) => setKeywordDraft(ev.currentTarget.value),
                  onKeyDown: (ev) => {
                    if (ev.key === "Enter") {
                      ev.preventDefault();
                      ev.stopPropagation();
                      submitKeyword();
                    }
                  },
                }),
                keywordDraft !== baseText
                  ? jsx.jsx("button", {
                      type: "button",
                      className: "h-7 shrink-0 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:opacity-90 cursor-pointer",
                      onClick: submitKeyword,
                      children: tr(t, "search_filter_apply", "検索"),
                    })
                  : null,
              ],
            }),
            jsx.jsx("div", {
              role: "group",
              "aria-label": tr(t, "search_filter_tab_group", "検索タブ"),
              className: "flex shrink-0 overflow-hidden rounded-md border border-border bg-background",
              children: TAB_OPTIONS.map(opt => jsx.jsx("button", {
                type: "button",
                "aria-pressed": tab === opt.value,
                className: `px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  tab === opt.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
                }`,
                onClick: () => {
                  if (tab !== opt.value) updateFilters({}, opt.value);
                },
                children: tr(t, opt.labelKey, opt.fallback),
              }, opt.value)),
            }),
          ],
        }),

        // 3. Quick filter chips (media, exclusions, language, recency)
        jsx.jsxs("div", {
          className: "flex flex-wrap items-center gap-1",
          children: [
            ...MEDIA_OPTIONS.map(opt => {
              const pressed = filters.media === opt.value;
              return jsx.jsx("button", {
                type: "button",
                "aria-pressed": pressed,
                className: `${chipBase} ${pressed ? chipActive : chipIdle}`,
                onClick: () => updateFilters({ media: pressed ? null : opt.value }),
                children: tr(t, opt.labelKey, opt.fallback),
              }, opt.value);
            }),
            ...BOOLEAN_OPTIONS.map(opt => {
              const pressed = Boolean(filters[opt.key]);
              return jsx.jsx("button", {
                type: "button",
                "aria-pressed": pressed,
                className: `${chipBase} ${pressed ? chipActive : chipIdle}`,
                onClick: () => updateFilters({ [opt.key]: !pressed }),
                children: tr(t, opt.labelKey, opt.fallback),
              }, opt.key);
            }),
            ...RECENCY_OPTIONS.map(opt => {
              const pressed = filters.sinceDays === opt.days;
              return jsx.jsx("button", {
                type: "button",
                "aria-pressed": pressed,
                className: `${chipBase} ${pressed ? chipActive : chipIdle}`,
                onClick: () => updateFilters({ sinceDays: pressed ? null : opt.days, sinceDate: null, untilDate: null }),
                children: tr(t, opt.labelKey, opt.fallback),
              }, `since-${opt.days}`);
            }),
            jsx.jsx("button", {
              type: "button",
              "aria-expanded": periodOpen,
              "aria-pressed": periodOpen || hasCustomPeriod,
              className: `${chipBase} ${hasCustomPeriod ? chipActive : periodOpen ? "border-border bg-accent text-accent-foreground" : chipIdle}`,
              onClick: () => setPeriodOpen(v => !v),
              children: hasCustomPeriod
                ? `📅 ${periodLabel}`
                : tr(t, "search_filter_period_range", "📅 期間指定"),
            }, "period-toggle"),
          ],
        }),

        // 3.5 Expandable period range & unit stepper
        periodOpen
          ? jsx.jsxs("div", {
              className: "rd-search-period-box flex flex-col gap-1.5 rounded-lg border border-border bg-background/80 p-2",
              children: [
                jsx.jsxs("div", {
                  className: "flex flex-wrap items-center justify-between gap-1.5",
                  children: [
                    jsx.jsx("div", {
                      role: "group",
                      "aria-label": tr(t, "search_filter_period_unit", "期間単位"),
                      className: "flex shrink-0 overflow-hidden rounded-md border border-border bg-background",
                      children: PERIOD_UNITS.map(u => jsx.jsx("button", {
                        type: "button",
                        "aria-pressed": periodUnit === u.value,
                        className: `px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                          periodUnit === u.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
                        }`,
                        onClick: () => setPeriodUnit(u.value),
                        children: tr(t, u.labelKey, u.fallback),
                      }, u.value)),
                    }),
                    jsx.jsxs("div", {
                      className: "flex shrink-0 items-center gap-1",
                      children: [
                        jsx.jsx("button", {
                          type: "button",
                          className: `${chipBase} ${chipIdle}`,
                          "aria-label": "前の期間",
                          onClick: () => stepPeriod(-1),
                          children: "◀ 前",
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          className: `${chipBase} ${chipIdle}`,
                          onClick: () => stepPeriod(0),
                          children: tr(t, currentUnitMeta.currentKey, currentUnitMeta.currentFallback),
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          className: `${chipBase} ${chipIdle}`,
                          "aria-label": "次の期間",
                          onClick: () => stepPeriod(1),
                          children: "次 ▶",
                        }),
                      ],
                    }),
                  ],
                }),
                jsx.jsxs("div", {
                  className: "flex flex-wrap items-center gap-1",
                  children: [
                    jsx.jsx("input", {
                      type: "date",
                      value: startDateDraft,
                      "aria-label": "開始日",
                      className: "h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary",
                      onChange: (ev) => setStartDateDraft(ev.currentTarget.value),
                    }),
                    jsx.jsx("span", {
                      className: "text-[11px] text-muted-foreground",
                      children: "〜",
                    }),
                    jsx.jsx("input", {
                      type: "date",
                      value: endDateDraft,
                      "aria-label": "終了日",
                      className: "h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary",
                      onChange: (ev) => setEndDateDraft(ev.currentTarget.value),
                    }),
                    jsx.jsx("button", {
                      type: "button",
                      className: "h-6 shrink-0 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:opacity-90 cursor-pointer",
                      onClick: applyCustomDateRange,
                      children: tr(t, "search_filter_period_apply", "適用"),
                    }),
                    hasCustomPeriod || startDateDraft || endDateDraft
                      ? jsx.jsx("button", {
                          type: "button",
                          className: `${miniBtnBase} text-muted-foreground hover:bg-muted/60 hover:text-foreground`,
                          onClick: clearCustomDateRange,
                          children: tr(t, "search_filter_clear", "解除"),
                        })
                      : null,
                  ],
                }),
                filters.sinceDate || filters.untilDate
                  ? jsx.jsx("div", {
                      className: "text-[10px] text-muted-foreground tabular-nums",
                      children: [
                        filters.sinceDate ? `since:${filters.sinceDate}` : null,
                        filters.untilDate ? `until:${filters.untilDate}` : null,
                      ].filter(Boolean).join(" "),
                    })
                  : null,
              ],
            })
          : null,

        // 4. Engagement thresholds (min_faves & min_retweets)
        jsx.jsxs("div", {
          className: "flex flex-col gap-1 pt-0.5",
          children: [
            jsx.jsxs("div", {
              className: "flex flex-wrap items-center gap-1",
              children: [
                jsx.jsx("span", {
                  className: "w-11 shrink-0 text-[11px] text-muted-foreground",
                  children: "♥ いいね",
                }),
                ...FAVES_PRESETS.map(num => {
                  const pressed = filters.minFaves === num;
                  return jsx.jsx("button", {
                    type: "button",
                    "aria-pressed": pressed,
                    className: `${chipBase} ${pressed ? chipActive : chipIdle}`,
                    onClick: () => updateFilters({ minFaves: pressed ? null : num }),
                    children: `${num}+`,
                  }, `fav-${num}`);
                }),
                jsx.jsx("input", {
                  type: "number",
                  min: 1,
                  placeholder: "任意",
                  value: customMinFaves,
                  "aria-label": "最小いいね数",
                  className: "h-6 w-14 rounded-md border border-border bg-background px-1.5 text-[11px] tabular-nums text-foreground outline-none focus:border-primary",
                  onChange: (ev) => setCustomMinFaves(ev.currentTarget.value),
                  onBlur: (ev) => commitThreshold("minFaves", ev.currentTarget.value),
                  onKeyDown: (ev) => {
                    if (ev.key === "Enter") {
                      ev.preventDefault();
                      ev.stopPropagation();
                      commitThreshold("minFaves", ev.currentTarget.value);
                    }
                  },
                }),
              ],
            }),
            jsx.jsxs("div", {
              className: "flex flex-wrap items-center gap-1",
              children: [
                jsx.jsx("span", {
                  className: "w-11 shrink-0 text-[11px] text-muted-foreground",
                  children: "🔁 RT",
                }),
                ...RETWEETS_PRESETS.map(num => {
                  const pressed = filters.minRetweets === num;
                  return jsx.jsx("button", {
                    type: "button",
                    "aria-pressed": pressed,
                    className: `${chipBase} ${pressed ? chipActive : chipIdle}`,
                    onClick: () => updateFilters({ minRetweets: pressed ? null : num }),
                    children: `${num}+`,
                  }, `rt-${num}`);
                }),
                jsx.jsx("input", {
                  type: "number",
                  min: 1,
                  placeholder: "任意",
                  value: customMinRetweets,
                  "aria-label": "最小リポスト数",
                  className: "h-6 w-14 rounded-md border border-border bg-background px-1.5 text-[11px] tabular-nums text-foreground outline-none focus:border-primary",
                  onChange: (ev) => setCustomMinRetweets(ev.currentTarget.value),
                  onBlur: (ev) => commitThreshold("minRetweets", ev.currentTarget.value),
                  onKeyDown: (ev) => {
                    if (ev.key === "Enter") {
                      ev.preventDefault();
                      ev.stopPropagation();
                      commitThreshold("minRetweets", ev.currentTarget.value);
                    }
                  },
                }),
              ],
            }),
          ],
        }),
      ],
          }),
        }),
      ],
    });

    return jsx.jsxs(FragmentComp, {
      children: [miniBar, popover],
    });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const isTopDeck = window.parent === window || (window.location?.pathname?.startsWith?.("/yomikui") ?? false);
    if (!isTopDeck) {
      installFrameSearchBridge(document, window);
    }
  }

  globalThis.YomikuiSearchFilters = Object.freeze({
    PRESETS_STORAGE_KEY,
    DEFAULT_PRESETS,
    MEDIA_OPTIONS,
    BOOLEAN_OPTIONS,
    RECENCY_OPTIONS,
    PERIOD_UNITS,
    TAB_OPTIONS,
    FAVES_PRESETS,
    RETWEETS_PRESETS,
    parseYmd,
    todayYmd,
    addDaysYmd,
    addMonthsYmd,
    getPeriodBounds,
    detectPeriodUnit,
    isMatchingCurrentPeriod,
    shiftPeriodRange,
    formatPeriodLabel,
    formatDaysAgo,
    normalizeFilters,
    resolveFilterPeriod,
    countActiveFilters,
    filtersEqual,
    tokenizeQuery,
    parseSearchQuery,
    buildSearchQuery,
    parseSearchUrl,
    buildSearchPath,
    suggestPresetName,
    normalizePreset,
    loadPresets,
    savePresets,
    addPreset,
    deletePreset,
    applyPresetToUrl,
    subscribePresets,
    installFrameSearchBridge,
    useColumnSearch,
    FilterButton,
    FilterPanel,
  });
})();
