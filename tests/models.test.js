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

test('normalize exposes input capabilities', () => {
  const by = (id) => all.find((m) => m.id === id);
  assert.equal(by('anthropic/claude-sonnet-5').images, true);
  assert.equal(by('anthropic/claude-sonnet-5').files, true);
  assert.equal(by('openai/gpt-6').images, true);
  assert.equal(by('openai/gpt-6').files, false);
  assert.deepEqual(by('deepseek/deepseek-v4').inputs, ['text']);
});

test('filter maxIn/maxOut', () => {
  const withNull = all.concat([Object.assign({}, all[0], { id: 'x/null', priceIn: null, priceOut: null })]);
  const r = M.filter(withNull, { maxIn: 1 });
  assert.ok(r.length > 0 && r.every((m) => m.priceIn != null && m.priceIn <= 1));
  assert.ok(M.filter(withNull, { maxOut: '2' }).every((m) => m.priceOut != null && m.priceOut <= 2));
  assert.deepEqual(ids(M.filter(all, { maxPrice: 2 })), ids(M.filter(all, { maxOut: 2 })));
  assert.equal(M.filter(withNull, { maxIn: '' }).length, withNull.length);
});

test('filter minContext', () => {
  const r = M.filter(all, { minContext: 200000 });
  assert.ok(r.length > 0 && r.every((m) => m.context >= 200000));
  assert.equal(M.filter(all, { minContext: '200000' }).length, r.length);
});

test('filter images/files', () => {
  assert.deepEqual(ids(M.filter(all, { images: true })).sort(), ['anthropic/claude-sonnet-5', 'google/gemini-3-pro', 'meta-llama/llama-5-405b', 'openai/gpt-6']);
  assert.deepEqual(ids(M.filter(all, { files: true })).sort(), ['anthropic/claude-sonnet-5', 'google/gemini-3-pro']);
});

test('activeFilterCount', () => {
  assert.equal(M.activeFilterCount({ maxIn: 1, images: true, files: false, minContext: '' }), 2);
  assert.equal(M.activeFilterCount(undefined), 0);
});

test('normalize flags router models by negative price and keeps a short desc', () => {
  const [m] = M.normalize([{ id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' }, description: 'Picks a model. More text here.' }]);
  assert.equal(m.router, true); assert.equal(m.desc, 'Picks a model.');
});

test('normalize desc: no description, no period, and 160-char cut', () => {
  const [a, b, c, d] = M.normalize([
    { id: 'a/a', pricing: { prompt: '0.000001' } },
    { id: 'a/b', pricing: { prompt: '0.000001' }, description: '  No terminator here  ' },
    { id: 'a/c', pricing: { prompt: '0.000001' }, description: 'x'.repeat(300) + '. Next.' },
    { id: 'a/d', pricing: { prompt: '0.000001' }, description: 'Version 1.5 is great! Really.' }]);
  assert.equal(a.desc, ''); assert.equal(a.router, false);
  assert.equal(b.desc, 'No terminator here');
  assert.equal(c.desc.length, 160);
  assert.equal(d.desc, 'Version 1.5 is great!');
});

test('normalizeDeciders keeps decision models with inputs and free flag', () => {
  const d = M.normalizeDeciders([
    { id: 'baseten/mammoth-1:free', name: 'Baseten: Mammoth', context_length: 16384, pricing: { prompt: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['decisions'] } },
    { id: 'liquid/d1-ultra', name: 'LiquidAI: d1-ultra', context_length: 32768, pricing: { prompt: '0.000000042' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['decisions'] } },
    { id: 'openai/gpt-6', architecture: { output_modalities: ['text'] } }]);
  assert.deepEqual(d.map((x) => [x.id, x.free, x.images, x.context]), [['baseten/mammoth-1:free', true, false, 16384], ['liquid/d1-ultra', false, true, 32768]]);
  assert.equal(d[1].priceIn, 0.042);
});

test('loadDeciders caches for 24 h, refetches when stale, falls back to stale cache, then none', async () => {
  const raw = [{ id: 'liquid/d1-ultra', name: 'D1', context_length: 32768, pricing: { prompt: '0.000000042' }, architecture: { input_modalities: ['text'], output_modalities: ['decisions'] } }];
  const fail = async () => { throw new Error('offline'); };
  const ls = memoryStorage();
  ls.setItem('mc.decidersCache', JSON.stringify({ fetchedAt: NOW - 1000, raw }));
  let fetched = 0;
  const r1 = await M.loadDeciders({ ls, now: NOW, fetchDecidersFn: async () => { fetched++; return []; } });
  assert.equal(fetched, 0); assert.equal(r1.source, 'cache'); assert.equal(r1.stale, false);
  assert.deepEqual(r1.deciders.map((x) => x.id), ['liquid/d1-ultra']);

  ls.setItem('mc.decidersCache', JSON.stringify({ fetchedAt: NOW - 25 * 3600e3, raw: [] }));
  const r2 = await M.loadDeciders({ ls, now: NOW, fetchDecidersFn: async () => raw });
  assert.equal(r2.source, 'network'); assert.equal(r2.stale, false); assert.equal(r2.deciders.length, 1);
  assert.equal(JSON.parse(ls.getItem('mc.decidersCache')).fetchedAt, NOW);

  ls.setItem('mc.decidersCache', JSON.stringify({ fetchedAt: NOW - 99 * 3600e3, raw }));
  const r3 = await M.loadDeciders({ ls, now: NOW, fetchDecidersFn: fail });
  assert.equal(r3.source, 'cache'); assert.equal(r3.stale, true); assert.equal(r3.deciders.length, 1);

  const r4 = await M.loadDeciders({ ls: memoryStorage(), now: NOW, fetchDecidersFn: fail });
  assert.deepEqual(r4, { deciders: [], stale: true, source: 'none' });
});
