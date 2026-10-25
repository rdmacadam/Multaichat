'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { memoryStorage } = require('./helpers');
const fixture = require('./fixtures/models.json');
load('util');
const M = load('models');
const NOW = fixture.now;
const all = M.normalize(fixture.data);
const ids = (list) => list.map((m) => m.id);

test('normalize drops non-text output and derives fields', () => {
  assert.ok(!ids(all).includes('openai/gpt-image-2'));
  const sonnet = all.find((m) => m.id === 'anthropic/claude-sonnet-5');
  assert.equal(sonnet.provider, 'anthropic');
  assert.equal(sonnet.priceIn, 3);
  assert.equal(sonnet.priceOut, 15);
  assert.equal(sonnet.context, 200000);
  assert.equal(sonnet.open, false);
  assert.equal(sonnet.isNew(NOW), true);
});

test('free = :free suffix or zero price', () => {
  const f = (id) => all.find((m) => m.id === id).free;
  assert.equal(f('deepseek/deepseek-v4:free'), true);
  assert.equal(f('some/zero-price-model'), true);
  assert.equal(f('deepseek/deepseek-v4'), false);
});

test('open = hugging_face_id or open provider', () => {
  const o = (id) => all.find((m) => m.id === id).open;
  assert.equal(o('meta-llama/llama-5-405b'), true);
  assert.equal(o('qwen/qwen4-235b'), true, 'qwen has no HF id but is an open provider');
  assert.equal(o('anthropic/claude-sonnet-5'), false);
  assert.equal(o('cohere/command-a'), false);
});

test('sections.top: newest eligible per flagship provider in order', () => {
  assert.deepEqual(ids(M.sections(all, NOW).top), [
    'anthropic/claude-sonnet-5',
    'openai/gpt-6',
    'google/gemini-3-pro',
    'x-ai/grok-5',
    'deepseek/deepseek-v4',
    'meta-llama/llama-5-405b',
    'mistralai/devstral-3',
    'qwen/qwen4-coder',
  ]);
});

test('sections.free: newest first, includes 8k-context free model', () => {
  assert.deepEqual(ids(M.sections(all, NOW).free), [
    'some/zero-price-model',
    'deepseek/deepseek-v4:free',
    'openai/gpt-oss-200b:free',
    'google/gemma-4-27b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
  ]);
});

test('sections.open: recent open-weight, max 2 per provider, newest first', () => {
  const open = M.sections(all, NOW).open;
  assert.deepEqual(ids(open), [
    'moonshotai/kimi-k3',
    'mistralai/devstral-3',
    'qwen/qwen4-coder',
    'z-ai/glm-5',
    'mistralai/mistral-small-4',
    'deepseek/deepseek-v4',
    'qwen/qwen4-235b',
    'meta-llama/llama-5-405b',
    'openai/gpt-oss-200b',
    'google/gemma-4-27b',
    'deepseek/deepseek-r2',
  ]);
  assert.ok(open.length <= 12);
});

test('sections.all keeps everything text-capable', () => {
  assert.equal(M.sections(all, NOW).all.length, all.length);
});

test('search requires all words', () => {
  assert.deepEqual(ids(M.search(all, 'qwen coder', NOW)), ['qwen/qwen4-coder']);
});

test('search token filters free/open/new', () => {
  assert.deepEqual(ids(M.search(all, 'free llama', NOW)), ['meta-llama/llama-3.3-70b-instruct:free']);
  const openCoder = M.search(all, 'open coder', NOW);
  assert.deepEqual(ids(openCoder), ['qwen/qwen4-coder']);
  assert.ok(M.search(all, 'new', NOW).every((m) => m.isNew(NOW)));
});

test('search ranks word-start matches before newer substring matches', () => {
  const r = ids(M.search(all, 'claude', NOW));
  assert.equal(r[0], 'anthropic/claude-opus-6-preview');
  assert.equal(r[r.length - 1], 'thirdparty/helper-claude-wrap');
  assert.equal(r.length, 4);
});

test('search empty query returns all', () => {
  assert.equal(M.search(all, '  ', NOW).length, all.length);
});

test('sortBy and filter', () => {
  const byPrice = M.sortBy(all, 'price');
  assert.equal(byPrice[0].priceOut, 0);
  const byCtx = M.sortBy(all, 'context');
  assert.equal(byCtx[0].context, 1000000);
  assert.ok(M.filter(all, { freeOnly: true }).every((m) => m.free));
  assert.ok(M.filter(all, { openOnly: true }).every((m) => m.open));
  assert.ok(M.filter(all, { maxPrice: 2 }).every((m) => m.priceOut <= 2));
});

test('loadCached: fresh cache skips fetch', async () => {
  const ls = memoryStorage();
  ls.setItem('mc.modelsCache', JSON.stringify({ fetchedAt: NOW - 1000, raw: fixture.data }));
  let fetched = 0;
  const r = await M.loadCached({ ls, now: NOW, fetchModelsFn: async () => { fetched++; return []; } });
  assert.equal(fetched, 0);
  assert.equal(r.source, 'cache');
  assert.equal(r.stale, false);
  assert.equal(r.models.length, all.length);
});

test('loadCached: stale cache refetches and stores', async () => {
  const ls = memoryStorage();
  ls.setItem('mc.modelsCache', JSON.stringify({ fetchedAt: NOW - 25 * 3600e3, raw: [] }));
  const r = await M.loadCached({ ls, now: NOW, fetchModelsFn: async () => fixture.data });
  assert.equal(r.source, 'network');
  assert.equal(JSON.parse(ls.getItem('mc.modelsCache')).fetchedAt, NOW);
});

test('loadCached: fetch failure falls back to old cache, then built-in list', async () => {
  const ls = memoryStorage();
  ls.setItem('mc.modelsCache', JSON.stringify({ fetchedAt: NOW - 99 * 3600e3, raw: fixture.data }));
  const fail = async () => { throw new Error('offline'); };
  const r1 = await M.loadCached({ ls, now: NOW, fetchModelsFn: fail });
  assert.equal(r1.source, 'cache');
  assert.equal(r1.stale, true);
  const r2 = await M.loadCached({ ls: memoryStorage(), now: NOW, fetchModelsFn: fail });
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.models.length, 5);
});

test('loadCached: corrupt cache is ignored', async () => {
  const ls = memoryStorage();
  ls.setItem('mc.modelsCache', '{bad');
  const r = await M.loadCached({ ls, now: NOW, fetchModelsFn: async () => fixture.data });
  assert.equal(r.source, 'network');
});

test('reconcileSelection drops unknown ids and resets defaults', () => {
  const settings = { selected: ['gone/model', 'anthropic/claude-sonnet-5'], summaryModel: 'gone/x', fusionModel: 'gone/y' };
  const r = M.reconcileSelection(settings, all, NOW);
  assert.deepEqual(r.dropped, ['gone/model']);
  assert.deepEqual(r.settings.selected, ['anthropic/claude-sonnet-5']);
  assert.equal(r.settings.fusionModel, 'anthropic/claude-sonnet-5');
  assert.equal(r.settings.summaryModel, 'deepseek/deepseek-v4');
});

test('reconcileSelection fills empty selection with first 3 top picks', () => {
  const r = M.reconcileSelection({ selected: [], summaryModel: null, fusionModel: null }, all, NOW);
  assert.deepEqual(r.settings.selected, ['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro']);
  assert.deepEqual(r.dropped, []);
});
