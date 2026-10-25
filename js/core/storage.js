/* MC.storage — settings + API key in localStorage, conversations in IndexedDB
   (with a localStorage fallback when IndexedDB is unavailable). */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.storage = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const K_SETTINGS = 'mc.settings';
  const K_KEY = 'mc.apiKey';
  const K_CONVS = 'mc.conversations';

  const DEFAULT_SETTINGS = Object.freeze({
    selected: [],
    summaryModel: null,
    fusionModel: null,
    autoTldr: false,
    autoFusion: false,
    theme: 'system',
    rememberKey: true,
  });

  function normalizeKey(raw) {
    return String(raw || '').trim().replace(/^Bearer\s+/i, '').replace(/\s+/g, '');
  }

  function readJson(ls, key, fallback) {
    try {
      const v = ls && ls.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(ls, key, value) {
    try { ls && ls.setItem(key, JSON.stringify(value)); } catch (e) { /* quota or disabled */ }
  }

  function createSettings(ls = globalThis.localStorage) {
    let memKey = null;
    return {
      get() {
        const stored = readJson(ls, K_SETTINGS, {});
        return Object.assign({}, DEFAULT_SETTINGS, stored && typeof stored === 'object' ? stored : {});
      },
      set(patch) {
        const next = Object.assign(this.get(), patch);
        writeJson(ls, K_SETTINGS, next);
        return next;
      },
      getKey() {
        if (memKey != null) return memKey;
        try { return (ls && ls.getItem(K_KEY)) || ''; } catch (e) { return ''; }
      },
      setKey(k, remember) {
        const key = normalizeKey(k);
        memKey = key;
        try {
          if (remember && key) ls.setItem(K_KEY, key);
          else ls.removeItem(K_KEY);
        } catch (e) { /* ignore */ }
      },
      clearAll() {
        memKey = null;
        try {
          const keys = [];
          for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
          keys.filter((k) => k && k.startsWith('mc.')).forEach((k) => ls.removeItem(k));
        } catch (e) { /* ignore */ }
      },
    };
  }

  function meta(c) {
    const m = { id: c.id, title: c.title, updatedAt: c.updatedAt };
    if (c.parentId) { m.parentId = c.parentId; m.forkedAtTurn = c.forkedAtTurn; }
    return m;
  }

  function byUpdatedDesc(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }

  function localStore(ls) {
    const read = () => readJson(ls, K_CONVS, {}) || {};
    return {
      kind: 'local',
      async list() { return Object.values(read()).map(meta).sort(byUpdatedDesc); },
      async get(id) { return read()[id]; },
      async put(conv) { const all = read(); all[conv.id] = conv; writeJson(ls, K_CONVS, all); },
      async delete(id) { const all = read(); delete all[id]; writeJson(ls, K_CONVS, all); },
      async all() { return Object.values(read()); },
    };
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbStore(db) {
    const tx = (mode) => db.transaction('conversations', mode).objectStore('conversations');
    return {
      kind: 'idb',
      async list() { return (await idbRequest(tx('readonly').getAll())).map(meta).sort(byUpdatedDesc); },
      async get(id) { return idbRequest(tx('readonly').get(id)); },
      async put(conv) { await idbRequest(tx('readwrite').put(conv)); },
      async delete(id) { await idbRequest(tx('readwrite').delete(id)); },
      async all() { return idbRequest(tx('readonly').getAll()); },
    };
  }

  function openIdb(idb) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = idb.open('multaichat', 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversations')) {
          const os = db.createObjectStore('conversations', { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  async function openStore({ idb = globalThis.indexedDB, ls = globalThis.localStorage } = {}) {
    if (idb) {
      try { return idbStore(await openIdb(idb)); } catch (e) { /* fall through */ }
    }
    return localStore(ls);
  }

  function exportJson(convs) {
    return JSON.stringify({ app: 'multaichat', version: 1, exportedAt: Date.now(), conversations: convs }, null, 2);
  }

  function importJson(text, existing) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { obj = null; }
    if (!obj || obj.app !== 'multaichat' || !Array.isArray(obj.conversations)) {
      throw new Error('Not a Multaichat export');
    }
    const map = new Map((existing || []).map((c) => [c.id, c]));
    for (const c of obj.conversations) {
      if (!c || !c.id) continue;
      const cur = map.get(c.id);
      if (!cur || (c.updatedAt || 0) > (cur.updatedAt || 0)) map.set(c.id, c);
    }
    return [...map.values()];
  }

  return { DEFAULT_SETTINGS, normalizeKey, createSettings, openStore, exportJson, importJson };
});
