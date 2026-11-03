// Content scripts share an isolated world, so the bundled iframe can use this
// helper without exposing its state to the X page.
(() => {
  if (window.self === window.top) return;

  const TWEET = 'article[data-testid="tweet"]';
  const COUNT_DELAY = 4000;
  const CLEANUP_DELAY = 60000;
  const PERFORMANCE_DELAY = 5000;
  const MIN_SESSION_AGE = 10 * 60 * 1000;
  const MIN_CHURN = 90;
  const MIN_FPS = 45;
  const STYLE_IDS = [
    'yomikui-account-label-styles',
    'yomikui-account-nickname-styles',
    'yomikui-user-meta-badges-wrap-styles',
    'yomikui-one-click-block-styles',
    'yomikui-tweet-screenshot-styles',
    'yomikui-cover-blue-verified-styles',
    'yomikui-fbv-styles',
  ];
  const DUPLICATES = [
    ['.yomikui-cbv-overlay, .yomikui-fbv-overlay', 1],
    ['.yomikui-ocb-wrapper', 1],
    ['.yomikui-screenshot-wrapper', 1],
    ['.yomikui-add-label-btn', 1],
    ['.yomikui-edit-nickname-btn', 1],
    ['.yomikui-label-badge', 16],
    ['.yomikui-account-location-badge', 8],
  ];

  globalThis.YomikuiFrameMaintenance = class {
    constructor({ targetOrigin, getColumnId, isColumnVisible, getChurn }) {
      this.targetOrigin = targetOrigin;
      this.getColumnId = getColumnId;
      this.isColumnVisible = isColumnVisible;
      this.getChurn = getChurn;
      this.startedAt = Date.now();
      this.seenIds = new Set();
      this.pendingTweets = new Set();
      this.count = 0;
      this.lastCount = -1;
      this.suggested = false;
      this.fps = 60;
      this.active = false;
      this.started = false;
      this.suspended = false;
      this.observer = null;
      this.countTimer = null;
      this.cleanupTimer = null;
      this.performanceTimer = null;
      this.animationFrame = null;
      this.syncVisibility = () => this.updateVisibility();
      this.onPageHide = () => {
        this.suspended = true;
        this.updateVisibility();
      };
      this.onPageShow = () => {
        this.suspended = false;
        this.updateVisibility();
      };
    }

    start() {
      if (this.started) return;
      this.started = true;
      document.addEventListener('visibilitychange', this.syncVisibility);
      window.addEventListener('yomikui-frame-column-visibility', this.syncVisibility);
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('pageshow', this.onPageShow);
      this.updateVisibility();
    }

    updateVisibility() {
      const visible = this.started && !this.suspended && !document.hidden && this.isColumnVisible();
      if (visible === this.active) return;
      this.active = visible;
      if (!visible) {
        this.pause();
        return;
      }
      this.cleanup();
      this.scanTweets(document);
      this.flushCount();
      this.observer = new MutationObserver(records => this.onMutations(records));
      this.observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href'],
      });
      this.checkPerformance();
    }

    scanTweets(root) {
      if (root.matches?.(TWEET)) this.pendingTweets.add(root);
      for (const tweet of root.querySelectorAll(TWEET)) this.pendingTweets.add(tweet);
    }

    onMutations(records) {
      if (!this.active) return;
      let needsCleanup = false;
      for (const record of records) {
        if (record.type === 'childList' && record.addedNodes.length === 0) continue;
        const tweet = record.target.closest?.(TWEET);
        if (tweet) {
          this.pendingTweets.add(tweet);
          needsCleanup = true;
        } else if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) {
              this.scanTweets(node);
              needsCleanup = true;
            }
          }
        }
      }
      if (this.pendingTweets.size && this.countTimer === null) {
        // A fixed deadline also flushes during a continuous stream of mutations.
        this.countTimer = setTimeout(() => {
          this.countTimer = null;
          this.flushCount();
        }, COUNT_DELAY);
      }
      if (needsCleanup && this.cleanupTimer === null) {
        this.cleanupTimer = setTimeout(() => {
          this.cleanupTimer = null;
          this.cleanup();
        }, CLEANUP_DELAY);
      }
      if (this.performanceTimer === null && this.animationFrame === null) {
        this.schedulePerformanceCheck();
      }
    }

    flushCount() {
      for (const tweet of this.pendingTweets) {
        if (!tweet.isConnected) continue;
        const href = tweet.querySelector('a[href*="/status/"]')?.getAttribute('href') ?? '';
        const id = href.match(/\/status\/(\d+)/)?.[1];
        if (!id) continue;
        this.seenIds.add(id);
        if (this.seenIds.size > 5000) {
          const oldest = this.seenIds.values();
          for (let i = 0; i < 2500; i++) this.seenIds.delete(oldest.next().value);
        }
      }
      this.pendingTweets.clear();
      this.count = Math.max(this.count, this.seenIds.size);
      if (this.lastCount === this.count) return;
      this.lastCount = this.count;
      this.post({ type: 'yomikui-tweet-count', count: this.count });
    }

    cleanup() {
      const removeAfter = (root, selector, keep) => {
        const nodes = root.querySelectorAll(selector);
        for (let i = keep; i < nodes.length; i++) nodes[i].remove();
      };
      for (const id of STYLE_IDS) removeAfter(document, `#${id}`, 1);
      for (const tweet of document.querySelectorAll(TWEET)) {
        for (const [selector, keep] of DUPLICATES) removeAfter(tweet, selector, keep);
      }
    }

    checkPerformance() {
      if (!this.active || this.animationFrame !== null) return;
      if (this.performanceTimer !== null) clearTimeout(this.performanceTimer);
      this.performanceTimer = null;
      const sessionAge = Date.now() - this.startedAt;
      if (sessionAge < MIN_SESSION_AGE) {
        this.setSuggestion(false);
        this.schedulePerformanceCheck(MIN_SESSION_AGE - sessionAge);
        return;
      }
      if (this.getChurn() < MIN_CHURN) {
        this.setSuggestion(false);
        // Further mutations will schedule a check when there is work to assess.
        return;
      }
      // Only sample a one-second window when the other refresh criteria hold.
      let firstFrame = null;
      let frames = 0;
      const sample = timestamp => {
        this.animationFrame = null;
        if (!this.active) return;
        if (firstFrame === null) firstFrame = timestamp;
        else frames++;
        const elapsed = timestamp - firstFrame;
        if (elapsed < 1000) {
          this.animationFrame = requestAnimationFrame(sample);
          return;
        }
        this.fps = frames * 1000 / elapsed;
        this.setSuggestion(this.fps > 0 && this.fps < MIN_FPS && this.getChurn() >= MIN_CHURN);
        this.schedulePerformanceCheck();
      };
      this.animationFrame = requestAnimationFrame(sample);
    }

    schedulePerformanceCheck(delay = PERFORMANCE_DELAY) {
      this.performanceTimer = setTimeout(() => {
        this.performanceTimer = null;
        this.checkPerformance();
      }, delay);
    }

    setSuggestion(suggested) {
      if (this.suggested === suggested) return;
      this.suggested = suggested;
      this.post({
        type: 'yomikui-performance-refresh-suggestion',
        shouldSuggest: suggested,
        fps: Math.round(this.fps),
        churn: this.getChurn(),
        sessionMs: Date.now() - this.startedAt,
      });
    }

    post(message) {
      if (window.parent !== window) {
        window.parent.postMessage({ ...message, columnId: this.getColumnId() }, this.targetOrigin);
      }
    }

    reset() {
      this.startedAt = Date.now();
      this.seenIds.clear();
      this.pendingTweets.clear();
      this.count = 0;
      this.lastCount = -1;
      this.setSuggestion(false);
      this.cancelTimers();
      if (this.active) {
        this.scanTweets(document);
        this.flushCount();
        this.checkPerformance();
      }
    }

    cancelTimers() {
      for (const key of ['countTimer', 'cleanupTimer', 'performanceTimer']) {
        if (this[key] !== null) clearTimeout(this[key]);
        this[key] = null;
      }
      if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    pause() {
      this.observer?.disconnect();
      this.observer = null;
      this.pendingTweets.clear();
      this.cancelTimers();
    }

    dispose() {
      this.started = false;
      this.active = false;
      this.pause();
      this.seenIds.clear();
      document.removeEventListener('visibilitychange', this.syncVisibility);
      window.removeEventListener('yomikui-frame-column-visibility', this.syncVisibility);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    }
  };
})();
