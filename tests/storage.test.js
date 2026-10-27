'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { memoryStorage } = require('./helpers');
load('util');
const storage = load('storage');

test('normalizeKey trims, strips Bearer and inner whitespace', () => {
  assert.equal(storage.normalizeKey('  Bearer sk-or-v1-abc\n '), 'sk-or-v1-abc');
  assert.equal(storage.normalizeKey('sk-or-v1-a b\nc'), 'sk-or-v1-abc');
  assert.equal(storage.normalizeKey(''), '');
});

test('settings default when empty or corrupt', () => {
  const ls = memoryStorage();
  const s = storage.createSettings(ls);
  assert.deepEqual(s.get(), storage.DEFAULT_SETTINGS);
  ls.setItem('mc.settings', '{not json');
  assert.deepEqual(storage.createSettings(ls).get(), storage.DEFAULT_SETTINGS);
});

test('settings set merges and persists', () => {
  const ls = memoryStorage();
  storage.createSettings(ls).set({ theme: 'dark' });
  const s = storage.createSettings(ls).get();
  assert.equal(s.theme, 'dark');
  assert.equal(s.autoTldr, false);
});

test('setKey without remember keeps key in memory only', () => {
  const ls = memoryStorage();
  const s = storage.createSettings(ls);
  s.setKey('k', false);
  assert.equal(ls.getItem('mc.apiKey'), null);
  assert.equal(s.getKey(), 'k');
  s.setKey(' Bearer k2 ', true);
  assert.equal(ls.getItem('mc.apiKey'), 'k2');
  assert.equal(storage.createSettings(ls).getKey(), 'k2');
});

test('clearAll removes all mc.* keys only', () => {
  const ls = memoryStorage();
  const s = storage.createSettings(ls);
  s.set({ theme: 'dark' });
  s.setKey('k', true);
  ls.setItem('other', 'x');
  s.clearAll();
  assert.deepEqual([...ls._map.keys()], ['other']);
  assert.equal(s.getKey(), '');
});

test('fallback store: no indexedDB uses localStorage', async () => {
  const ls = memoryStorage();
  const store = await storage.openStore({ idb: undefined, ls });
  assert.equal(store.kind, 'local');
  await store.put({ id: 'a', title: 'A', updatedAt: 1, lanes: [], turns: [] });
  await store.put({ id: 'b', title: 'B', updatedAt: 2, parentId: 'a', forkedAtTurn: 0, lanes: [], turns: [] });
  assert.equal((await store.get('a')).title, 'A');
  const list = await store.list();
  assert.deepEqual(list.map((m) => m.id), ['b', 'a']);
  assert.deepEqual(list[0], { id: 'b', title: 'B', updatedAt: 2, parentId: 'a', forkedAtTurn: 0 });
  await store.delete('a');
  assert.equal(await store.get('a'), undefined);
  assert.equal((await store.all()).length, 1);
});

test('fallback store: indexedDB open failure uses localStorage', async () => {
  const idb = { open() { const req = {}; setTimeout(() => req.onerror && req.onerror(new Error('denied'))); return req; } };
  const store = await storage.openStore({ idb, ls: memoryStorage() });
  assert.equal(store.kind, 'local');
});

test('exportJson has app marker and no apiKey', () => {
  const text = storage.exportJson([{ id: 'a', updatedAt: 1 }]);
  const obj = JSON.parse(text);
  assert.equal(obj.app, 'multaichat');
  assert.equal(obj.version, 2);
  assert.equal(obj.conversations.length, 1);
  assert.ok(!/apiKey/i.test(text));
});

test('importJson merges by id, newer wins', () => {
  const existing = [{ id: 'a', updatedAt: 5, title: 'old-a' }, { id: 'b', updatedAt: 5, title: 'keep-b' }];
  const incoming = storage.exportJson([
    { id: 'a', updatedAt: 9, title: 'new-a' },
    { id: 'b', updatedAt: 1, title: 'stale-b' },
    { id: 'c', updatedAt: 3, title: 'c' },
  ]);
  const merged = storage.importJson(incoming, existing);
  const byId = Object.fromEntries(merged.map((c) => [c.id, c.title]));
  assert.deepEqual(byId, { a: 'new-a', b: 'keep-b', c: 'c' });
});

test('importJson rejects wrong shape', () => {
  assert.throws(() => storage.importJson('{"foo":1}', []), /Not a Multaichat export/);
  assert.throws(() => storage.importJson('nope', []), /Not a Multaichat export/);
});

test('local store put surfaces quota errors', async () => {
  const ls = memoryStorage();
  const store = await storage.openStore({ idb: undefined, ls });
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(store.put({ id: 'a', updatedAt: 1, lanes: [], turns: [] }), /Quota/);
});

test('blocked storage getters do not crash', async () => {
  const desc = (k) => Object.getOwnPropertyDescriptor(globalThis, k);
  const saved = { ls: desc('localStorage'), idb: desc('indexedDB') };
  const boom = { configurable: true, get() { throw new Error('SecurityError'); } };
  Object.defineProperty(globalThis, 'localStorage', boom);
  Object.defineProperty(globalThis, 'indexedDB', boom);
  try {
    const s = storage.createSettings();
    assert.deepEqual(s.get(), storage.DEFAULT_SETTINGS);
    s.setKey('k', true);
    assert.equal(s.getKey(), 'k');
    const store = await storage.openStore();
    assert.equal(store.kind, 'memory');
    await store.put({ id: 'a', title: 'A', updatedAt: 1, lanes: [], turns: [] });
    assert.equal((await store.list()).length, 1);
  } finally {
    for (const [k, d] of [['localStorage', saved.ls], ['indexedDB', saved.idb]]) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
});
