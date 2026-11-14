const POLL_DELAY = 400;
const RETENTION_DELAY = 5000;
const DECK_URLS = ['https://x.com/yomikui*', 'https://twitter.com/yomikui*'];
const MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com', 'x.com'];
const FILE_EXT_RE = /\.([a-zA-Z0-9]+)$/;
const IMAGE_FOLDER = 'Yomikui-images';
const VIDEO_FOLDER = 'Yomikui-videos';
const X_SNOWFLAKE_EPOCH_MS = 1288834974657n;
// Older IDs were sequential and do not encode the publication time.
const FIRST_SNOWFLAKE_TWEET_ID = 29700859247n;
const LAST_SNOWFLAKE_ID = (1n << 63n) - 1n;

function isAllowedUrl(url) {
  try {
    const { hostname } = new URL(url);
    return MEDIA_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function extensionFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('.mp4') || url.includes('video')) return 'mp4';
    return parsed.searchParams.get('format') || parsed.pathname.match(FILE_EXT_RE)?.[1] || 'jpg';
  } catch {
    return 'jpg';
  }
}

function postDateFolder(tweetCreatedAt, tweetId) {
  if (Number.isFinite(tweetCreatedAt)) {
    const date = new Date(tweetCreatedAt);
    if (date.getFullYear() >= 2006 && date.getFullYear() <= 9999) return formatLocalDate(date);
  }

  if (typeof tweetId === 'string' && /^\d{11,19}$/.test(tweetId)) {
    const snowflake = BigInt(tweetId);
    if (snowflake >= FIRST_SNOWFLAKE_TWEET_ID && snowflake <= LAST_SNOWFLAKE_ID) {
      const timestamp = Number((snowflake >> 22n) + X_SNOWFLAKE_EPOCH_MS);
      return formatLocalDate(new Date(timestamp));
    }
  }
  return 'unknown-date';
}

function formatLocalDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function mediaTasks(media) {
  const videos = media.videos;
  const hasVideos = Boolean(videos.length);
  const items = hasVideos ? videos : media.images;
  const folder = hasVideos ? VIDEO_FOLDER : IMAGE_FOLDER;
  const tweetId = media.sourceTweetId ?? media.tweetId;
  const date = postDateFolder(media.tweetCreatedAt, tweetId);
  return items.map(item => {
    const source = item.sourcePost;
    const itemDate = source ? postDateFolder(source.tweetCreatedAt, source.tweetId) : date;
    return {
      url: item.url,
      filename: `${folder}/${itemDate}/${media.screenName}_${media.tweetId}_${hasVideos ? 'v' : ''}${item.index + 1}.${extensionFor(item.url)}`,
    };
  });
}

export class DownloadManager {
  constructor(api, { progressMessageType = 'yomikui-download-progress' } = {}) {
    this.api = api;
    this.progressMessageType = progressMessageType;
    this.items = new Map();
    this.batches = new Map();
    this.activeIds = new Set();
    this.refreshIds = new Set();
    this.dirtyBatches = new Set();
    this.nextFailureId = -1;
    this.pollTimer = null;
    this.pollPromise = null;
    this.broadcastTimer = null;
    this.broadcastPromise = null;
    this.onChanged = delta => this.handleChange(delta);
    api.downloads.onChanged.addListener(this.onChanged);
  }

  start(media, batchId) {
    let batch = this.batches.get(batchId);
    if (!batch) {
      batch = { id: batchId, items: new Map(), pendingStarts: 0, activeCount: 0, cleanupTimer: null };
      this.batches.set(batchId, batch);
    }
    if (batch.cleanupTimer !== null) clearTimeout(batch.cleanupTimer);
    batch.cleanupTimer = null;
    const tasks = mediaTasks(media);
    // Account for every pending start before any one of them can finish.
    batch.pendingStarts += Math.max(1, tasks.length);
    if (!tasks.length) {
      this.recordFailure(batch, media, 'media', 'NO_MEDIA');
      batch.pendingStarts--;
      this.touch(batch);
      return;
    }
    for (const task of tasks) void this.startItem(batch, media, task);
  }

  async startItem(batch, media, task) {
    try {
      if (!isAllowedUrl(task.url)) {
        this.recordFailure(batch, media, task.filename, 'BLOCKED_HOST');
        return;
      }
      const id = await this.api.downloads.download({ url: task.url, filename: task.filename, saveAs: false });
      if (typeof id !== 'number') {
        this.recordFailure(batch, media, task.filename, 'START_FAILED');
        return;
      }
      const item = this.createItem(batch, media, task.filename, id);
      batch.items.set(id, item);
      this.items.set(id, item);
      this.activeIds.add(id);
      batch.activeCount++;
      this.requestPoll(0);
    } catch (error) {
      console.warn('[Yomikui] Download failed:', error);
      this.recordFailure(batch, media, task.filename, String(error));
    } finally {
      batch.pendingStarts--;
      this.touch(batch);
    }
  }

  createItem(batch, media, filename, downloadId) {
    return {
      downloadId,
      batchId: batch.id,
      tweetId: media.tweetId,
      screenName: media.screenName,
      filename: filename.split(/[/\\]/).pop() || filename,
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: -1,
    };
  }

