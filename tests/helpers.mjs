import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const settle = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class Clock {
  now = 0;
  nextId = 1;
  timers = new Map();
  frames = new Map();
  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  requestAnimationFrame = callback => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };
  cancelAnimationFrame = id => this.frames.delete(id);
  async advance(ms) {
    const until = this.now + ms;
    for (let turns = 0; ; turns++) {
      if (turns > 10000) throw new Error('Runaway timers');
      const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.now = until;
    await settle();
  }
  frame(ms) {
    this.now += ms;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(this.now);
  }
  globals() {
    const clock = this;
    return {
      Date: class extends Date { static now() { return clock.now; } },
      setTimeout: this.setTimeout,
      clearTimeout: this.clearTimeout,
      requestAnimationFrame: this.requestAnimationFrame,
      cancelAnimationFrame: this.cancelAnimationFrame,
    };
  }
}

export class Events {
  listeners = new Map();
  addEventListener(type, callback, options = {}) {
    const list = this.listeners.get(type) ?? [];
    list.push({ callback, once: options.once });
    this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.callback !== callback));
  }
  dispatchEvent(event) {
    for (const entry of [...this.listeners.get(event.type) ?? []]) {
      if (entry.once) this.removeEventListener(event.type, entry.callback);
      entry.callback.call(this, event);
    }
    return true;
  }
  emit(type, values = {}) { this.dispatchEvent({ type, ...values }); }
}

export class Element extends Events {
  nodeType = 1;
  children = [];
  parentElement = null;
  constructor(tagName = 'div', attributes = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
  }
  get id() { return this.attributes.id ?? ''; }
  set id(value) { this.attributes.id = value; }
  get childElementCount() { return this.children.length; }
  get isConnected() { return this.nodeType === 9 || !!this.parentElement?.isConnected; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('#')) return this.id === part.slice(1);
      if (part.startsWith('.')) return (this.attributes.class ?? '').split(' ').includes(part.slice(1));
      const match = part.match(/^([\w-]+)(?:\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)")?\])?$/);
      if (!match || this.tagName !== match[1].toUpperCase()) return false;
      if (!match[2]) return true;
      const value = this.getAttribute(match[2]);
      if (value === null) return false;
      if (match[3] === '^=') return value.startsWith(match[4]);
      if (match[3] === '*=') return value.includes(match[4]);
      return match[3] ? value === match[4] : true;
    });
  }
  closest(selector) {
    for (let element = this; element; element = element.parentElement) if (element.matches(selector)) return element;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = element => {
      for (const child of element.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  cloneNode(deep) {
    const copy = new Element(this.tagName, this.attributes);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

export function browserEnvironment() {
  const clock = new Clock();
  const messages = [];
  const document = new Element('document');
  document.nodeType = 9;
  document.hidden = false;
  document.readyState = 'loading';
  document.documentQueries = 0;
  const queryAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => { document.documentQueries++; return queryAll(selector); };
  document.documentElement = document.appendChild(new Element('html'));
  document.body = document.documentElement.appendChild(new Element('body'));
  document.getElementById = id => queryAll(`#${id}`)[0] ?? null;
  document.createElement = tag => new Element(tag);
  const window = new Events();
  window.self = window;
  window.top = {};
  window.parent = { postMessage: (message, origin) => messages.push({ ...message, origin }) };
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe(target, options) { this.connected = true; this.target = target; this.options = options; }
    disconnect() { this.connected = false; }
    emit(records) { if (this.connected) this.callback(records); }
  }
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const context = vm.createContext({
    ...clock.globals(), window, document, MutationObserver, CustomEvent, URL,
    console: { warn() {}, log() {}, error() {} },
  });
  return { clock, messages, document, window, context, observers };
}

export function evaluate(context, filename, transform = source => source) {
  const source = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
  return vm.runInContext(transform(source), context, { filename });
}

export function tweet(id) {
  const node = new Element('article', { 'data-testid': 'tweet' });
  node.appendChild(new Element('a', { href: `/someone/status/${id}` }));
  return node;
}

export function hook() {
  const callbacks = [];
  return {
    callbacks,
    addListener: (...args) => callbacks.push(args[0]),
    emit: (...args) => callbacks.forEach(callback => callback(...args)),
  };
}

export function downloadEnvironment() {
  const env = browserEnvironment();
  const snapshots = new Map();
  const searches = [];
  const sends = [];
  let nextId = 1;
  let tabQueries = 0;
  const api = {
    downloads: {
      onChanged: hook(),
      download: async () => nextId++,
      search: async ({ id }) => { searches.push(id); return snapshots.has(id) ? [{ ...snapshots.get(id) }] : []; },
    },
    tabs: {
      query: async () => { tabQueries++; return [{ id: 1 }, { id: 2 }]; },
      sendMessage: async (id, message) => sends.push({ id, message: JSON.parse(JSON.stringify(message)) }),
    },
  };
  evaluate(env.context, 'downloadManager.js', source => source.replace('export class DownloadManager', 'globalThis.DownloadManager = class DownloadManager'));
  const manager = new env.context.DownloadManager(api);
  return { ...env, api, manager, searches, sends, snapshots, get tabQueries() { return tabQueries; } };
}

export const media = (count = 1) => ({
  tweetId: '123', screenName: 'someone', videos: [],
  images: Array.from({ length: count }, (_, index) => ({ index, url: `https://pbs.twimg.com/media/${index}?format=jpg` })),
});
