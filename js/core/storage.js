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
  const K_ATTACH = 'mc.attachments';

  const DEFAULT_SETTINGS = Object.freeze({
    selected: [],
    summaryModel: null,
    fusionModel: null,
    autoTldr: false,
    autoFusion: false,
    theme: 'system',
    rememberKey: true,
    pickerFilters: Object.freeze({ maxIn: '', maxOut: '', minContext: '', images: false, files: false }),
    defaultPresetId: null,
    pdfMode: 'auto',
    chatView: 'rows',
    router: Object.freeze({
      enabled: false,
      mode: 'auto',
      count: 3,
      pool: 'catalog',
      decisionModel: 'perplexity/pplx-decider-v1.2',
      manualPool: Object.freeze([]),
      extras: Object.freeze({ fusion: false, judge: false }),
      preview: false,
      allowPaidInFree: false,
    }),
    starredDeciders: Object.freeze(['liquid/d1-ultra', 'typesafe/jev-1.14', 'inception/mercury-decide',
      'perplexity/pplx-decider-v1.2', 'baseten/mammoth-1:free', 'baseten/elephant-1:free']),
  });

  // Reading localStorage/indexedDB throws when the browser blocks site data.
  function safeGlobal(name) {
    try { return globalThis[name]; } catch (e) { return undefined; }
  }

  function memoryLs() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
      key: (i) => [...m.keys()][i] || null, get length() { return m.size; },
    };
  }

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

  function createSettings(ls = safeGlobal('localStorage') || memoryLs()) {
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

  function refsOf(conv) {
    const ids = new Set();
    for (const t of (conv && conv.turns) || []) for (const a of t.attachments || []) ids.add(a.id);
    return [...ids];
  }

  // Shared by every store kind: delete a conversation and the attachments only
  // it referenced (forks share attachment records with their parent).
  function withAttachmentHelpers(store) {
    store.attachmentsFor = async (ids) => (await Promise.all(ids.map((id) => store.getAttachment(id)))).filter(Boolean);
    store.deleteConversation = async (id) => {
      const conv = await store.get(id);
      await store.delete(id);
      const refs = refsOf(conv);
      if (!refs.length) return;
      const used = new Set((await store.all()).flatMap(refsOf));
      for (const r of refs) if (!used.has(r)) await store.deleteAttachment(r);
    };
    return store;
  }

  function localStore(ls, kind = 'local') {
    const read = (key = K_CONVS) => readJson(ls, key, {}) || {};
    const write = (all, key = K_CONVS) => ls.setItem(key, JSON.stringify(all)); // throws on quota so callers can report it
    return withAttachmentHelpers({
      kind,
      async list() { return Object.values(read()).map(meta).sort(byUpdatedDesc); },
      async get(id) { return read()[id]; },
      async put(conv) { const all = read(); all[conv.id] = conv; write(all); },
      async delete(id) { const all = read(); delete all[id]; write(all); },
      async all() { return Object.values(read()); },
      async getAttachment(id) { return read(K_ATTACH)[id]; },
      async putAttachment(rec) { const all = read(K_ATTACH); all[rec.id] = rec; write(all, K_ATTACH); },
      async deleteAttachment(id) { const all = read(K_ATTACH); delete all[id]; write(all, K_ATTACH); },
      async clearAll() { ls.removeItem(K_CONVS); ls.removeItem(K_ATTACH); },
    });
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Resolves only once the write is committed: quota errors surface as a
  // transaction abort after the request itself has already succeeded.
  function idbWrite(db, names, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, 'readwrite');
      [].concat(names).forEach((n) => fn(t.objectStore(n)));
      t.oncomplete = () => resolve();
      t.onabort = t.onerror = () => reject(t.error || new Error('IndexedDB write failed'));
    });
  }

  function idbStore(db) {
    const tx = (mode, name = 'conversations') => db.transaction(name, mode).objectStore(name);
    return withAttachmentHelpers({
      kind: 'idb',
      async getAttachment(id) { return idbRequest(tx('readonly', 'attachments').get(id)); },
      putAttachment(rec) { return idbWrite(db, 'attachments', (s) => s.put(rec)); },
      deleteAttachment(id) { return idbWrite(db, 'attachments', (s) => s.delete(id)); },
      clearAll() { return idbWrite(db, ['conversations', 'attachments'], (s) => s.clear()); },
      async list() { return (await idbRequest(tx('readonly').getAll())).map(meta).sort(byUpdatedDesc); },
      async get(id) { return idbRequest(tx('readonly').get(id)); },
      async put(conv) { await idbRequest(tx('readwrite').put(conv)); },
      async delete(id) { await idbRequest(tx('readwrite').delete(id)); },
      async all() { return idbRequest(tx('readonly').getAll()); },
    });
  }

  // onBlocked: called when another tab still holds the old version open; the
  // upgrade then waits for that tab instead of failing.
  function openIdb(idb, onBlocked) {
    return new Promise((resolve, reject) => {
      let req;
      // Version 2 adds the attachments store; existing conversations are untouched.
      try { req = idb.open('multaichat', 2); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversations')) {
          const os = db.createObjectStore('conversations', { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Let a newer version of the app in another tab upgrade the database.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => { if (onBlocked) onBlocked(); };
    });
  }

  async function openStore({ idb = safeGlobal('indexedDB'), ls = safeGlobal('localStorage'), onBlocked } = {}) {
    if (idb) {
      try { return idbStore(await openIdb(idb, onBlocked)); } catch (e) { /* fall through */ }
    }
    return ls ? localStore(ls) : localStore(memoryLs(), 'memory');
  }

  function defaultLs() { return safeGlobal('localStorage') || memoryLs(); }

  function exportJson(convs, { attachments = [], presets = [] } = {}) {
    return JSON.stringify({ app: 'multaichat', version: 2, exportedAt: Date.now(), conversations: convs, attachments, presets }, null, 2);
  }

  // Reads a v1 or v2 export.
  function parseImport(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { obj = null; }
    if (!obj || obj.app !== 'multaichat' || !Array.isArray(obj.conversations)) {
      throw new Error('Not a Multaichat export');
    }
    return {
      conversations: obj.conversations,
      attachments: Array.isArray(obj.attachments) ? obj.attachments.filter((a) => MC.attach && MC.attach.validRecord(a)) : [],
      presets: Array.isArray(obj.presets) ? obj.presets : [],
    };
  }

  function importJson(text, existing) {
    const { conversations } = parseImport(text);
    const map = new Map((existing || []).map((c) => [c.id, c]));
    for (const c of conversations) {
      if (!c || !c.id) continue;
      const cur = map.get(c.id);
      if (!cur || (c.updatedAt || 0) > (cur.updatedAt || 0)) map.set(c.id, c);
    }
    return [...map.values()];
  }

  return { DEFAULT_SETTINGS, normalizeKey, createSettings, defaultLs, openStore, refsOf, exportJson, parseImport, importJson };
});
