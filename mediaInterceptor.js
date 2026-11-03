(function() {
  // The response consumer is installed only inside deck iframes. Query ID
  // discovery for top-level pages is handled by the background webRequest hook.
  if (window.self === window.top) return;
  if (window.__yomikuiMediaInterceptorInstalled) return;
  window.__yomikuiMediaInterceptorInstalled = true;

  /** Live Feed カラムは React でツイートを描画するため、X 本体の SPA が大量の DOM を生成する前に除去する */
  const isLiveFeedFeedSurface = () => {
    if (!location.hash.includes('lf1')) return false;
    if (/\/status\/\d+/.test(location.pathname)) return false;
    return true;
  };

  const suppressXSpaForLiveFeed = () => {
    if (window.__yomikuiLiveFeedSpaSuppress) return;
    window.__yomikuiLiveFeedSpaSuppress = true;
    const strip = () => {
      const root = document.getElementById('react-root');
      if (root && root.childElementCount > 0) root.replaceChildren();
    };
    strip();
    const rootObserver = new MutationObserver(strip);
    const attach = () => {
      const root = document.getElementById('react-root');
      if (!root) return false;
      rootObserver.observe(root, { childList: true });
      strip();
      return true;
    };
    if (!attach()) {
      const wait = new MutationObserver(() => {
        if (attach()) wait.disconnect();
      });
      wait.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('DOMContentLoaded', strip, { once: true });
  };

  if (isLiveFeedFeedSurface()) {
    window.__yomikuiLiveFeedMode = true;
    suppressXSpaForLiveFeed();
  }

  const ENDPOINTS = [
    'TweetDetail',
    'TweetResultByRestId',
    'UserTweets',
    'UserMedia',
    'HomeTimeline',
    'HomeLatestTimeline',
    'ListLatestTweetsTimeline',
    'SearchTimeline',
    'Bookmarks',
    'Likes',
    'NotificationsTimeline',
  ];

  const shouldIntercept = (url) => ENDPOINTS.some(ep => url.includes(ep));

  const dispatchResponse = (url, body) => {
    const match = url.match(/graphql\/([^/?]+)\/([^/?]+)/);
    if (match) {
      window.dispatchEvent(new CustomEvent('yomikui-query-id-discovered', {
        detail: { queryId: match[1], operationName: match[2] }
      }));
    }
    // Live Feed 側でタイムライン JSON を直接パースするため、巨大なレスポンス本文のコンテンツスクリプトへの重複送信をスキップ
    if (window.__yomikuiLiveFeedMode) return;
    window.dispatchEvent(new CustomEvent('yomikui-media-response', {
      detail: { url, body }
    }));
  };

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    if (!shouldIntercept(url)) return response;

    // Live Feed only needs the query ID. Avoid teeing and decoding a body that
    // dispatchResponse would discard after the allocation has already happened.
    if (window.__yomikuiLiveFeedMode) {
      dispatchResponse(url);
      return response;
    }

    try {
      const clone = response.clone();
      clone.text().then(body => dispatchResponse(url, body)).catch(() => {});
    } catch {}

    return response;
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const requestUrls = new WeakMap();
  const observedRequests = new WeakSet();
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    requestUrls.set(this, String(url));
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const url = requestUrls.get(this) ?? '';
    
    if (shouldIntercept(url) && !observedRequests.has(this)) {
      observedRequests.add(this);
      this.addEventListener('load', function() {
        // XHR instances can be reopened. Read the current URL and install just
        // one listener for their lifetime instead of retaining each old URL.
        const currentUrl = requestUrls.get(this) ?? '';
        if (!shouldIntercept(currentUrl)) return;
        try {
          if (window.__yomikuiLiveFeedMode) {
            dispatchResponse(currentUrl);
          } else if (this.responseType === '' || this.responseType === 'text') {
            dispatchResponse(currentUrl, this.responseText);
          } else if (this.responseType === 'json') {
            dispatchResponse(currentUrl, JSON.stringify(this.response));
          }
        } catch {}
      });
    }
    
    return originalXHRSend.apply(this, args);
  };
})();
