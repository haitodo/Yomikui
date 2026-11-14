"use strict";

// Shared by the dashboard and native X frames.
// Provides quick search-operator filter chips and reusable filter presets for /search columns.
(() => {
  if (globalThis.YomikuiSearchFilters) return;

  const PRESETS_STORAGE_KEY = "yomikui_search_filter_presets_v1";
  const LOCAL_BACKUP_KEY = "yk_search_presets_backup_v1";
  const SYNC_META_KEY = "yk_sp_sync_meta_v1";
  const SYNC_CHUNK_PREFIX = "yk_sp_sync_c_";
  const SYNC_CHUNK_CHAR_LIMIT = 1800;
  const SYNC_MAX_CHUNKS = 32;
  const COL_STATE_STORAGE_KEY = "yk_col_preset_state_v1";
  const STYLE_MARKER = "/* yomikui-search-filters-v2 */";
  const VALID_PERIOD_MODES = new Set(["none", "relative", "cursor", "fixed"]);
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
  const SEARCH_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2}):(\d{2}):(\d{2})_(utc|jst)$/i;
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
    const y = String(date.getUTCFullYear()).padStart(4, "0");
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function formatLocalYmd(date) {
    const y = String(date.getFullYear()).padStart(4, "0");
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function formatSearchDateBoundary(ymd) {
    const parsed = parseYmd(ymd);
    if (!parsed) return null;
    // X treats bare since:/until: YYYY-MM-DD as 00:00:00 UTC, so convert local midnight to UTC
    // to keep date boundaries aligned with the user's calendar dates.
    const localMidnight = new Date(0);
    localMidnight.setFullYear(parsed.y, parsed.m - 1, parsed.d);
    localMidnight.setHours(0, 0, 0, 0);
    if (Number.isNaN(localMidnight.getTime())) return null;
    const uy = String(localMidnight.getUTCFullYear()).padStart(4, "0");
    const um = String(localMidnight.getUTCMonth() + 1).padStart(2, "0");
    const ud = String(localMidnight.getUTCDate()).padStart(2, "0");
    const hh = String(localMidnight.getUTCHours()).padStart(2, "0");
    const mm = String(localMidnight.getUTCMinutes()).padStart(2, "0");
    const ss = String(localMidnight.getUTCSeconds()).padStart(2, "0");
    if (hh === "00" && mm === "00" && ss === "00") {
      return `${uy}-${um}-${ud}`;
    }
    return `${uy}-${um}-${ud}_${hh}:${mm}:${ss}_UTC`;
  }

  function parseSearchDateToken(value) {
    if (typeof value !== "string") return null;
    if (parseYmd(value)) {
      return { ymd: value, isDateOnly: true };
    }
    const match = value.match(SEARCH_DATETIME_RE);
    if (!match) return null;
    const parsed = parseYmd(match[1]);
    if (!parsed) return null;
    const hh = Number(match[2]);
    const mm = Number(match[3]);
    const ss = Number(match[4]);
    if (hh > 23 || mm > 59 || ss > 59) return null;
    const tz = match[5].toLowerCase();
    const utcMs = Date.UTC(parsed.y, parsed.m - 1, parsed.d, hh, mm, ss) - (tz === "jst" ? 9 * 3600000 : 0);
    const local = new Date(utcMs);
    if (
      Number.isNaN(local.getTime()) ||
      local.getHours() !== 0 ||
      local.getMinutes() !== 0 ||
      local.getSeconds() !== 0
    ) {
      return null;
    }
    return { ymd: formatLocalYmd(local), isDateOnly: false };
  }

  function todayYmd(now = Date.now()) {
    return formatLocalYmd(new Date(now));
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
    return formatLocalYmd(new Date(now - safeDays * 86400000));
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
    let rawSince = null;

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
      } else if (lower.startsWith("since:")) {
        const parsedSince = parseSearchDateToken(lower.slice(6));
        if (parsedSince) {
          rawSince = parsedSince;
        } else {
          baseTokens.push(token);
        }
      } else if (lower.startsWith("until:")) {
        const parsedUntil = parseSearchDateToken(lower.slice(6));
        if (parsedUntil) {
          filters.untilDate = parsedUntil.ymd;
        } else {
          baseTokens.push(token);
        }
      } else {
        baseTokens.push(token);
      }
    }

    if (rawSince) {
      const matchedDays = rawSince.isDateOnly && !filters.untilDate
        ? (recencyDates.get(rawSince.ymd) ?? null)
        : null;
      if (matchedDays) {
        filters.sinceDays = matchedDays;
        filters.sinceDate = null;
      } else {
        filters.sinceDays = null;
        filters.sinceDate = rawSince.ymd;
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
      parts.push(`since:${formatSearchDateBoundary(f.sinceDate)}`);
    }
    if (f.untilDate) {
      parts.push(`until:${formatSearchDateBoundary(f.untilDate)}`);
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

  function normalizeTags(rawTags) {
    const items = Array.isArray(rawTags)
      ? rawTags
      : typeof rawTags === "string"
        ? rawTags.split(/[\s,、]+/)
        : [];
    const seen = new Set();
    const out = [];
    for (const item of items) {
      if (typeof item !== "string") continue;
      const cleaned = item.replace(/^#+/, "").trim().slice(0, 24);
      if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
      seen.add(cleaned.toLowerCase());
      out.push(cleaned);
      if (out.length >= 10) break;
    }
    return out;
  }

  function normalizeTimestamp(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
  }

  function normalizeNonNegInt(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
  }

  function normalizePreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return null;
    const rawTab = typeof raw.tab === "string" ? raw.tab.toLowerCase() : null;
    const tab = rawTab && VALID_TABS.has(rawTab) ? rawTab : null;
    const includeQuery = raw.includeQuery === true;
    const query = includeQuery && typeof raw.query === "string" ? raw.query.trim() : "";
    const filters = normalizeFilters(raw.filters);
    const pinned = raw.pinned === true;
    const tags = normalizeTags(raw.tags);

    const rawMode = typeof raw.periodMode === "string" ? raw.periodMode.toLowerCase() : null;
    let periodMode = rawMode && VALID_PERIOD_MODES.has(rawMode) ? rawMode : null;
    if (!periodMode) {
      if (filters.relativePeriod) periodMode = "relative";
      else if (filters.sinceDate || filters.untilDate) periodMode = "fixed";
      else periodMode = "none";
    }

    const rawCursorSince = parseYmd(raw.cursorSince) ? raw.cursorSince : (periodMode === "cursor" && filters.sinceDate ? filters.sinceDate : null);
    const rawCursorUntil = parseYmd(raw.cursorUntil) ? raw.cursorUntil : (periodMode === "cursor" && filters.untilDate ? filters.untilDate : null);
    const rawUnit = typeof raw.cursorUnit === "string" ? raw.cursorUnit.toLowerCase() : null;
    const detectedCursorUnit = detectPeriodUnit(rawCursorSince, rawCursorUntil);
    const cursorUnit = rawUnit && VALID_PERIOD_UNITS.has(rawUnit)
      ? rawUnit
      : (detectedCursorUnit || filters.relativePeriod || "month");

    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : createId(),
      name: name.slice(0, 60),
      filters,
      tab,
      includeQuery,
      query,
      pinned,
      tags,
      periodMode,
      cursorUnit,
      cursorSince: periodMode === "cursor" ? rawCursorSince : null,
      cursorUntil: periodMode === "cursor" ? rawCursorUntil : null,
      autoAdvanceOnApply: raw.autoAdvanceOnApply === true,
      lastCheckedAt: normalizeTimestamp(raw.lastCheckedAt),
      lastUsedAt: normalizeTimestamp(raw.lastUsedAt),
      useCount: normalizeNonNegInt(raw.useCount),
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

  function isSameLocalDay(tsA, tsB = Date.now()) {
    const a = normalizeTimestamp(tsA);
    const b = normalizeTimestamp(tsB);
    if (!a || !b) return false;
    return formatLocalYmd(new Date(a)) === formatLocalYmd(new Date(b));
  }

  function getEffectivePresetFilters(preset, now = Date.now(), options = {}) {
    const baseFilters = normalizeFilters(preset?.filters);
    if (options?.mode === "today") {
      const bounds = getPeriodBounds("day", todayYmd(now));
      const { relativePeriod: _ignored, ...rest } = baseFilters;
      return normalizeFilters({
        ...rest,
        sinceDays: null,
        sinceDate: bounds.sinceDate,
        untilDate: bounds.untilDate,
      });
    }
    if (preset?.periodMode === "cursor") {
      const unit = VALID_PERIOD_UNITS.has(preset.cursorUnit) ? preset.cursorUnit : "month";
      let sinceDate = preset.cursorSince;
      let untilDate = preset.cursorUntil;
      if (!sinceDate && !untilDate) {
        const bounds = getPeriodBounds(unit, todayYmd(now));
        sinceDate = bounds?.sinceDate ?? null;
        untilDate = bounds?.untilDate ?? null;
      }
      const { relativePeriod: _ignored, ...rest } = baseFilters;
      return normalizeFilters({
        ...rest,
        sinceDays: null,
        sinceDate,
        untilDate,
      });
    }
    return resolveFilterPeriod(baseFilters, now);
  }

  function formatPresetCursorLabel(preset) {
    if (!preset || preset.periodMode !== "cursor") return "";
    if (preset.cursorSince || preset.cursorUntil) {
      return formatPeriodLabel({ sinceDate: preset.cursorSince, untilDate: preset.cursorUntil });
    }
    const meta = PERIOD_UNITS.find(u => u.value === preset.cursorUnit);
    return meta ? `${meta.fallback}単位` : "未設定";
  }

  function formatPresetPeriodBadge(preset) {
    if (!preset) return "";
    if (preset.periodMode === "cursor") {
      const label = formatPresetCursorLabel(preset);
      return label ? `進捗: ${label}` : "進捗記録";
    }
    if (preset.periodMode === "relative" && preset.filters?.relativePeriod) {
      return `相対: ${formatPeriodLabel(preset.filters)}`;
    }
    if (preset.filters?.sinceDate || preset.filters?.untilDate) {
      return `固定: ${formatPeriodLabel(preset.filters)}`;
    }
    if (preset.filters?.sinceDays) {
      const rec = RECENCY_OPTIONS.find(r => r.days === preset.filters.sinceDays);
      return rec ? rec.fallback : `${preset.filters.sinceDays}日`;
    }
    return "";
  }

  function formatPresetSummary(preset) {
    if (!preset) return "";
    const parts = [];
    const f = normalizeFilters(preset.filters);
    const mediaOpt = MEDIA_OPTIONS.find(opt => opt.value === f.media);
    if (mediaOpt) parts.push(mediaOpt.fallback);
    for (const opt of BOOLEAN_OPTIONS) {
      if (f[opt.key]) parts.push(opt.fallback);
    }
    if (f.minFaves) parts.push(`♥${f.minFaves}+`);
    if (f.minRetweets) parts.push(`RT${f.minRetweets}+`);
    if (preset.tab) {
      const tabOpt = TAB_OPTIONS.find(opt => opt.value === preset.tab);
      if (tabOpt) parts.push(tabOpt.fallback);
    }
    return parts.join(" · ");
  }

  function stepPresetCursor(preset, delta = -1, now = Date.now()) {
    if (!preset) return null;
    const unit = VALID_PERIOD_UNITS.has(preset.cursorUnit) ? preset.cursorUnit : "month";
    const bounds = shiftPeriodRange(unit, preset.cursorSince, preset.cursorUntil, delta, now);
    if (!bounds) return null;
    return {
      ...preset,
      periodMode: "cursor",
      cursorUnit: unit,
      cursorSince: bounds.sinceDate,
      cursorUntil: bounds.untilDate,
      lastCheckedAt: now,
    };
  }

  function matchPresetSearch(preset, rawQuery) {
    const needle = typeof rawQuery === "string" ? rawQuery.trim().toLowerCase() : "";
    if (!needle) return true;
    const terms = needle.split(/\s+/).filter(Boolean);
    const haystack = [
      preset.name,
      preset.includeQuery ? preset.query : "",
      ...(preset.tags || []).map(tag => `#${tag} ${tag}`),
      formatPresetSummary(preset),
      formatPresetPeriodBadge(preset),
    ].join(" ").toLowerCase();
    return terms.every(term => haystack.includes(term));
  }

  function parseQueryDraft(rawText, now = Date.now()) {
    const trimmed = typeof rawText === "string" ? rawText.trim() : "";
    if (!trimmed) {
      return { baseText: "", filters: normalizeFilters(), tab: null };
    }
    const maybeUrl = parseSearchUrl(trimmed);
    if (maybeUrl) {
      const parsed = parseSearchQuery(maybeUrl.q, now);
      return { baseText: parsed.baseText, filters: parsed.filters, tab: maybeUrl.tab };
    }
    const parsed = parseSearchQuery(trimmed, now);
    return { baseText: parsed.baseText, filters: parsed.filters, tab: null };
  }

  function exportPresetsPayload(presets) {
    const normalized = (Array.isArray(presets) ? presets : []).map(normalizePreset).filter(Boolean);
    return {
      format: "yomikui-search-presets",
      version: 2,
      exportedAt: new Date().toISOString(),
      presets: normalized,
    };
  }

  function importPresetsPayload(rawInput) {
    let parsed = rawInput;
    if (typeof rawInput === "string") {
      parsed = JSON.parse(rawInput);
    }
    let list = null;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.presets)) {
      list = parsed.presets;
    }
    if (!list) throw new Error("Invalid search presets payload");
    return list.map(normalizePreset).filter(Boolean);
  }

  const presetListeners = new Set();
  let savingPresets = Promise.resolve();
  let mirrorBackend = null;

  function registerMirrorBackend(backend) {
    if (backend && typeof backend.read === "function" && typeof backend.write === "function") {
      mirrorBackend = backend;
    } else {
      mirrorBackend = null;
    }
  }

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

  async function writeLocalBackup(normalized, now = Date.now()) {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
        await chrome.storage.local.set({
          [LOCAL_BACKUP_KEY]: {
            version: 2,
            initialized: true,
            updatedAt: now,
            presets: normalized,
          },
        });
      }
    } catch {}
  }

  async function readLocalBackup() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
        const res = await chrome.storage.local.get(LOCAL_BACKUP_KEY);
        const backup = res?.[LOCAL_BACKUP_KEY];
        if (backup && typeof backup === "object" && backup.initialized === true && Array.isArray(backup.presets)) {
          return backup.presets.map(normalizePreset).filter(Boolean);
        }
      }
    } catch {}
    return null;
  }

  async function writeSyncMirror(normalized, now = Date.now()) {
    try {
      const syncApi = typeof chrome !== "undefined" ? chrome?.storage?.sync : null;
      if (!syncApi?.get || !syncApi?.set) return;
      const json = JSON.stringify(normalized);
      const chunks = [];
      for (let i = 0; i < json.length; i += SYNC_CHUNK_CHAR_LIMIT) {
        chunks.push(json.slice(i, i + SYNC_CHUNK_CHAR_LIMIT));
      }
      if (chunks.length > SYNC_MAX_CHUNKS) return;

      let prevChunks = 0;
      try {
        const metaRes = await syncApi.get(SYNC_META_KEY);
        prevChunks = Number(metaRes?.[SYNC_META_KEY]?.chunks) || 0;
      } catch {}

      const payload = {
        [SYNC_META_KEY]: {
          v: 2,
          initialized: true,
          count: normalized.length,
          chunks: chunks.length,
          updatedAt: now,
        },
      };
      for (let i = 0; i < chunks.length; i++) {
        payload[`${SYNC_CHUNK_PREFIX}${i}`] = chunks[i];
      }
      await syncApi.set(payload);

      if (prevChunks > chunks.length && syncApi.remove) {
        const staleKeys = [];
        for (let i = chunks.length; i < prevChunks; i++) {
          staleKeys.push(`${SYNC_CHUNK_PREFIX}${i}`);
        }
        if (staleKeys.length > 0) {
          await syncApi.remove(staleKeys);
        }
      }
    } catch {}
  }

  async function readSyncMirror() {
    try {
      const syncApi = typeof chrome !== "undefined" ? chrome?.storage?.sync : null;
      if (!syncApi?.get) return null;
      const metaRes = await syncApi.get(SYNC_META_KEY);
      const meta = metaRes?.[SYNC_META_KEY];
      if (!meta || meta.initialized !== true) return null;
      const chunkCount = Number(meta.chunks) || 0;
      if (chunkCount === 0) return [];
      if (chunkCount < 0 || chunkCount > SYNC_MAX_CHUNKS) return null;
      const keys = [];
      for (let i = 0; i < chunkCount; i++) keys.push(`${SYNC_CHUNK_PREFIX}${i}`);
      const chunkRes = await syncApi.get(keys);
      let joined = "";
      for (const k of keys) {
        if (typeof chunkRes?.[k] !== "string") return null;
        joined += chunkRes[k];
      }
      const parsed = JSON.parse(joined);
      if (!Array.isArray(parsed)) return null;
      return parsed.map(normalizePreset).filter(Boolean);
    } catch {
      return null;
    }
  }

  async function readMirrorBackend() {
    try {
      if (!mirrorBackend) return null;
      const raw = await mirrorBackend.read();
      if (Array.isArray(raw)) return raw.map(normalizePreset).filter(Boolean);
      if (raw && typeof raw === "object" && raw.initialized === true && Array.isArray(raw.presets)) {
        return raw.presets.map(normalizePreset).filter(Boolean);
      }
    } catch {}
    return null;
  }

  async function writeMirrorBackend(normalized) {
    try {
      if (mirrorBackend) {
        await mirrorBackend.write(normalized);
      }
    } catch {}
  }

  async function readPresetsFromStorage() {
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
        const result = await chrome.storage.local.get(PRESETS_STORAGE_KEY);
        const stored = result?.[PRESETS_STORAGE_KEY];
        if (Array.isArray(stored)) {
          const normalized = stored.map(normalizePreset).filter(Boolean);
          const existingBackup = await readLocalBackup();
          if (existingBackup === null) {
            await writeLocalBackup(normalized);
            await writeSyncMirror(normalized);
            await writeMirrorBackend(normalized);
          }
          return normalized;
        }
      }
    } catch {}

    const localBackup = await readLocalBackup();
    if (localBackup !== null) {
      try {
        if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
          await chrome.storage.local.set({ [PRESETS_STORAGE_KEY]: localBackup });
        }
      } catch {}
      return localBackup;
    }

    const syncRecovered = await readSyncMirror();
    if (syncRecovered !== null) {
      try {
        if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
          await chrome.storage.local.set({ [PRESETS_STORAGE_KEY]: syncRecovered });
        }
      } catch {}
      await writeLocalBackup(syncRecovered);
      return syncRecovered;
    }

    const mirrorRecovered = await readMirrorBackend();
    if (mirrorRecovered !== null) {
      try {
        if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
          await chrome.storage.local.set({ [PRESETS_STORAGE_KEY]: mirrorRecovered });
        }
      } catch {}
      await writeLocalBackup(mirrorRecovered);
      await writeSyncMirror(mirrorRecovered);
      return mirrorRecovered;
    }

    return cloneDefaultPresets();
  }

  async function writePresetsToStorage(presets) {
    const normalized = (Array.isArray(presets) ? presets : []).map(normalizePreset).filter(Boolean);
    const now = Date.now();
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.set) {
        await chrome.storage.local.set({ [PRESETS_STORAGE_KEY]: normalized });
      }
    } catch {}
    await writeLocalBackup(normalized, now);
    await writeSyncMirror(normalized, now);
    await writeMirrorBackend(normalized);
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

  function updatePreset(id, patchOrUpdater) {
    if (!id) return loadPresets();
    return mutatePresets(current => current.map(item => {
      if (item.id !== id) return item;
      const updated = typeof patchOrUpdater === "function"
        ? patchOrUpdater(item)
        : { ...item, ...patchOrUpdater, id: item.id };
      return normalizePreset(updated) || item;
    }));
  }

  function togglePresetPin(id) {
    return updatePreset(id, item => ({ ...item, pinned: !item.pinned }));
  }

  function advancePresetCursor(id, sinceDate, untilDate, unit, now = Date.now()) {
    if (!id) return loadPresets();
    return updatePreset(id, item => {
      if (item.periodMode !== "cursor") return item;
      const nextUnit = unit && VALID_PERIOD_UNITS.has(unit) ? unit : item.cursorUnit;
      return {
        ...item,
        cursorUnit: nextUnit,
        cursorSince: parseYmd(sinceDate) ? sinceDate : item.cursorSince,
        cursorUntil: parseYmd(untilDate) ? untilDate : item.cursorUntil,
        lastCheckedAt: now,
      };
    });
  }

  function touchPresetUsage(id, now = Date.now(), extraPatch = null) {
    if (!id) return loadPresets();
    return updatePreset(id, item => ({
      ...item,
      ...(extraPatch && typeof extraPatch === "object" ? extraPatch : {}),
      lastUsedAt: now,
      useCount: (item.useCount || 0) + 1,
    }));
  }

  function deletePreset(id) {
    if (!id) return loadPresets();
    return mutatePresets(current => current.filter(item => item.id !== id));
  }

  function importPresets(rawInput, mode = "merge") {
    const imported = importPresetsPayload(rawInput);
    if (mode === "replace") {
      return savePresets(imported);
    }
    return mutatePresets(current => {
      const byId = new Map(current.map(p => [p.id, p]));
      const merged = [...current];
      for (const item of imported) {
        if (byId.has(item.id)) {
          const idx = merged.findIndex(x => x.id === item.id);
          if (idx >= 0) merged[idx] = item;
        } else {
          merged.push(item);
        }
      }
      return merged;
    });
  }

  async function exportBackupData() {
    const presets = await loadPresets();
    return exportPresetsPayload(presets);
  }

  async function importBackupData(rawData) {
    if (rawData === undefined || rawData === null) return loadPresets();
    const imported = importPresetsPayload(rawData);
    return savePresets(imported);
  }

  function applyPresetToUrl(currentUrl, preset, now = Date.now(), options = {}) {
    const parsedUrl = parseSearchUrl(currentUrl) ?? { q: "", tab: "top" };
    const { baseText } = parseSearchQuery(parsedUrl.q, now);
    const nextBase = preset?.includeQuery ? (preset.query ?? "") : baseText;
    const nextFilters = getEffectivePresetFilters(preset, now, options);
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

  const SEARCH_FILTER_CSS = `
    #yomikui-root .yk-sf-list {
      max-height: min(17rem, 42vh);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    #yomikui-root .yk-sf-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid transparent;
      transition: background-color .12s ease, border-color .12s ease;
    }
    #yomikui-root .yk-sf-row:hover,
    #yomikui-root .yk-sf-row[data-focused="true"] {
      background: color-mix(in oklab, var(--muted) 70%, transparent);
      border-color: var(--border);
    }
    #yomikui-root .yk-sf-row[data-active="true"] {
      background: color-mix(in oklab, var(--primary) 12%, transparent);
      border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
    }
    #yomikui-root .yk-sf-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      border-radius: 9999px;
      font-size: 10px;
      line-height: 1.3;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--background);
      color: var(--muted-foreground);
      white-space: nowrap;
    }
    #yomikui-root .yk-sf-badge[data-tone="cursor"] {
      color: var(--primary);
      border-color: color-mix(in oklab, var(--primary) 45%, var(--border));
      background: color-mix(in oklab, var(--primary) 10%, transparent);
    }
    #yomikui-root .yk-sf-badge[data-tone="done"] {
      color: oklch(0.72 0.16 155);
      border-color: oklch(0.72 0.16 155 / 0.4);
      background: oklch(0.72 0.16 155 / 0.12);
    }
    #yomikui-root .yk-sf-badge[data-tone="preview"] {
      color: oklch(0.78 0.15 80);
      border-color: oklch(0.78 0.15 80 / 0.45);
      background: oklch(0.78 0.15 80 / 0.12);
    }
  `;

  function installStyles() {
    if (typeof document === "undefined") return false;
    const style = document.getElementById("yomikui-styles");
    if (!style) return false;
    if (!style.textContent.includes(STYLE_MARKER)) {
      style.appendChild(document.createTextNode(`\n${STYLE_MARKER}\n${SEARCH_FILTER_CSS}`));
    }
    return true;
  }

  async function readColumnPresetState(columnId) {
    if (!columnId) return null;
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
        const res = await chrome.storage.local.get(COL_STATE_STORAGE_KEY);
        const map = res?.[COL_STATE_STORAGE_KEY];
        if (map && typeof map === "object" && map[columnId] && typeof map[columnId] === "object") {
          return {
            activePresetId: typeof map[columnId].activePresetId === "string" ? map[columnId].activePresetId : null,
            isTempToday: map[columnId].isTempToday === true,
          };
        }
      }
    } catch {}
    return null;
  }

  async function writeColumnPresetState(columnId, state) {
    if (!columnId) return;
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local?.get && chrome?.storage?.local?.set) {
        const res = await chrome.storage.local.get(COL_STATE_STORAGE_KEY);
        const prev = res?.[COL_STATE_STORAGE_KEY];
        const map = prev && typeof prev === "object" ? { ...prev } : {};
        if (!state || !state.activePresetId) {
          delete map[columnId];
        } else {
          map[columnId] = {
            activePresetId: state.activePresetId,
            isTempToday: state.isTempToday === true,
          };
        }
        await chrome.storage.local.set({ [COL_STATE_STORAGE_KEY]: map });
      }
    } catch {}
  }

  function useColumnSearch({ column, iframeRef, useState, useEffect, useRef }) {
    const [panelMode, setPanelMode] = useState(null);
    const [livePath, setLivePath] = useState(() => resolveFallbackUrl(column));
    const [presets, setPresets] = useState([]);
    const [activePresetId, setActivePresetId] = useState(null);
    const [isTempToday, setIsTempToday] = useState(false);
    const columnIdentityRef = useRef({ id: column?.id, path: column?.path, customUrl: column?.customUrl, type: column?.type });
    const optimisticRef = useRef({ path: null, until: 0 });
    const open = panelMode !== null;

    const setOpen = (next) => {
      setPanelMode(prev => {
        const prevBool = prev !== null;
        const nextBool = typeof next === "function" ? next(prevBool) : Boolean(next);
        return nextBool ? (prev || "filters") : null;
      });
    };

    const toggleMode = (mode = "filters") => {
      if (Date.now() >= optimisticRef.current.until) {
        const direct = readLiveIframeUrl(column, iframeRef);
        if (direct) setLivePath(direct);
      }
      setPanelMode(prev => (prev === mode ? null : mode));
    };

    useEffect(() => {
      installStyles();
    }, []);

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
        setActivePresetId(null);
        setIsTempToday(false);
      }
    }, [column?.id, column?.path, column?.customUrl, column?.type]);

    useEffect(() => {
      let cancelled = false;
      readColumnPresetState(column?.id).then(savedState => {
        if (cancelled || !savedState) return;
        setActivePresetId(savedState.activePresetId);
        setIsTempToday(savedState.isTempToday);
      });
      return () => { cancelled = true; };
    }, [column?.id]);

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
      if (!isSearchPage && panelMode !== null) setPanelMode(null);
    }, [isSearchPage, panelMode]);

    const activePreset = (() => {
      if (!activePresetId) return null;
      const found = presets.find(p => p.id === activePresetId) || null;
      if (!found) return null;
      if (found.includeQuery && found.query && parsedQuery.baseText.trim() !== found.query.trim()) {
        return null;
      }
      return found;
    })();

    const setColumnPresetBinding = (presetId, tempToday = false) => {
      setActivePresetId(presetId);
      setIsTempToday(tempToday);
      writeColumnPresetState(column?.id, presetId ? { activePresetId: presetId, isTempToday: tempToday } : null);
    };

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

    const applyPreset = async (preset, options = {}) => {
      if (!preset) return;
      const now = Date.now();
      let targetPreset = preset;
      const mode = options.mode === "today" ? "today" : "default";

      if (mode === "default" && preset.periodMode === "cursor" && (options.advance || preset.autoAdvanceOnApply)) {
        const stepped = stepPresetCursor(preset, options.delta ?? -1, now);
        if (stepped) {
          targetPreset = stepped;
          await touchPresetUsage(preset.id, now, {
            cursorUnit: stepped.cursorUnit,
            cursorSince: stepped.cursorSince,
            cursorUntil: stepped.cursorUntil,
            lastCheckedAt: now,
          });
        } else {
          await touchPresetUsage(preset.id, now);
        }
      } else if (mode === "default" && preset.periodMode === "cursor" && !preset.cursorSince && !preset.cursorUntil) {
        const bounds = getPeriodBounds(preset.cursorUnit || "month", todayYmd(now));
        if (bounds) {
          targetPreset = { ...preset, cursorSince: bounds.sinceDate, cursorUntil: bounds.untilDate };
          await touchPresetUsage(preset.id, now, {
            cursorSince: bounds.sinceDate,
            cursorUntil: bounds.untilDate,
          });
        } else {
          await touchPresetUsage(preset.id, now);
        }
      } else {
        await touchPresetUsage(preset.id, now);
      }

      setColumnPresetBinding(preset.id, mode === "today" && preset.periodMode === "cursor");
      const nextPath = applyPresetToUrl(currentUrl, targetPreset, now, { mode });
      navigateSearch(nextPath);
      if (options.closePanel !== false) {
        setPanelMode(null);
      }
    };

    const stepPresetAndApply = async (preset, delta = -1) => {
      return applyPreset(preset, { advance: true, delta });
    };

    const returnToPresetCursor = () => {
      if (!activePreset || activePreset.periodMode !== "cursor") return;
      setColumnPresetBinding(activePreset.id, false);
      const nextPath = applyPresetToUrl(currentUrl, activePreset, Date.now());
      navigateSearch(nextPath);
    };

    const enterTempTodayPreview = () => {
      if (!activePreset || activePreset.periodMode !== "cursor") return;
      setColumnPresetBinding(activePreset.id, true);
      const nextPath = applyPresetToUrl(currentUrl, activePreset, Date.now(), { mode: "today" });
      navigateSearch(nextPath);
    };

    const clearActivePreset = () => {
      setColumnPresetBinding(null, false);
    };

    const toggleOpen = () => toggleMode("filters");

    return {
      open,
      panelMode,
      setPanelMode,
      setOpen,
      toggleOpen,
      toggleMode,
      isSearchPage,
      isLiveFeed,
      currentUrl,
      tab: parsedSearch?.tab ?? "top",
      baseText: parsedQuery.baseText,
      filters: parsedQuery.filters,
      activeCount,
      presets,
      activePresetId,
      activePreset,
      isTempToday,
      navigateSearch,
      applyPreset,
      stepPresetAndApply,
      returnToPresetCursor,
      enterTempTodayPreview,
      clearActivePreset,
      setColumnPresetBinding,
      addPreset,
      updatePreset,
      togglePresetPin,
      advancePresetCursor,
      importPresets,
      deletePreset,
    };
  }

  function PresetButton({ searchState, Button, jsx, t }) {
    if (!searchState?.isSearchPage || searchState?.isLiveFeed) return null;
    const isPresetOpen = searchState.panelMode === "presets";
    const activePreset = searchState.activePreset || null;
    const label = tr(t, "search_preset_button", "検索プリセット");
    const tooltip = activePreset
      ? `${label}: ${activePreset.name}${activePreset.periodMode === "cursor" ? ` (${formatPresetPeriodBadge(activePreset)})` : ""}`
      : label;

    return jsx.jsxs(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      className: `rd-column-action-search-presets relative shrink-0 ${
        isPresetOpen ? "bg-accent text-accent-foreground" : activePreset ? "text-primary hover:text-primary" : ""
      }`,
      onClick: (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        searchState.toggleMode?.("presets");
      },
      title: tooltip,
      "aria-label": label,
      "aria-expanded": isPresetOpen,
      "aria-pressed": isPresetOpen,
      children: [
        jsx.jsx("svg", {
          viewBox: "0 0 24 24",
          width: 14,
          height: 14,
          fill: activePreset ? "currentColor" : "none",
          fillOpacity: activePreset ? 0.18 : 0,
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          children: jsx.jsx("path", { d: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" }),
        }),
        activePreset?.periodMode === "cursor"
          ? jsx.jsx("span", {
              className: "pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary",
              "aria-hidden": true,
            })
          : null,
      ],
    });
  }

  function FilterButton({ searchState, Button, jsx, t }) {
    if (!searchState?.isSearchPage || searchState?.isLiveFeed) return null;
    const activeCount = searchState.activeCount || 0;
    const isFilterOpen = searchState.panelMode ? searchState.panelMode === "filters" : Boolean(searchState.open);
    const label = tr(t, "search_filter_button", "検索フィルター");

    return jsx.jsxs(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      className: `rd-column-action-search-filters relative shrink-0 ${
        isFilterOpen ? "bg-accent text-accent-foreground" : activeCount > 0 ? "text-primary hover:text-primary" : ""
      }`,
      onClick: (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        if (typeof searchState.toggleMode === "function") {
          searchState.toggleMode("filters");
        } else {
          searchState.toggleOpen();
        }
      },
      title: activeCount > 0 ? `${label} (${activeCount})` : label,
      "aria-label": label,
      "aria-expanded": isFilterOpen,
      "aria-pressed": isFilterOpen,
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

  function FilterPanel({ searchState, jsx, t, useState, useEffect, useRef }) {
    // Hooks 0..11 MUST keep exact order for existing test compatibility.
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

    // Hooks 12+ for v2 preset switcher, tags, search, cursor editor, and backup UI.
    const [presetSearch, setPresetSearch] = useState("");
    const [selectedTag, setSelectedTag] = useState("all");
    const [focusedIdx, setFocusedIdx] = useState(0);
    const [saveAsCursorPeriod, setSaveAsCursorPeriod] = useState(false);
    const [editingPresetId, setEditingPresetId] = useState(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editorDraft, setEditorDraft] = useState(null);
    const [pasteQueryInput, setPasteQueryInput] = useState("");
    const [backupOpen, setBackupOpen] = useState(false);
    const [importText, setImportText] = useState("");
    const [backupStatus, setBackupStatus] = useState("");
    const searchInputRef = typeof useRef === "function" ? useRef(null) : { current: null };
    const fileInputRef = typeof useRef === "function" ? useRef(null) : { current: null };

    useEffect(() => {
      installStyles();
    }, []);

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
      if (searchState?.panelMode === "presets") {
        setFocusedIdx(0);
        setTimeout?.(() => {
          searchInputRef.current?.focus?.();
        }, 0);
      } else {
        setEditorOpen(false);
        setEditingPresetId(null);
        setBackupOpen(false);
        setBackupStatus("");
      }
    }, [searchState?.panelMode]);

    useEffect(() => {
      if (!searchState?.open || typeof window === "undefined") return;
      const onKeyDown = (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault?.();
        ev.stopPropagation?.();
        if (editorOpen) {
          setEditorOpen(false);
          setEditingPresetId(null);
        } else if (backupOpen) {
          setBackupOpen(false);
        } else if (showSaveForm) {
          setShowSaveForm(false);
        } else {
          searchState.setOpen(false);
        }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [searchState?.open, showSaveForm, editorOpen, backupOpen]);

    if (!searchState?.isSearchPage || searchState?.isLiveFeed) return null;

    const { filters, baseText, tab, activeCount, presets = [] } = searchState;
    const isOpen = Boolean(searchState.open);
    const panelMode = searchState.panelMode === "presets" ? "presets" : "filters";
    const activePreset = searchState.activePreset || null;
    const isTempToday = Boolean(searchState.isTempToday);
    const hasCustomPeriod = Boolean(filters.sinceDate || filters.untilDate);
    const periodLabel = formatPeriodLabel(filters);
    const effectiveUnit = (activePreset?.periodMode === "cursor" && !isTempToday ? activePreset.cursorUnit : null) || periodUnit;
    const currentUnitMeta = PERIOD_UNITS.find(u => u.value === effectiveUnit) ?? PERIOD_UNITS[2];
    if (!isOpen && !hasCustomPeriod && !activePreset) return null;

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
      if (activePreset?.periodMode === "cursor" && !isTempToday && typeof searchState.advancePresetCursor === "function") {
        searchState.advancePresetCursor(activePreset.id, bounds.sinceDate, bounds.untilDate, effectiveUnit);
      }
      updateFilters({ sinceDays: null, sinceDate: bounds.sinceDate, untilDate: bounds.untilDate });
    };

    const stepPeriod = (delta) => {
      if (delta === 0 && activePreset?.periodMode === "cursor" && typeof searchState.enterTempTodayPreview === "function") {
        searchState.enterTempTodayPreview();
        return;
      }
      applyPeriodBounds(shiftPeriodRange(effectiveUnit, filters.sinceDate, filters.untilDate, delta));
    };

    const applyCustomDateRange = () => {
      let start = parseYmd(startDateDraft) ? startDateDraft : null;
      let end = parseYmd(endDateDraft) ? endDateDraft : null;
      if (start && end && start > end) {
        [start, end] = [end, start];
        setStartDateDraft(start);
        setEndDateDraft(end);
      }
      const nextSince = start;
      const nextUntil = end ? addDaysYmd(end, 1) : null;
      if (activePreset?.periodMode === "cursor" && !isTempToday && typeof searchState.advancePresetCursor === "function") {
        searchState.advancePresetCursor(activePreset.id, nextSince, nextUntil, detectPeriodUnit(nextSince, nextUntil) || effectiveUnit);
      }
      updateFilters({
        sinceDays: null,
        sinceDate: nextSince,
        untilDate: nextUntil,
      });
    };

    const clearCustomDateRange = () => {
      setStartDateDraft("");
      setEndDateDraft("");
      if (activePreset && typeof searchState.clearActivePreset === "function") {
        searchState.clearActivePreset();
      }
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

    const triggerApplyPreset = (preset, options = {}) => {
      if (typeof searchState.applyPreset === "function") {
        searchState.applyPreset(preset, options);
      } else {
        searchState.navigateSearch(applyPresetToUrl(searchState.currentUrl, preset, Date.now(), options));
      }
    };

    const handleSavePreset = async (ev) => {
      ev?.preventDefault?.();
      const fallbackName = suggestPresetName(filtersForSave, baseText, includeQuery);
      const finalName = presetName.trim() || fallbackName;
      const useCursor = saveAsCursorPeriod && !saveAsRelativePeriod;
      const unitForCursor = detectedPeriodUnit || periodUnit || "month";
      const cursorBounds = useCursor
        ? (filters.sinceDate || filters.untilDate
            ? { sinceDate: filters.sinceDate, untilDate: filters.untilDate }
            : getPeriodBounds(unitForCursor, todayYmd()))
        : null;
      await searchState.addPreset({
        name: finalName,
        filters: useCursor
          ? normalizeFilters({ ...filters, sinceDays: null, sinceDate: null, untilDate: null, relativePeriod: null })
          : filtersForSave,
        tab: includeTab ? tab : null,
        includeQuery: Boolean(includeQuery && baseText.trim()),
        query: includeQuery ? baseText.trim() : "",
        periodMode: saveAsRelativePeriod && detectedPeriodUnit
          ? "relative"
          : useCursor
            ? "cursor"
            : (filtersForSave.sinceDate || filtersForSave.untilDate ? "fixed" : "none"),
        cursorUnit: unitForCursor,
        cursorSince: cursorBounds?.sinceDate ?? null,
        cursorUntil: cursorBounds?.untilDate ?? null,
      });
      setPresetName("");
      setShowSaveForm(false);
      setSaveAsCursorPeriod(false);
    };

    // Preset Editor helpers
    const buildDraftFromCurrent = () => {
      const hasQuery = Boolean(baseText.trim());
      const curMode = filters.relativePeriod
        ? "relative"
        : (filters.sinceDate || filters.untilDate)
          ? "cursor"
          : "none";
      const curUnit = detectedPeriodUnit || periodUnit || "month";
      const defaultBounds = getPeriodBounds(curUnit, todayYmd());
      return {
        name: "",
        tagsText: "",
        pinned: true,
        includeQuery: hasQuery,
        query: baseText.trim(),
        tab: tab || "live",
        filters: normalizeFilters(filters),
        periodMode: curMode,
        cursorUnit: curUnit,
        cursorSince: filters.sinceDate || defaultBounds?.sinceDate || "",
        cursorEndInclusive: filters.untilDate
          ? (addDaysYmd(filters.untilDate, -1) ?? "")
          : (defaultBounds?.endYmd ?? ""),
        autoAdvanceOnApply: false,
      };
    };

    const buildDraftFromPreset = (preset) => {
      const f = normalizeFilters(preset.filters);
      const since = preset.periodMode === "cursor" ? (preset.cursorSince || "") : (f.sinceDate || "");
      const until = preset.periodMode === "cursor" ? (preset.cursorUntil || "") : (f.untilDate || "");
      return {
        name: preset.name,
        tagsText: (preset.tags || []).join(", "),
        pinned: Boolean(preset.pinned),
        includeQuery: Boolean(preset.includeQuery),
        query: preset.query || "",
        tab: preset.tab || "",
        filters: f,
        periodMode: preset.periodMode || "none",
        cursorUnit: preset.cursorUnit || "month",
        cursorSince: since,
        cursorEndInclusive: until ? (addDaysYmd(until, -1) ?? "") : "",
        autoAdvanceOnApply: Boolean(preset.autoAdvanceOnApply),
      };
    };

    const openNewEditor = () => {
      setEditingPresetId(null);
      setEditorDraft(buildDraftFromCurrent());
      setPasteQueryInput("");
      setEditorOpen(true);
    };

    const openEditEditor = (preset) => {
      setEditingPresetId(preset.id);
      setEditorDraft(buildDraftFromPreset(preset));
      setPasteQueryInput("");
      setEditorOpen(true);
    };

    const applyPastedQueryToDraft = (rawText) => {
      const parsed = parseQueryDraft(rawText);
      const detected = detectPeriodUnit(parsed.filters.sinceDate, parsed.filters.untilDate);
      setEditorDraft(prev => {
        const cur = prev || buildDraftFromCurrent();
        const hasPeriod = Boolean(parsed.filters.sinceDate || parsed.filters.untilDate);
        return {
          ...cur,
          includeQuery: Boolean(parsed.baseText) || cur.includeQuery,
          query: parsed.baseText || cur.query,
          tab: parsed.tab || cur.tab,
          filters: parsed.filters,
          periodMode: hasPeriod ? (cur.periodMode === "none" ? "cursor" : cur.periodMode) : cur.periodMode,
          cursorUnit: detected || cur.cursorUnit,
          cursorSince: parsed.filters.sinceDate || cur.cursorSince,
          cursorEndInclusive: parsed.filters.untilDate
            ? (addDaysYmd(parsed.filters.untilDate, -1) ?? "")
            : cur.cursorEndInclusive,
        };
      });
    };

    const submitEditor = async (ev) => {
      ev?.preventDefault?.();
      if (!editorDraft) return;
      const mode = editorDraft.periodMode || "none";
      const unit = VALID_PERIOD_UNITS.has(editorDraft.cursorUnit) ? editorDraft.cursorUnit : "month";
      const start = parseYmd(editorDraft.cursorSince) ? editorDraft.cursorSince : null;
      const endInc = parseYmd(editorDraft.cursorEndInclusive) ? editorDraft.cursorEndInclusive : null;
      const untilExc = endInc ? addDaysYmd(endInc, 1) : null;

      let nextFilters = normalizeFilters(editorDraft.filters);
      if (mode === "relative") {
        nextFilters = normalizeFilters({
          ...nextFilters,
          sinceDays: null,
          sinceDate: null,
          untilDate: null,
          relativePeriod: unit,
        });
      } else if (mode === "fixed") {
        nextFilters = normalizeFilters({
          ...nextFilters,
          sinceDays: null,
          relativePeriod: null,
          sinceDate: start,
          untilDate: untilExc,
        });
      } else {
        nextFilters = normalizeFilters({
          ...nextFilters,
          sinceDays: null,
          relativePeriod: null,
          sinceDate: null,
          untilDate: null,
        });
      }

      const cursorBounds = mode === "cursor" && !start && !untilExc
        ? getPeriodBounds(unit, todayYmd())
        : null;
      const finalCursorSince = mode === "cursor" ? (start || cursorBounds?.sinceDate || null) : null;
      const finalCursorUntil = mode === "cursor" ? (untilExc || cursorBounds?.untilDate || null) : null;

      const payload = {
        name: editorDraft.name.trim() || suggestPresetName(nextFilters, editorDraft.query, editorDraft.includeQuery),
        tags: normalizeTags(editorDraft.tagsText),
        pinned: Boolean(editorDraft.pinned),
        includeQuery: Boolean(editorDraft.includeQuery && editorDraft.query.trim()),
        query: editorDraft.includeQuery ? editorDraft.query.trim() : "",
        tab: editorDraft.tab && VALID_TABS.has(editorDraft.tab) ? editorDraft.tab : null,
        filters: nextFilters,
        periodMode: mode,
        cursorUnit: unit,
        cursorSince: finalCursorSince,
        cursorUntil: finalCursorUntil,
        autoAdvanceOnApply: mode === "cursor" && Boolean(editorDraft.autoAdvanceOnApply),
      };

      if (editingPresetId && typeof searchState.updatePreset === "function") {
        await searchState.updatePreset(editingPresetId, payload);
      } else {
        await searchState.addPreset(payload);
      }
      setEditorOpen(false);
      setEditingPresetId(null);
      setEditorDraft(null);
    };

    // Organized / filtered presets for Switcher & FilterPanel
    const allTags = (() => {
      const seen = new Set();
      const out = [];
      for (const p of presets) {
        for (const tag of p.tags || []) {
          if (!seen.has(tag)) {
            seen.add(tag);
            out.push(tag);
          }
        }
      }
      return out;
    })();

    const sortedPresets = [...presets].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      const luDiff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
      if (luDiff !== 0) return luDiff;
      return 0;
    });

    const filteredPresets = sortedPresets.filter(p => {
      if (selectedTag === "pinned" && !p.pinned) return false;
      if (selectedTag !== "all" && selectedTag !== "pinned" && !(p.tags || []).includes(selectedTag)) return false;
      return matchPresetSearch(p, presetSearch);
    });

    const chipBase = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer";
    const chipActive = "border-primary bg-primary/15 text-primary";
    const chipIdle = "border-border bg-background text-foreground hover:bg-muted/60";
    const miniBtnBase = "rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer";
    const FragmentComp = jsx.Fragment ?? "div";

    const miniBar = hasCustomPeriod || activePreset
      ? jsx.jsxs("div", {
          className: "rd-search-period-minibar flex h-7 min-h-7 flex-nowrap items-center justify-between gap-1 overflow-x-auto border-b border-border bg-card/90 px-2 text-[11px] text-foreground select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          onClick: (ev) => ev?.stopPropagation?.(),
          children: [
            jsx.jsxs("div", {
              className: "flex min-w-0 shrink-0 items-center gap-1",
              children: [
                typeof searchState.toggleMode === "function"
                  ? jsx.jsx("button", {
                      type: "button",
                      className: `h-5 max-w-[7.5rem] truncate rounded border px-1.5 text-[10px] font-medium transition-colors cursor-pointer ${
                        activePreset
                          ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`,
                      title: activePreset ? `${activePreset.name} — プリセット切替` : "プリセットを選択",
                      onClick: () => searchState.toggleMode("presets"),
                      children: activePreset ? `${activePreset.pinned ? "📌 " : ""}${activePreset.name} ▾` : "プリセット ▾",
                    })
                  : null,
                hasCustomPeriod
                  ? jsx.jsxs("div", {
                      className: "flex shrink-0 items-center gap-0.5",
                      children: [
                        jsx.jsx("button", {
                          type: "button",
                          className: "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[10px] hover:bg-muted/60 cursor-pointer",
                          "aria-label": "前の期間",
                          title: activePreset?.periodMode === "cursor" && !isTempToday
                            ? "前の期間へ（進捗を自動保存）"
                            : "前の期間",
                          onClick: () => stepPeriod(-1),
                          children: "◀",
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          className: "h-5 max-w-[8.5rem] truncate rounded px-1.5 font-medium text-primary hover:bg-primary/10 cursor-pointer",
                          title: "詳細・日付指定を開く",
                          onClick: () => {
                            setPeriodOpen(true);
                            if (typeof searchState.setPanelMode === "function") {
                              searchState.setPanelMode("filters");
                            } else {
                              searchState.setOpen(true);
                            }
                          },
                          children: isTempToday ? `今日 (${periodLabel})` : periodLabel,
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          className: "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[10px] hover:bg-muted/60 cursor-pointer",
                          "aria-label": "次の期間",
                          title: activePreset?.periodMode === "cursor" && !isTempToday
                            ? "次の期間へ（進捗を自動保存）"
                            : "次の期間",
                          onClick: () => stepPeriod(1),
                          children: "▶",
                        }),
                      ],
                    })
                  : null,
              ],
            }),
            jsx.jsxs("div", {
              className: "flex shrink-0 items-center gap-1",
              children: [
                isTempToday && activePreset?.periodMode === "cursor"
                  ? jsx.jsx("button", {
                      type: "button",
                      className: "h-5 shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium text-primary hover:bg-primary/20 cursor-pointer",
                      title: `進捗 (${formatPresetCursorLabel(activePreset)}) に戻る`,
                      onClick: () => searchState.returnToPresetCursor?.(),
                      children: "↩ 続き",
                    })
                  : null,
                jsx.jsx("div", {
                  role: "group",
                  "aria-label": tr(t, "search_filter_period_unit", "期間単位"),
                  className: "flex shrink-0 overflow-hidden rounded border border-border bg-background",
                  children: PERIOD_UNITS.map(u => jsx.jsx("button", {
                    type: "button",
                    "aria-pressed": effectiveUnit === u.value,
                    className: `px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors cursor-pointer ${
                      effectiveUnit === u.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
                    }`,
                    onClick: () => {
                      setPeriodUnit(u.value);
                      if (activePreset?.periodMode === "cursor" && !isTempToday && typeof searchState.updatePreset === "function") {
                        searchState.updatePreset(activePreset.id, { cursorUnit: u.value });
                      }
                    },
                    children: tr(t, u.labelKey, u.fallback),
                  }, `mini-${u.value}`)),
                }),
                jsx.jsx("button", {
                  type: "button",
                  className: "h-5 shrink-0 rounded border border-border bg-background px-1.5 text-[10px] font-medium hover:bg-muted/60 cursor-pointer",
                  title: activePreset?.periodMode === "cursor"
                    ? "進捗を壊さず今日を一時表示"
                    : undefined,
                  onClick: () => stepPeriod(0),
                  children: activePreset?.periodMode === "cursor"
                    ? "今日"
                    : tr(t, currentUnitMeta.currentKey, currentUnitMeta.currentFallback),
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

    const handleDownloadJson = () => {
      try {
        if (typeof document === "undefined" || typeof Blob === "undefined") return;
        const payload = exportPresetsPayload(presets);
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `yomikui-search-presets-${todayYmd()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setBackupStatus("JSONを書き出しました");
      } catch {
        setBackupStatus("書き出しに失敗しました");
      }
    };

    const handleImportSubmit = async (mode) => {
      try {
        if (!importText.trim()) return;
        const next = await searchState.importPresets(importText, mode);
        setImportText("");
        setBackupStatus(`${next.length}件のプリセットを読み込みました`);
      } catch {
        setBackupStatus("JSON形式が正しくありません");
      }
    };

    const presetsSwitcherContent = [
      // Header bar
      jsx.jsxs("div", {
        className: "flex items-center justify-between gap-2",
        children: [
          jsx.jsxs("div", {
            className: "flex items-center gap-1.5",
            children: [
              jsx.jsx("span", {
                className: "text-[11px] font-semibold text-foreground",
                children: tr(t, "search_preset_switcher_title", "検索プリセット"),
              }),
              jsx.jsx("span", {
                className: "yk-sf-badge",
                children: `${presets.length}件`,
              }),
            ],
          }),
          jsx.jsxs("div", {
            className: "flex items-center gap-1",
            children: [
              jsx.jsx("button", {
                type: "button",
                className: `${miniBtnBase} border border-border bg-background text-foreground hover:bg-muted/60`,
                onClick: () => {
                  if (editorOpen) {
                    setEditorOpen(false);
                    setEditingPresetId(null);
                  } else {
                    openNewEditor();
                  }
                },
                children: editorOpen ? tr(t, "common_cancel", "キャンセル") : "+ 新規/保存",
              }),
              jsx.jsx("button", {
                type: "button",
                className: `${miniBtnBase} border ${backupOpen ? "border-primary bg-primary/15 text-primary" : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`,
                onClick: () => {
                  setBackupOpen(v => !v);
                  setEditorOpen(false);
                },
                children: "入出力",
              }),
              jsx.jsx("button", {
                type: "button",
                className: `${miniBtnBase} text-muted-foreground hover:bg-muted/60 hover:text-foreground`,
                onClick: () => searchState.setPanelMode?.("filters"),
                children: "詳細",
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

      // Backup / JSON Import-Export drawer
      backupOpen
        ? jsx.jsxs("div", {
            className: "flex flex-col gap-1.5 rounded-lg border border-border bg-background/80 p-2",
            children: [
              jsx.jsxs("div", {
                className: "flex flex-wrap items-center justify-between gap-1",
                children: [
                  jsx.jsx("span", {
                    className: "text-[11px] font-medium text-foreground",
                    children: "プリセットのバックアップ（更新・再インストール対策）",
                  }),
                  jsx.jsxs("div", {
                    className: "flex items-center gap-1",
                    children: [
                      jsx.jsx("button", {
                        type: "button",
                        className: `${miniBtnBase} border border-border bg-background text-foreground hover:bg-muted/60`,
                        onClick: handleDownloadJson,
                        children: "JSON書き出し",
                      }),
                      jsx.jsx("button", {
                        type: "button",
                        className: `${miniBtnBase} border border-border bg-background text-foreground hover:bg-muted/60`,
                        onClick: () => fileInputRef.current?.click?.(),
                        children: "ファイル読込",
                      }),
                      jsx.jsx("input", {
                        ref: fileInputRef,
                        type: "file",
                        accept: ".json",
                        className: "hidden",
                        onChange: (ev) => {
                          const file = ev.currentTarget.files?.[0];
                          if (!file || typeof FileReader === "undefined") return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            if (typeof reader.result === "string") setImportText(reader.result);
                          };
                          reader.readAsText(file);
                        },
                      }),
                    ],
                  }),
                ],
              }),
              jsx.jsx("textarea", {
                rows: 3,
                value: importText,
                placeholder: "エクスポートしたJSONを貼り付けて「追加」または「置換え」",
                className: "w-full rounded-md border border-border bg-background p-1.5 text-[11px] text-foreground outline-none focus:border-primary",
                onChange: (ev) => setImportText(ev.currentTarget.value),
              }),
              jsx.jsxs("div", {
                className: "flex items-center justify-between gap-1",
                children: [
                  jsx.jsx("span", {
                    className: "text-[10px] text-muted-foreground",
                    children: backupStatus || "chrome.storage.local + sync + .yomikui に自動保護されます",
                  }),
                  jsx.jsxs("div", {
                    className: "flex items-center gap-1",
                    children: [
                      jsx.jsx("button", {
                        type: "button",
                        className: `${miniBtnBase} border border-border bg-background text-foreground hover:bg-muted/60`,
                        onClick: () => handleImportSubmit("merge"),
                        children: "追加マージ",
                      }),
                      jsx.jsx("button", {
                        type: "button",
                        className: `${miniBtnBase} bg-primary text-primary-foreground hover:opacity-90`,
                        onClick: () => handleImportSubmit("replace"),
                        children: "置換え",
                      }),
                    ],
                  }),
                ],
              }),
            ],
          })
        : null,

      // Create / Edit Preset Form
      editorOpen && editorDraft
        ? jsx.jsxs("form", {
            className: "rd-search-preset-editor flex flex-col gap-2 rounded-lg border border-border bg-background/80 p-2",
            onSubmit: submitEditor,
            children: [
              // Quick query paste importer
              jsx.jsxs("div", {
                className: "flex items-center gap-1",
                children: [
                  jsx.jsx("input", {
                    type: "text",
                    value: pasteQueryInput,
                    placeholder: "X検索クエリやURLを貼り付けて自動解析 (任意)",
                    className: "h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary",
                    onChange: (ev) => setPasteQueryInput(ev.currentTarget.value),
                    onPaste: (ev) => {
                      const pasted = ev.clipboardData?.getData?.("text");
                      if (pasted) {
                        setPasteQueryInput(pasted);
                        applyPastedQueryToDraft(pasted);
                      }
                    },
                  }),
                  jsx.jsx("button", {
                    type: "button",
                    className: `${miniBtnBase} h-6 shrink-0 border border-border bg-background text-foreground hover:bg-muted/60`,
                    onClick: () => applyPastedQueryToDraft(pasteQueryInput),
                    children: "解析",
                  }),
                ],
              }),

              // Name & Pin
              jsx.jsxs("div", {
                className: "flex items-center gap-1.5",
                children: [
                  jsx.jsx("input", {
                    type: "text",
                    value: editorDraft.name,
                    placeholder: "プリセット名 (例: 撮影 model)",
                    "aria-label": "プリセット名",
                    className: "h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary",
                    onChange: (ev) => setEditorDraft({ ...editorDraft, name: ev.currentTarget.value }),
                  }),
                  jsx.jsxs("label", {
                    className: "inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground cursor-pointer",
                    children: [
                      jsx.jsx("input", {
                        type: "checkbox",
                        checked: Boolean(editorDraft.pinned),
                        onChange: (ev) => setEditorDraft({ ...editorDraft, pinned: ev.currentTarget.checked }),
                      }),
                      jsx.jsx("span", { children: "📌固定" }),
                    ],
                  }),
                ],
              }),

              // Query + Include toggle + Tab
              jsx.jsxs("div", {
                className: "flex flex-wrap items-center gap-1.5",
                children: [
                  jsx.jsx("input", {
                    type: "text",
                    value: editorDraft.query,
                    placeholder: "検索キーワード (例: 撮影 and (model or モデル))",
                    "aria-label": "プリセット検索キーワード",
                    className: "h-6 min-w-[9rem] flex-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary",
                    onChange: (ev) => setEditorDraft({
                      ...editorDraft,
                      query: ev.currentTarget.value,
                      includeQuery: Boolean(ev.currentTarget.value.trim()),
                    }),
                  }),
                  jsx.jsxs("select", {
                    value: editorDraft.tab || "",
                    "aria-label": "タブ指定",
                    className: "h-6 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground outline-none",
                    onChange: (ev) => setEditorDraft({ ...editorDraft, tab: ev.currentTarget.value || null }),
                    children: [
                      jsx.jsx("option", { value: "", children: "タブ維持" }),
                      ...TAB_OPTIONS.map(opt => jsx.jsx("option", { value: opt.value, children: tr(t, opt.labelKey, opt.fallback) }, `ed-tab-${opt.value}`)),
                    ],
                  }),
                ],
              }),

              // Tags & quick filter summary
              jsx.jsxs("div", {
                className: "flex flex-wrap items-center gap-1.5",
                children: [
                  jsx.jsx("input", {
                    type: "text",
                    value: editorDraft.tagsText,
                    placeholder: "タグ (例: 写真, 日課)",
                    "aria-label": "タグ",
                    className: "h-6 min-w-[7rem] flex-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary",
                    onChange: (ev) => setEditorDraft({ ...editorDraft, tagsText: ev.currentTarget.value }),
                  }),
                  jsx.jsx("input", {
                    type: "number",
                    min: 1,
                    value: editorDraft.filters.minFaves ? String(editorDraft.filters.minFaves) : "",
                    placeholder: "♥最小",
                    "aria-label": "プリセット最小いいね",
                    className: "h-6 w-16 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary",
                    onChange: (ev) => setEditorDraft({
                      ...editorDraft,
                      filters: normalizeFilters({ ...editorDraft.filters, minFaves: normalizePositiveInt(ev.currentTarget.value) }),
                    }),
                  }),
                  jsx.jsxs("select", {
                    value: editorDraft.filters.media || "",
                    "aria-label": "メディア種別",
                    className: "h-6 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground outline-none",
                    onChange: (ev) => setEditorDraft({
                      ...editorDraft,
                      filters: normalizeFilters({ ...editorDraft.filters, media: ev.currentTarget.value || null }),
                    }),
                    children: [
                      jsx.jsx("option", { value: "", children: "メディア指定なし" }),
                      ...MEDIA_OPTIONS.map(opt => jsx.jsx("option", { value: opt.value, children: tr(t, opt.labelKey, opt.fallback) }, `ed-m-${opt.value}`)),
                    ],
                  }),
                ],
              }),

              // Period mode selector
              jsx.jsxs("div", {
                className: "flex flex-col gap-1.5 rounded-md border border-border bg-card/60 p-1.5",
                children: [
                  jsx.jsxs("div", {
                    className: "flex flex-wrap items-center gap-1",
                    children: [
                      [
                        { value: "cursor", label: "進捗記録(遡る)" },
                        { value: "relative", label: "常に現在(今日等)" },
                        { value: "fixed", label: "固定期間" },
                        { value: "none", label: "期間なし" },
                      ].map(opt => jsx.jsx("button", {
                        type: "button",
                        className: `${chipBase} ${editorDraft.periodMode === opt.value ? chipActive : chipIdle}`,
                        onClick: () => setEditorDraft({ ...editorDraft, periodMode: opt.value }),
                        children: opt.label,
                      }, `pm-${opt.value}`)),
                    ],
                  }),
                  editorDraft.periodMode === "cursor" || editorDraft.periodMode === "relative"
                    ? jsx.jsxs("div", {
                        className: "flex flex-wrap items-center gap-2",
                        children: [
                          jsx.jsx("div", {
                            className: "flex overflow-hidden rounded border border-border bg-background",
                            children: PERIOD_UNITS.map(u => jsx.jsx("button", {
                              type: "button",
                              className: `px-2 py-0.5 text-[10px] font-medium cursor-pointer ${
                                editorDraft.cursorUnit === u.value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50"
                              }`,
                              onClick: () => setEditorDraft({ ...editorDraft, cursorUnit: u.value }),
                              children: tr(t, u.labelKey, u.fallback),
                            }, `ed-u-${u.value}`)),
                          }),
                          editorDraft.periodMode === "cursor"
                            ? jsx.jsxs("label", {
                                className: "inline-flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer",
                                children: [
                                  jsx.jsx("input", {
                                    type: "checkbox",
                                    checked: Boolean(editorDraft.autoAdvanceOnApply),
                                    onChange: (ev) => setEditorDraft({ ...editorDraft, autoAdvanceOnApply: ev.currentTarget.checked }),
                                  }),
                                  jsx.jsx("span", { children: "呼出時に自動で1つ前へ進める" }),
                                ],
                              })
                            : null,
                        ],
                      })
                    : null,
                  editorDraft.periodMode === "cursor" || editorDraft.periodMode === "fixed"
                    ? jsx.jsxs("div", {
                        className: "flex items-center gap-1",
                        children: [
                          jsx.jsx("input", {
                            type: "date",
                            value: editorDraft.cursorSince || "",
                            "aria-label": "プリセット開始日",
                            className: "h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none",
                            onChange: (ev) => setEditorDraft({ ...editorDraft, cursorSince: ev.currentTarget.value }),
                          }),
                          jsx.jsx("span", { className: "text-[11px] text-muted-foreground", children: "〜" }),
                          jsx.jsx("input", {
                            type: "date",
                            value: editorDraft.cursorEndInclusive || "",
                            "aria-label": "プリセット終了日",
                            className: "h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none",
                            onChange: (ev) => setEditorDraft({ ...editorDraft, cursorEndInclusive: ev.currentTarget.value }),
                          }),
                        ],
                      })
                    : null,
                ],
              }),

              jsx.jsxs("div", {
                className: "flex items-center justify-end gap-1.5",
                children: [
                  jsx.jsx("button", {
                    type: "button",
                    className: `${miniBtnBase} border border-border bg-background text-muted-foreground hover:text-foreground`,
                    onClick: () => {
                      setEditorOpen(false);
                      setEditingPresetId(null);
                    },
                    children: tr(t, "common_cancel", "キャンセル"),
                  }),
                  jsx.jsx("button", {
                    type: "submit",
                    className: "h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 cursor-pointer",
                    children: editingPresetId ? "更新を保存" : tr(t, "common_save", "保存"),
                  }),
                ],
              }),
            ],
          })
        : null,

      // Search box (auto-focused) + keyboard nav
      jsx.jsx("input", {
        ref: searchInputRef,
        type: "text",
        value: presetSearch,
        placeholder: "名前・キーワード・#タグで絞り込み (↑↓ / Enter)",
        "aria-label": "プリセット検索",
        className: "h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary",
        onChange: (ev) => {
          setPresetSearch(ev.currentTarget.value);
          setFocusedIdx(0);
        },
        onKeyDown: (ev) => {
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            setFocusedIdx(i => (filteredPresets.length ? (i + 1) % filteredPresets.length : 0));
          } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            setFocusedIdx(i => (filteredPresets.length ? (i - 1 + filteredPresets.length) % filteredPresets.length : 0));
          } else if (ev.key === "Enter" && filteredPresets.length > 0) {
            ev.preventDefault();
            const target = filteredPresets[Math.min(focusedIdx, filteredPresets.length - 1)];
            if (target) triggerApplyPreset(target);
          }
        },
      }),

      // Tag & Pin filter pills
      allTags.length > 0 || presets.some(p => p.pinned)
        ? jsx.jsxs("div", {
            className: "flex flex-wrap items-center gap-1",
            children: [
              jsx.jsx("button", {
                type: "button",
                className: `${chipBase} ${selectedTag === "all" ? chipActive : chipIdle}`,
                onClick: () => { setSelectedTag("all"); setFocusedIdx(0); },
                children: "すべて",
              }),
              presets.some(p => p.pinned)
                ? jsx.jsx("button", {
                    type: "button",
                    className: `${chipBase} ${selectedTag === "pinned" ? chipActive : chipIdle}`,
                    onClick: () => { setSelectedTag("pinned"); setFocusedIdx(0); },
                    children: "📌 ピン",
                  })
                : null,
              ...allTags.map(tag => jsx.jsx("button", {
                type: "button",
                className: `${chipBase} ${selectedTag === tag ? chipActive : chipIdle}`,
                onClick: () => { setSelectedTag(tag); setFocusedIdx(0); },
                children: `#${tag}`,
              }, `tag-${tag}`)),
            ],
          })
        : null,

      // Scrollable preset rows
      filteredPresets.length > 0
        ? jsx.jsx("div", {
            className: "yk-sf-list flex flex-col gap-1",
            children: filteredPresets.map((preset, idx) => {
              const isActive = activePreset?.id === preset.id;
              const periodBadge = formatPresetPeriodBadge(preset);
              const summary = formatPresetSummary(preset);
              const checkedToday = preset.periodMode === "cursor" && isSameLocalDay(preset.lastCheckedAt);
              return jsx.jsxs("div", {
                className: "yk-sf-row",
                "data-active": isActive ? "true" : "false",
                "data-focused": idx === focusedIdx ? "true" : "false",
                children: [
                  jsx.jsxs("button", {
                    type: "button",
                    className: "flex min-w-0 flex-1 flex-col gap-0.5 text-left cursor-pointer",
                    onClick: () => triggerApplyPreset(preset),
                    children: [
                      jsx.jsxs("div", {
                        className: "flex flex-wrap items-center gap-1",
                        children: [
                          jsx.jsx("span", {
                            className: "truncate text-xs font-medium text-foreground",
                            children: preset.name,
                          }),
                          periodBadge
                            ? jsx.jsx("span", {
                                className: "yk-sf-badge",
                                "data-tone": preset.periodMode === "cursor" ? "cursor" : undefined,
                                children: periodBadge,
                              })
                            : null,
                          checkedToday
                            ? jsx.jsx("span", {
                                className: "yk-sf-badge",
                                "data-tone": "done",
                                children: "✓ 今日確認",
                              })
                            : null,
                        ],
                      }),
                      preset.includeQuery && preset.query || summary || (preset.tags && preset.tags.length > 0)
                        ? jsx.jsx("div", {
                            className: "truncate text-[10px] text-muted-foreground",
                            children: [
                              preset.includeQuery && preset.query ? preset.query : "",
                              summary,
                              ...(preset.tags || []).map(tag => `#${tag}`),
                            ].filter(Boolean).join(" · "),
                          })
                        : null,
                    ],
                  }),
                  jsx.jsxs("div", {
                    className: "flex shrink-0 items-center gap-0.5",
                    children: [
                      preset.periodMode === "cursor"
                        ? jsx.jsx("button", {
                            type: "button",
                            className: "h-6 rounded border border-border bg-background px-1.5 text-[10px] font-medium text-primary hover:bg-primary/10 cursor-pointer",
                            title: "進捗を1つ前へ進めて開く",
                            "aria-label": `${preset.name} を1つ前へ進める`,
                            onClick: (ev) => {
                              ev?.stopPropagation?.();
                              searchState.stepPresetAndApply?.(preset, -1);
                            },
                            children: "◀ 次",
                          })
                        : null,
                      jsx.jsx("button", {
                        type: "button",
                        className: "h-6 rounded border border-border bg-background px-1.5 text-[10px] font-medium text-foreground hover:bg-muted/60 cursor-pointer",
                        title: "進捗を変えずに今日のみで検索",
                        "aria-label": `${preset.name} を今日のみで開く`,
                        onClick: (ev) => {
                          ev?.stopPropagation?.();
                          triggerApplyPreset(preset, { mode: "today" });
                        },
                        children: "今日",
                      }),
                      jsx.jsx("button", {
                        type: "button",
                        className: `h-6 w-6 rounded text-[11px] hover:bg-muted/60 cursor-pointer ${preset.pinned ? "text-primary" : "text-muted-foreground"}`,
                        title: preset.pinned ? "ピン解除" : "ピン留め",
                        "aria-label": `${preset.name} ピン留め切替`,
                        onClick: (ev) => {
                          ev?.stopPropagation?.();
                          searchState.togglePresetPin?.(preset.id);
                        },
                        children: preset.pinned ? "📌" : "☆",
                      }),
                      jsx.jsx("button", {
                        type: "button",
                        className: "h-6 w-6 rounded text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground cursor-pointer",
                        title: "編集",
                        "aria-label": `${preset.name} を編集`,
                        onClick: (ev) => {
                          ev?.stopPropagation?.();
                          openEditEditor(preset);
                        },
                        children: "✎",
                      }),
                      jsx.jsx("button", {
                        type: "button",
                        className: "h-6 w-5 rounded text-[11px] text-muted-foreground hover:text-destructive cursor-pointer",
                        title: "削除",
                        "aria-label": `${preset.name} を削除`,
                        onClick: (ev) => {
                          ev?.stopPropagation?.();
                          searchState.deletePreset(preset.id);
                        },
                        children: "×",
                      }),
                    ],
                  }),
                ],
              }, preset.id);
            }),
          })
        : jsx.jsx("span", {
            className: "py-2 text-center text-[11px] text-muted-foreground",
            children: presets.length === 0
              ? tr(t, "search_filter_no_presets", "保存済みのプリセットはありません")
              : "一致するプリセットがありません",
          }),
    ];

    const filtersPanelContent = [
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
                          onClick: () => {
                            searchState.clearActivePreset?.();
                            searchState.navigateSearch(buildSearchPath(keywordDraft, normalizeFilters(), tab));
                          },
                          children: tr(t, "search_filter_clear", "解除"),
                        })
                      : null,
                    typeof searchState.setPanelMode === "function"
                      ? jsx.jsx("button", {
                          type: "button",
                          className: `${miniBtnBase} text-muted-foreground hover:bg-muted/60 hover:text-foreground`,
                          onClick: () => searchState.setPanelMode("presets"),
                          children: "一覧/管理",
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
                        setSaveAsCursorPeriod(false);
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
            presets.length > 4
              ? jsx.jsx("input", {
                  type: "text",
                  value: presetSearch,
                  placeholder: "プリセットを絞り込み...",
                  "aria-label": "プリセット絞り込み",
                  className: "h-6 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary",
                  onChange: (ev) => setPresetSearch(ev.currentTarget.value),
                })
              : null,
            filteredPresets.length > 0
              ? jsx.jsx("div", {
                  className: "flex flex-wrap items-center gap-1",
                  children: filteredPresets.map(preset => {
                    const effectiveFilters = getEffectivePresetFilters(preset);
                    const isMatched =
                      (activePreset?.id === preset.id) ||
                      (filtersEqual(effectiveFilters, filters) &&
                        (!preset.tab || preset.tab === tab) &&
                        (!preset.includeQuery || (preset.query ?? "") === baseText));
                    const periodBadge = formatPresetPeriodBadge(preset);
                    const presetTitle = [
                      preset.name,
                      preset.includeQuery && preset.query ? `(${preset.query})` : "",
                      periodBadge ? `[${periodBadge}]` : "",
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
                          onClick: () => triggerApplyPreset(preset),
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
                                  onChange: (ev) => {
                                    const checked = ev.currentTarget.checked;
                                    setSaveAsRelativePeriod(checked);
                                    if (checked) setSaveAsCursorPeriod(false);
                                  },
                                }),
                                jsx.jsx("span", {
                                  children: `相対期間として保存 (実行時の${tr(t, detectedPeriodMeta.currentKey, detectedPeriodMeta.currentFallback)})`,
                                }),
                              ],
                            })
                          : null,
                        jsx.jsxs("label", {
                          className: "inline-flex items-center gap-1 cursor-pointer",
                          children: [
                            jsx.jsx("input", {
                              type: "checkbox",
                              checked: saveAsCursorPeriod,
                              onChange: (ev) => {
                                const checked = ev.currentTarget.checked;
                                setSaveAsCursorPeriod(checked);
                                if (checked) setSaveAsRelativePeriod(false);
                              },
                            }),
                            jsx.jsx("span", { children: "進捗記録モード（期間を遡って記憶）" }),
                          ],
                        }),
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
                        filters.sinceDate ? `since:${formatSearchDateBoundary(filters.sinceDate)}` : null,
                        filters.untilDate ? `until:${formatSearchDateBoundary(filters.untilDate)}` : null,
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
    ];

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
            className: `${panelMode === "presets" ? "rd-search-preset-switcher" : "rd-search-filter-panel"} absolute left-1.5 right-1.5 top-1 flex max-h-[min(32rem,calc(100vh-7rem))] flex-col gap-2 overflow-y-auto overscroll-y-contain rounded-xl border border-border bg-popover px-2.5 py-2 text-xs text-foreground shadow-xl select-none`,
            onClick: (ev) => ev?.stopPropagation?.(),
            children: panelMode === "presets" ? presetsSwitcherContent : filtersPanelContent,
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
    LOCAL_BACKUP_KEY,
    COL_STATE_STORAGE_KEY,
    DEFAULT_PRESETS,
    MEDIA_OPTIONS,
    BOOLEAN_OPTIONS,
    RECENCY_OPTIONS,
    PERIOD_UNITS,
    TAB_OPTIONS,
    FAVES_PRESETS,
    RETWEETS_PRESETS,
    parseYmd,
    formatSearchDateBoundary,
    parseSearchDateToken,
    todayYmd,
    addDaysYmd,
    addMonthsYmd,
    getPeriodBounds,
    detectPeriodUnit,
    isMatchingCurrentPeriod,
    shiftPeriodRange,
    formatPeriodLabel,
    formatDaysAgo,
    isSameLocalDay,
    normalizeFilters,
    resolveFilterPeriod,
    getEffectivePresetFilters,
    countActiveFilters,
    filtersEqual,
    tokenizeQuery,
    parseSearchQuery,
    parseQueryDraft,
    buildSearchQuery,
    parseSearchUrl,
    buildSearchPath,
    suggestPresetName,
    normalizeTags,
    normalizePreset,
    formatPresetCursorLabel,
    formatPresetPeriodBadge,
    formatPresetSummary,
    stepPresetCursor,
    matchPresetSearch,
    exportPresetsPayload,
    importPresetsPayload,
    registerMirrorBackend,
    exportBackupData,
    importBackupData,
    loadPresets,
    savePresets,
    addPreset,
    updatePreset,
    togglePresetPin,
    advancePresetCursor,
    touchPresetUsage,
    importPresets,
    deletePreset,
    applyPresetToUrl,
    subscribePresets,
    installFrameSearchBridge,
    useColumnSearch,
    PresetButton,
    FilterButton,
    FilterPanel,
  });
})();
