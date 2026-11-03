"use strict";

// Shared by the dashboard, native X columns and both Live Feed renderers.
// Keep new behavior readable while the existing UI ships as prebuilt bundles.
(() => {
  if (globalThis.YomikuiTweetActions) return;
  const TWEET = 'article[data-testid="tweet"]';
  const SLOT = 'data-yomikui-tweet-action';
  const STYLE_ID = 'yomikui-tweet-action-styles';
  const SETTINGS = Object.freeze([
    { key: 'showQuoteList', label: 'column_settings_show_quote_list', description: 'column_settings_show_quote_list_desc' },
    { key: 'showRetweetList', label: 'column_settings_show_retweet_list', description: 'column_settings_show_retweet_list_desc' },
    { key: 'hideViews', label: 'column_settings_hide_views', description: 'column_settings_hide_views_desc' },
    { key: 'hideShare', label: 'column_settings_hide_share', description: 'column_settings_hide_share_desc' },
  ]);
  const LISTS = Object.freeze([
    { key: 'showQuoteList', kind: 'quotes', label: 'tweet_action_quote_list', fallback: '引用リツイート一覧', path: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4v4h2v2H6v-4a2 2 0 0 1 1-2Zm7 0v4h2v2h-3v-4a2 2 0 0 1 1-2Z' },
    { key: 'showRetweetList', kind: 'retweets', label: 'tweet_action_retweet_list', fallback: 'リツイート一覧', path: 'm5 2 4 4-1.4 1.4L6 5.8V15a2 2 0 0 0 2 2h3v2H8a4 4 0 0 1-4-4V5.8L2.4 7.4 1 6l4-4Zm11 3a4 4 0 0 1 4 4v9.2l1.6-1.6L23 18l-4 4-4-4 1.4-1.4 1.6 1.6V9a2 2 0 0 0-2-2h-3V5h3ZM9 10h6v2H9v-2Zm0 4h6v2H9v-2Z' },
  ]);

  function normalizeSettings(value = {}) {
    return Object.fromEntries(SETTINGS.map(({ key }) => [key, value[key] === true]));
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
            checked: column[setting.key] === true,
            disabled,
            'aria-label': t(setting.label),
            onCheckedChange: checked => onChange({ [setting.key]: checked === true }),
          }),
        ],
      }, setting.key)),
    });
  }

  function ListLinks({ settings, statusPath, onOpenTweet, color, jsx }) {
    return jsx.jsx(jsx.Fragment, {
      children: LISTS.filter(list => settings[list.key] === true).map(list => {
        const path = getListPath(statusPath, list.kind);
        if (!path) return null;
        const label = actionLabel(list);
        return jsx.jsx('a', {
          href: `https://x.com${path}`,
          title: label,
          'aria-label': label,
          className: `rd-lf-engagement-action rd-lf-engagement-action--${list.kind}`,
          style: { color, textDecoration: 'none', justifyContent: 'center', minWidth: 28 },
          onPointerDown: event => event.stopPropagation(),
          onClick: event => {
            event.stopPropagation();
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpenTweet(path);
          },
          children: jsx.jsx('svg', {
            width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
            children: jsx.jsx('path', { d: list.path, fillRule: 'evenodd' }),
          }),
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
        [${SLOT}] > a { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; color: rgb(113, 118, 123); text-decoration: none; }
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
    }

    update(value) {
      this.settings = normalizeSettings(value.isLiveFeedColumn ? {} : value);
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
          const tweet = record.target.closest?.(TWEET);
          if (tweet) this.pending.add(tweet);
          else for (const node of record.addedNodes ?? []) if (node.nodeType === 1) this.scan(node);
        }
        if (this.pending.size && this.timer === null) {
          this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 80);
        }
      });
      this.observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
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
          path = getStatusPath(link.getAttribute('href'));
          if (path) break;
        }
      }
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
      }
    }
  }

  let controller;
  function updateNative(settings) {
    if (!controller && !SETTINGS.some(({ key }) => settings[key] === true)) return;
    controller ??= new NativeActionsController();
    controller.update(settings);
  }

  globalThis.YomikuiTweetActions = Object.freeze({
    SETTINGS, normalizeSettings, getStatusPath, getListPath, getNativeCss,
    SettingsControls, ListLinks, NativeActionsController, updateNative,
  });
})();
