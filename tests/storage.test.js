'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { memoryStorage } = require('./helpers');
load('util');
load('attach');
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

const rec = (id) => ({ id, kind: 'image', name: id + '.png', mime: 'image/png', size: 3, data: 'data:image/png;base64,AA', createdAt: 1 });
const convWith = (id, ids, extra = {}) => Object.assign({ id, title: id, updatedAt: 1, lanes: [], turns: [{ id: 't', index: 0, inputs: {}, responses: {}, attachments: ids.map((a) => ({ id: a, kind: 'image', name: a })) }] }, extra);

for (const kind of ['local', 'memory']) {
  test(`${kind} store keeps attachment records`, async () => {
    const store = kind === 'local' ? await storage.openStore({ idb: undefined, ls: memoryStorage() }) : await storage.openStore({ idb: undefined, ls: undefined });
    assert.equal(store.kind, kind);
    await store.putAttachment(rec('a1'));
    await store.putAttachment(rec('a2'));
    assert.equal((await store.getAttachment('a1')).name, 'a1.png');
    assert.deepEqual((await store.attachmentsFor(['a2', 'zz', 'a1'])).map((r) => r.id), ['a2', 'a1']);
    await store.deleteAttachment('a1');
    assert.equal(await store.getAttachment('a1'), undefined);
  });
}

test('putAttachment surfaces quota', async () => {
  const ls = memoryStorage();
  const store = await storage.openStore({ idb: undefined, ls });
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(store.putAttachment(rec('a1')), /Quota/);
});

test('deleteConversation keeps attachments shared with a fork', async () => {
  const store = await storage.openStore({ idb: undefined, ls: memoryStorage() });
  await store.putAttachment(rec('a1'));
  await store.putAttachment(rec('a2'));
  await store.put(convWith('A', ['a1', 'a2']));
  await store.put(convWith('B', ['a1'], { parentId: 'A' }));
  await store.deleteConversation('A');
  assert.equal(await store.get('A'), undefined);
  assert.ok(await store.getAttachment('a1'), 'shared attachment kept');
  assert.equal(await store.getAttachment('a2'), undefined, 'unshared attachment removed');
  await store.deleteConversation('B');
  assert.equal(await store.getAttachment('a1'), undefined);
});

test('refsOf lists unique attachment ids', () => {
  const c = convWith('A', ['a1', 'a2']);
  c.turns.push({ id: 't2', index: 1, inputs: {}, responses: {}, attachments: [{ id: 'a1' }] });
  assert.deepEqual(storage.refsOf(c), ['a1', 'a2']);
  assert.deepEqual(storage.refsOf({ turns: [] }), []);
});

test('export v2 carries attachments and presets', () => {
  const obj = JSON.parse(storage.exportJson([convWith('A', ['a1'])], { attachments: [rec('a1')], presets: [{ id: 'p_1', name: 'P' }] }));
  assert.equal(obj.version, 2);
  assert.equal(obj.attachments[0].id, 'a1');
  assert.equal(obj.presets[0].name, 'P');
});

test('parseImport accepts v1 and v2', () => {
  const v1 = JSON.stringify({ app: 'multaichat', version: 1, conversations: [{ id: 'x', updatedAt: 1 }] });
  assert.deepEqual(storage.parseImport(v1), { conversations: [{ id: 'x', updatedAt: 1 }], attachments: [], presets: [] });
  const v2 = storage.exportJson([convWith('A', ['a1'])], { attachments: [rec('a1')], presets: [{ id: 'p_1', name: 'P' }] });
  const r = storage.parseImport(v2);
  assert.equal(r.conversations[0].id, 'A');
  assert.equal(r.attachments[0].data, 'data:image/png;base64,AA');
  assert.equal(r.presets[0].id, 'p_1');
  assert.throws(() => storage.parseImport('{"app":"other"}'), /Not a Multaichat export/);
});

test('parseImport drops unsafe attachment records', () => {
  load('attach');
  const bad = { id: 'evil', kind: 'image', name: 'x.png', data: 'data:text/html;base64,PHNjcmlwdD4=' };
  const good = rec('a1');
  const r = storage.parseImport(storage.exportJson([], { attachments: [bad, good] }));
  assert.deepEqual(r.attachments.map((a) => a.id), ['a1']);
});

test('defaults include router and starred deciders', () => {
  assert.deepEqual(storage.DEFAULT_SETTINGS.router, {
    enabled: false, mode: 'auto', count: 3, pool: 'catalog', decisionModel: 'perplexity/pplx-decider-v1.2',
    manualPool: [], extras: { fusion: false, judge: false }, preview: false, allowPaidInFree: false,
  });
  assert.deepEqual(storage.DEFAULT_SETTINGS.starredDeciders, ['liquid/d1-ultra', 'typesafe/jev-1.14', 'inception/mercury-decide',
    'perplexity/pplx-decider-v1.2', 'baseten/mammoth-1:free', 'baseten/elephant-1:free']);
  assert.deepEqual(storage.createSettings(memoryStorage()).get().router, storage.DEFAULT_SETTINGS.router);
});