  recordFailure(batch, media, filename, error) {
    const item = this.createItem(batch, media, filename, this.nextFailureId--);
    item.state = 'interrupted';
    item.error = error;
    batch.items.set(item.downloadId, item);
    this.items.set(item.downloadId, item);
  }

  touch(batch) {
    this.dirtyBatches.add(batch.id);
    this.scheduleBroadcast();
    if (batch.pendingStarts || batch.activeCount) return;
    if (batch.cleanupTimer !== null) clearTimeout(batch.cleanupTimer);
    batch.cleanupTimer = setTimeout(() => this.removeBatch(batch), RETENTION_DELAY);
  }

  removeBatch(batch) {
    for (const id of batch.items.keys()) {
      this.items.delete(id);
      this.activeIds.delete(id);
      this.refreshIds.delete(id);
    }
    this.batches.delete(batch.id);
    this.dirtyBatches.delete(batch.id);
    batch.items.clear();
    batch.cleanupTimer = null;
  }

  requestPoll(delay = POLL_DELAY) {
    if (this.pollPromise) return;
    if (this.pollTimer !== null) {
      if (delay !== 0) return;
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  poll() {
    if (this.pollPromise) return this.pollPromise;
    const ids = new Set(this.activeIds);
    for (const id of this.refreshIds) ids.add(id);
    this.refreshIds.clear();
    this.pollPromise = Promise.all(Array.from(ids, async id => {
      try {
        const [snapshot] = await this.api.downloads.search({ id });
        const item = this.items.get(id);
        if (!item) return;
        if (snapshot) this.applySnapshot(item, snapshot);
        else if (item.state === 'in_progress') {
          this.applySnapshot(item, { state: 'interrupted', error: 'DOWNLOAD_NOT_FOUND' });
        }
      } catch (error) {
        console.warn('[Yomikui] Download poll failed:', error);
      }
    })).finally(() => {
      this.pollPromise = null;
      if (this.refreshIds.size) this.requestPoll(0);
      else if (this.activeIds.size) this.requestPoll();
    });
    return this.pollPromise;
  }

  applySnapshot(item, snapshot) {
    // A search that began before a completion event must not undo that event.
    if (item.state !== 'in_progress' && snapshot.state === 'in_progress') return;
    let changed = false;
    const update = (key, value) => {
      if (item[key] === value) return;
      item[key] = value;
      changed = true;
    };
    update('bytesReceived', snapshot.bytesReceived ?? item.bytesReceived);
    const total = snapshot.totalBytes > 0 ? snapshot.totalBytes : snapshot.fileSize > 0 ? snapshot.fileSize : item.totalBytes;
    if (snapshot.state === 'complete' || snapshot.state === 'interrupted') {
      if (item.state === 'in_progress') this.batches.get(item.batchId).activeCount--;
      update('state', snapshot.state);
      this.activeIds.delete(item.downloadId);
      if (total > 0) update('totalBytes', total);
      if (snapshot.state === 'complete' && item.totalBytes > 0) update('bytesReceived', item.totalBytes);
      if (snapshot.state === 'interrupted') update('error', snapshot.error ?? item.error ?? 'UNKNOWN');
    } else if (total > 0) {
      if (item.bytesReceived >= total) update('totalBytes', -1);
      else if (item.totalBytes <= 0 || total >= item.totalBytes) update('totalBytes', total);
    }
    if (changed) this.touch(this.batches.get(item.batchId));
  }

  handleChange(delta) {
    const item = this.items.get(delta.id);
    if (!item) return;
    const terminal = delta.state?.current === 'complete' || delta.state?.current === 'interrupted';
    this.applySnapshot(item, {
      state: delta.state?.current ?? item.state,
      bytesReceived: delta.bytesReceived?.current,
      totalBytes: delta.totalBytes?.current,
      fileSize: delta.fileSize?.current,
      error: delta.error?.current,
    });
    if (terminal) {
      this.refreshIds.add(item.downloadId);
      this.requestPoll(0);
    }
  }

  scheduleBroadcast() {
    if (this.broadcastTimer !== null || this.broadcastPromise) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      void this.broadcast();
    }, 0);
  }

  broadcast() {
    if (this.broadcastPromise) return this.broadcastPromise;
    const messages = [];
    for (const id of this.dirtyBatches) {
      const batch = this.batches.get(id);
      if (!batch?.items.size) continue;
      const first = batch.items.values().next().value;
      messages.push({
        type: this.progressMessageType,
        batchId: id,
        tweetId: first.tweetId,
        screenName: first.screenName,
        items: Array.from(batch.items.values(), item => ({
          downloadId: item.downloadId,
          filename: item.filename,
          state: item.state,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          error: item.error,
        })),
      });
    }
    this.dirtyBatches.clear();
    if (!messages.length) return Promise.resolve();
    // One tab lookup serves every changed batch; unchanged polls send nothing.
    this.broadcastPromise = this.api.tabs.query({ url: DECK_URLS }).then(tabs =>
      Promise.all(tabs.filter(tab => tab.id != null).flatMap(tab => messages.map(message =>
        this.api.tabs.sendMessage(tab.id, message).catch(() => {}),
      ))),
    ).catch(error => {
      console.warn('[Yomikui] Download progress failed:', error);
    }).finally(() => {
      this.broadcastPromise = null;
      if (this.dirtyBatches.size) this.scheduleBroadcast();
    });
    return this.broadcastPromise;
  }
}
