"use strict";

// Shared by the dashboard, native X columns and both Live Feed renderers.
// Keep new behavior readable while the existing UI ships as prebuilt bundles.
(() => {
  if (globalThis.YomikuiTweetActions) return;
  const TWEET = 'article[data-testid="tweet"]';
  const SLOT = 'data-yomikui-tweet-action';
  const COUNT = 'data-yomikui-action-count';
  const STYLE_ID = 'yomikui-tweet-action-styles';
  const SETTINGS = Object.freeze([
    { key: 'showQuoteList', label: 'column_settings_show_quote_list', description: 'column_settings_show_quote_list_desc', defaultValue: true },
    { key: 'showRetweetList', label: 'column_settings_show_retweet_list', description: 'column_settings_show_retweet_list_desc', defaultValue: true },
    { key: 'hideViews', label: 'column_settings_hide_views', description: 'column_settings_hide_views_desc', defaultValue: true },
    { key: 'hideShare', label: 'column_settings_hide_share', description: 'column_settings_hide_share_desc', defaultValue: true },
  ]);
  const LISTS = Object.freeze([
    { key: 'showQuoteList', kind: 'quotes', label: 'tweet_action_quote_list', fallback: '引用リツイート一覧', path: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4v4h2v2H6v-4a2 2 0 0 1 1-2Zm7 0v4h2v2h-3v-4a2 2 0 0 1 1-2Z' },
    { key: 'showRetweetList', kind: 'retweets', label: 'tweet_action_retweet_list', fallback: 'リツイート一覧', path: 'm5 2 4 4-1.4 1.4L6 5.8V15a2 2 0 0 0 2 2h3v2H8a4 4 0 0 1-4-4V5.8L2.4 7.4 1 6l4-4Zm11 3a4 4 0 0 1 4 4v9.2l1.6-1.6L23 18l-4 4-4-4 1.4-1.4 1.6 1.6V9a2 2 0 0 0-2-2h-3V5h3ZM9 10h6v2H9v-2Zm0 4h6v2H9v-2Z' },
  ]);

  function normalizeSettings(value = {}) {
    return Object.fromEntries(SETTINGS.map(({ key, defaultValue = false }) => [key, typeof value[key] === 'boolean' ? value[key] : defaultValue]));
  }

  function readCount(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\d+(?:,\d{3})*$/.test(value.trim())) return null;
    const count = Number(String(value).replace(/,/g, ''));
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  // Match the compact numbers used by the existing Live Feed action buttons.
  function formatCount(value) {
    const count = readCount(value);
    if (count === null || count < 1) return '';
    if (count < 10000) return count.toLocaleString('en-US');
    const unit = count < 1000000 ? 'K' : 'M';
    const scaled = count / (unit === 'K' ? 1000 : 1000000);
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${unit}`;
  }

  const MAX_CACHED_TWEETS = 1000;
  const tweetCounts = new Map();
  const getCounts = tweetId => tweetCounts.get(tweetId);

  // Reuse the JSON already decoded by the media response consumer. This also
  // finds text-only tweets, quoted tweets and the originals inside reposts.
  function captureResponse(response) {
    const stack = [response];
    const seen = new WeakSet();
    const changed = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const legacy = node.legacy ?? node;
      const id = legacy.id_str ?? node.rest_id;
      if (typeof id === 'string' && /^\d+$/.test(id)) {
        const quoteCount = readCount(legacy.quote_count);
        const repostCount = readCount(legacy.retweet_count);
        if (quoteCount !== null || repostCount !== null) {
          const previous = tweetCounts.get(id);
          const next = { quoteCount: quoteCount ?? previous?.quoteCount, repostCount: repostCount ?? previous?.repostCount };
          if (!previous || previous.quoteCount !== next.quoteCount || previous.repostCount !== next.repostCount) changed.add(id);
          tweetCounts.delete(id);
          tweetCounts.set(id, next);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (!value || typeof value !== 'object') continue;
        if (key === 'user_results' || key === 'feedbackInfo' || key === 'clientEventInfo' || key === 'responseObjects' || key === 'ext') continue;
        stack.push(value);
      }
    }
    while (tweetCounts.size > MAX_CACHED_TWEETS) tweetCounts.delete(tweetCounts.keys().next().value);
    if (changed.size) controller?.refreshCounts(changed);
  }

  function nativeRetweetCount(group, cachedCount) {
    const button = group.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
    const counter = button?.querySelector('[data-testid="app-text-transition-container"]');
    const text = (counter?.textContent ?? button?.textContent ?? '').trim();
    // Keep X's own localized/abbreviated number, including optimistic updates.
    if (/^[\d.,\s]+(?:[KMBkmb]|万|億|兆)?$/.test(text)) return /[1-9]/.test(text) ? text : '';
    if (counter && text === '') return '';
    return formatCount(cachedCount);
  }

  function getStatusPath(href) {
    if (typeof href !== 'string' || !href) return null;
    try {
      const url = new URL(href, 'https://x.com');
      if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return null;
      return url.pathname.match(/^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+(?=\/|$)/)?.[0] ?? null;
    } catch {
      return null;
    }
  }

  function getListPath(statusPath, kind) {
    const path = getStatusPath(statusPath);
    return path && LISTS.some(list => list.kind === kind) ? `${path}/${kind}` : null;
  }

  function actionLabel(list) {
    return globalThis.chrome?.i18n?.getMessage(list.label) || list.fallback;
  }

  function SettingsControls({ column, onChange, Switch, Label, jsx, t, rowClassName, disabled = false }) {
    return jsx.jsx(jsx.Fragment, {
      children: SETTINGS.map(setting => jsx.jsxs('div', {
        className: rowClassName,
        children: [
          jsx.jsx(Label, { label: t(setting.label), description: t(setting.description) }),
          jsx.jsx(Switch, {
            checked: normalizeSettings(column)[setting.key],
            disabled,
            'aria-label': t(setting.label),
            onCheckedChange: checked => onChange({ [setting.key]: checked === true }),
          }),
        ],
      }, setting.key)),
    });
  }

  function ListLinks({ settings, statusPath, onOpenTweet, color, quoteCount, repostCount, metaFontPx = 13, formatCount: format = formatCount, jsx }) {
    return jsx.jsx(jsx.Fragment, {
      children: LISTS.filter(list => settings[list.key] === true).map(list => {
        const path = getListPath(statusPath, list.kind);
        if (!path) return null;
        const label = actionLabel(list);
        const count = readCount(list.kind === 'quotes' ? quoteCount : repostCount);
        const countText = count > 0 ? format(count) : '';
        return jsx.jsxs('a', {
          href: `https://x.com${path}`,
          title: label,
          'aria-label': countText ? `${label} ${count.toLocaleString('en-US')}` : label,
          className: `rd-lf-engagement-action rd-lf-engagement-action--${list.kind}`,
          style: { color, textDecoration: 'none', justifyContent: 'center', minWidth: 28, display: 'inline-flex', alignItems: 'center', gap: 4 },
          onPointerDown: event => event.stopPropagation(),
          onClick: event => {
            event.stopPropagation();
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpenTweet(path);
          },
          children: [
            jsx.jsx('svg', {
              width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
              children: jsx.jsx('path', { d: list.path, fillRule: 'evenodd' }),
            }),
            countText ? jsx.jsx('span', {
              [COUNT]: '',
              style: { fontSize: metaFontPx, lineHeight: `${Math.round(metaFontPx * 1.23)}px`, fontVariantNumeric: 'tabular-nums' },
              children: countText,
            }) : null,
          ],
        }, list.kind);
      }),
    });
  }

  function getNativeCss(settings) {
    const group = `${TWEET} [role="group"]`;
    const rules = [];
    if (settings.hideViews) {
      rules.push(`${group} a[href*="/analytics"], ${group} div:has(> a[href*="/analytics"]:only-child) { display: none !important; }`);
    }
    if (settings.hideShare) {
      // X's share button has no stable test id on some versions. Match its
      // accessible name too, and collapse only the button's immediate slot.
      const share = ':is(button[data-testid="share"], button[aria-label="Share"], button[aria-label="Share post"], button[aria-label="Share Tweet"], button[aria-label="Share tweet"], button[aria-label="共有"], button[aria-label="ポストを共有"], button[aria-label="ツイートを共有"])';
      rules.push(`${group} ${share}, ${group} div:has(> ${share}:only-child) { display: none !important; }`);
    }
    if (settings.showQuoteList || settings.showRetweetList) {
      rules.push(`
        [${SLOT}] { display: flex; align-items: center; flex: 0 0 auto; }
        [${SLOT}] > a { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 28px; height: 28px; border-radius: 50%; color: rgb(113, 118, 123); text-decoration: none; }
        [${SLOT}] [${COUNT}] { font-size: 13px; line-height: 16px; font-variant-numeric: tabular-nums; }
        [${SLOT}] > a:hover { color: #1d9bf0; background: rgba(29, 155, 240, .1); }
        [${SLOT}] > a:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
      `);
    }
    return rules.join('\n');
  }

  class NativeActionsController {
    constructor() {
      this.settings = normalizeSettings();
      this.columnVisible = true;
      this.suspended = false;
      this.pending = new Set();
      this.observer = null;
      this.timer = null;
      this.syncVisibility = () => this.sync();
      document.addEventListener('visibilitychange', this.syncVisibility);
      document.addEventListener('DOMContentLoaded', this.syncVisibility, { once: true });
      window.addEventListener('yomikui-frame-column-visibility', event => {
        this.columnVisible = event.detail.visible;
        this.sync();
      });
      window.addEventListener('pagehide', () => { this.suspended = true; this.sync(); });
      window.addEventListener('pageshow', () => { this.suspended = false; this.sync(); });
      window.addEventListener('popstate', () => { this.scan(document); this.scheduleFlush(); });
      window.addEventListener('hashchange', () => { this.scan(document); this.scheduleFlush(); });
      window.navigation?.addEventListener?.('navigatesuccess', () => { this.scan(document); this.scheduleFlush(); });
    }

    update(value) {
      this.settings = normalizeSettings(value.isLiveFeedColumn ? { hideViews: false, hideShare: false } : value);
      const css = getNativeCss(this.settings);
      let style = document.getElementById(STYLE_ID);
      if (css) {
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          (document.head ?? document.documentElement)?.appendChild(style);
        }
        if (style.textContent !== css) style.textContent = css;
      } else {
        style?.remove();
      }
      for (const slot of document.querySelectorAll(`[${SLOT}]`)) {
        const list = LISTS.find(item => item.kind === slot.getAttribute(SLOT));
        if (!list || !this.settings[list.key]) slot.remove();
      }
      this.sync();
    }

    sync() {
      const enabled = this.settings.showQuoteList || this.settings.showRetweetList;
      if (!enabled || document.hidden || !this.columnVisible || this.suspended) {
        this.observer?.disconnect();
        this.observer = null;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.pending.clear();
        return;
      }
      this.scan(document);
      this.flush();
      if (this.observer) return;
      this.observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'characterData') {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (!target?.closest?.('[data-testid="retweet"], [data-testid="unretweet"]')) continue;
            const tweet = target.closest(TWEET);
            if (tweet) this.pending.add(tweet);
            continue;
          }
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          const tweet = target?.closest?.(TWEET);
          if (tweet) this.pending.add(tweet);
          else for (const node of record.addedNodes ?? []) if (node.nodeType === 1) this.scan(node);
        }
        this.scheduleFlush();
      });
      this.observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
    }

    scheduleFlush() {
      if (this.pending.size && this.timer === null) {
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 80);
      }
    }

    refreshCounts(changed) {
      if (!this.observer) return;
      for (const slot of document.querySelectorAll(`[${SLOT}]`)) {
        if (changed.has(slot.getAttribute('data-yomikui-tweet-id'))) this.pending.add(slot.closest(TWEET));
      }
      this.scheduleFlush();
    }

    scan(root) {
      if (root.matches?.(TWEET)) this.pending.add(root);
      for (const tweet of root.querySelectorAll(TWEET)) this.pending.add(tweet);
    }

    flush() {
      for (const tweet of this.pending) if (tweet.isConnected && !tweet.matches('.rd-lf-tweet')) this.process(tweet);
      this.pending.clear();
    }

    process(tweet) {
      const reply = tweet.querySelector('[data-testid="reply"]');
      const group = reply?.closest('[role="group"]');
      if (!group || group.closest(TWEET) !== tweet) return;
      // The first status link in a tweet can belong to quoted media. Prefer
      // the action row's analytics URL, then the main author's timestamp.
      let path = getStatusPath(group.querySelector('a[href*="/analytics"]')?.getAttribute('href'));
      if (!path) {
        for (const link of tweet.querySelectorAll('a[href*="/status/"]')) {
          if (!link.closest('[data-testid="User-Name"]') || !link.querySelector('time')) continue;
          if (link.closest('[role="link"], [data-testid="quoteTweet"], [data-testid="tweetQuote"]')) continue;
          path = getStatusPath(link.getAttribute('href'));
          if (path) break;
        }
      }
      if (!path) {
        // Detail / permalink view: the author timestamp is placed below the text
        // (outside User-Name), and analytics links sit next to the date.
        const pagePath = getStatusPath(window.location?.pathname) || getStatusPath(window.location?.href);
        const pageId = pagePath?.match(/\/status\/(\d+)$/)?.[1];
        if (pageId && tweet.querySelector(`a[href*="/status/${pageId}"]`)) {
          path = pagePath;
        } else {
          path = getStatusPath(tweet.querySelector('a[href*="/analytics"]')?.getAttribute('href'));
        }
        if (!path) {
          for (const link of tweet.querySelectorAll('a[href*="/status/"]')) {
            if (!link.querySelector('time')) continue;
            if (link.closest('[role="link"], [data-testid="quoteTweet"], [data-testid="tweetQuote"]')) continue;
            path = getStatusPath(link.getAttribute('href'));
            if (path) break;
          }
        }
      }
      const id = path?.match(/\/status\/(\d+)$/)?.[1];
      const counts = getCounts(id);
      for (const list of LISTS) {
        const slots = [...tweet.querySelectorAll(`[${SLOT}="${list.kind}"]`)];
        let slot = slots.shift();
        for (const duplicate of slots) duplicate.remove();
        if (!this.settings[list.key] || !path) { slot?.remove(); continue; }
        if (!slot || slot.parentElement !== group) {
          slot?.remove();
          slot = document.createElement('div');
          slot.setAttribute(SLOT, list.kind);
          const link = document.createElement('a');
          link.setAttribute('aria-label', actionLabel(list));
          link.title = actionLabel(list);
          link.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${list.path}" fill-rule="evenodd"/></svg>`;
          link.addEventListener('click', event => event.stopPropagation());
          slot.appendChild(link);
          group.appendChild(slot);
        }
        const link = slot.querySelector('a');
        const href = `https://x.com${getListPath(path, list.kind)}${window.location.hash}`;
        if (link.getAttribute('href') !== href) link.setAttribute('href', href);
        if (slot.getAttribute('data-yomikui-tweet-id') !== id) slot.setAttribute('data-yomikui-tweet-id', id);
        const text = list.kind === 'quotes' ? formatCount(counts?.quoteCount) : nativeRetweetCount(group, counts?.repostCount);
        let counter = link.querySelector(`[${COUNT}]`);
        if (text) {
          if (!counter) {
            counter = document.createElement('span');
            counter.setAttribute(COUNT, '');
            link.appendChild(counter);
          }
          if (counter.textContent !== text) counter.textContent = text;
        } else counter?.remove();
        const label = `${actionLabel(list)}${text ? ` ${text}` : ''}`;
        if (link.getAttribute('aria-label') !== label) link.setAttribute('aria-label', label);
      }
    }
  }

  let controller;
  function updateNative(settings) {
    if (!controller && (settings.isLiveFeedColumn || !Object.values(normalizeSettings(settings)).some(Boolean))) return;
    controller ??= new NativeActionsController();
    controller.update(settings);
  }

  globalThis.YomikuiTweetActions = Object.freeze({
    SETTINGS, normalizeSettings, readCount, formatCount, captureResponse, getCounts, getStatusPath, getListPath, getNativeCss,
    SettingsControls, ListLinks, NativeActionsController, updateNative,
  });
})();
