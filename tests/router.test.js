'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const fixture = require('./fixtures/models.json');
load('util');
const M = load('models');
const Router = load('router');

const NOW = fixture.now;
const models = M.normalize(fixture.data.concat([{ id: 'openrouter/auto', pricing: { prompt: '-1' } }]));
const byId = (id) => models.find((m) => m.id === id);
const ids = (list) => list.map((m) => m.id);
const base = { mode: 'auto', pool: 'catalog', selection: [], manualPool: [], filters: {}, attachments: [] };
const cand = (opts) => Router.candidates(models, Object.assign({}, base, opts));

const decider = (id, extra) => Object.assign({ id, name: id, provider: id.split('/')[0], priceIn: 1, context: 128000,
  inputs: ['text'], images: false, files: false, free: /:free$/.test(id), desc: '' }, extra);
const STARRED = ['liquid/d1-ultra', 'typesafe/jev-1.14', 'inception/mercury-decide', 'perplexity/pplx-decider-v1.2',
  'baseten/mammoth-1:free', 'baseten/elephant-1:free'];
const DECIDERS = [
  decider('liquid/d1-ultra', { images: true }),
  decider('typesafe/jev-1.14', { images: true }),
  decider('inception/mercury-decide'),
  decider('perplexity/pplx-decider-v1.2'),
  decider('baseten/mammoth-1:free', { priceIn: 0 }),
  decider('baseten/elephant-1:free', { priceIn: 0 }),
  decider('other/free-decide', { priceIn: 0, free: true }),
  decider('upstage/solar-decide'),
];
const chain = (opts) => ids(Router.chooseDecider(DECIDERS, Object.assign({ mode: 'auto', decisionModel: Router.DEFAULT_DECIDER,
  starred: STARRED, allowPaidInFree: false, hasImages: false }, opts)));

test('constants', () => {
  assert.deepEqual(Router.MODES, ['auto', 'free', 'diverse', 'best', 'manual', 'native']);
  assert.equal(Router.NATIVE_ID, 'openrouter/auto');
  assert.equal(Router.DEFAULT_DECIDER, 'perplexity/pplx-decider-v1.2');
  assert.equal(Router.FREE_DECIDER, 'baseten/mammoth-1:free');
  assert.equal(Router.GOAL.auto, 'Which model will give the best answer to the user message, balancing answer quality against price?');
  assert.equal(Router.GOAL.manual, Router.GOAL.auto);
  assert.deepEqual(Object.keys(Router.TASKS), ['code', 'math', 'writing', 'analysis', 'research', 'chat', 'vision']);
});

test('candidates catalog excludes router, preview and embed models', () => {
  const r = cand({});
  const got = ids(r.list);
  assert.ok(got.length > 10);
  assert.ok(!got.includes('openrouter/auto'));
  assert.ok(!got.some((id) => /-preview|embed|guard|-exp/.test(id)));
  assert.ok(got.includes('anthropic/claude-sonnet-5'));
  assert.equal(r.reason, null);
  assert.equal(M.EXCLUDE.test('anthropic/claude-opus-6-preview'), true);
});

test('candidates applies picker filters', () => {
  const r = cand({ filters: { maxOut: 5 } });
  assert.ok(r.list.length);
  assert.ok(r.list.every((m) => m.priceOut != null && m.priceOut <= 5));
  assert.ok(!ids(r.list).includes('anthropic/claude-sonnet-5'));
  assert.equal(r.reason, 'filters');
  const none = cand({ filters: { maxOut: 0.0001, minContext: 10000000 } });
  assert.deepEqual(none, { list: [], reason: 'filters' });
  assert.equal(cand({ filters: { maxIn: '', maxOut: '', minContext: '', images: false, files: false } }).reason, null);
});

test('candidates with an image keeps only image models', () => {
  const r = Router.candidates(models, { mode: 'auto', pool: 'catalog', filters: {}, attachments: [{ kind: 'image' }] });
  assert.ok(r.list.length && r.list.every((m) => m.images));
  assert.deepEqual(ids(r.list).sort(), ['anthropic/claude-sonnet-5', 'google/gemini-3-pro', 'meta-llama/llama-5-405b', 'openai/gpt-6']);
  assert.equal(r.reason, 'images');
  const free = cand({ mode: 'free', attachments: [{ kind: 'image' }] });
  assert.deepEqual(free, { list: [], reason: 'free' });
});

test('candidates with a PDF does not restrict', () => {
  const plain = cand({});
  const pdf = cand({ attachments: [{ kind: 'pdf', name: 'a.pdf', mime: 'application/pdf' }, { kind: 'text', name: 'a.txt' }] });
  assert.deepEqual(ids(pdf.list), ids(plain.list));
  assert.equal(pdf.reason, null);
});

test('candidates free mode keeps only free models; empty → reason free', () => {
  const r = cand({ mode: 'free' });
  assert.deepEqual(ids(r.list).sort(), ['deepseek/deepseek-v4:free', 'google/gemma-4-27b:free',
    'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-200b:free', 'some/zero-price-model']);
  assert.equal(r.reason, 'free');
  const sel = cand({ mode: 'free', pool: 'selection', selection: ['openai/gpt-6', 'x-ai/grok-5'] });
  assert.deepEqual(sel, { list: [], reason: 'free' });
});

test('candidates selection pool uses only selection ids', () => {
  const r = cand({ pool: 'selection', selection: ['x-ai/grok-5', 'openai/gpt-6', 'anthropic/claude-opus-6-preview'] });
  assert.deepEqual(ids(r.list).sort(), ['anthropic/claude-opus-6-preview', 'openai/gpt-6', 'x-ai/grok-5']);
  assert.equal(r.reason, null);
  const gone = cand({ pool: 'selection', selection: ['x-ai/grok-5', 'gone/model'] });
  assert.deepEqual(ids(gone.list), ['x-ai/grok-5']);
  assert.equal(gone.reason, 'selection');
  const img = cand({ pool: 'selection', selection: ['x-ai/grok-5', 'openai/gpt-6'], attachments: [{ kind: 'image' }] });
  assert.deepEqual(ids(img.list), ['openai/gpt-6']);
  assert.equal(img.reason, 'images');
});

test('candidates empty selection reason', () => {
  assert.deepEqual(cand({ pool: 'selection', selection: [] }), { list: [], reason: 'selection' });
  assert.deepEqual(cand({ pool: 'selection', selection: undefined }), { list: [], reason: 'selection' });
  assert.deepEqual(cand({ mode: 'manual', manualPool: [] }), { list: [], reason: 'selection' });
});

test('candidates manual uses manualPool in order', () => {
  const pool = ['qwen/qwen4-coder', 'anthropic/claude-sonnet-5', 'openrouter/auto', 'deepseek/deepseek-v3'];
  const r = cand({ mode: 'manual', pool: 'catalog', manualPool: pool, selection: ['openai/gpt-6'] });
  assert.deepEqual(ids(r.list), ['qwen/qwen4-coder', 'anthropic/claude-sonnet-5', 'deepseek/deepseek-v3']);
  assert.equal(r.reason, null);
  const f = cand({ mode: 'manual', manualPool: pool, filters: { maxOut: 2 } });
  assert.deepEqual(ids(f.list), ['qwen/qwen4-coder', 'deepseek/deepseek-v3']);
  assert.equal(f.reason, 'filters');
});

test('candidates dedupes selection and manualPool ids, first occurrence first', () => {
  const man = cand({ mode: 'manual', manualPool: ['deepseek/deepseek-v3', 'qwen/qwen4-coder', 'deepseek/deepseek-v3'] });
  assert.deepEqual(ids(man.list), ['deepseek/deepseek-v3', 'qwen/qwen4-coder']);
  assert.equal(man.reason, null);
  const sel = cand({ pool: 'selection', selection: ['x-ai/grok-5', 'openai/gpt-6', 'x-ai/grok-5'] });
  assert.equal(ids(sel.list).length, 2);
  assert.deepEqual(ids(sel.list).sort(), ['openai/gpt-6', 'x-ai/grok-5']);
  assert.equal(sel.reason, null);
});

test('candidates are in rule order for the mode', () => {
  const r = cand({ mode: 'best' });
  assert.deepEqual(ids(r.list), ids(Router.rulesPick(r.list, 'best', r.list.length)));
  assert.equal(r.list[0].id, 'x-ai/grok-5');
});

test('rulesPick per mode', () => {
  const list = cand({}).list;
  assert.deepEqual(ids(Router.rulesPick(list, 'auto', 3, NOW)), ['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro']);
  assert.deepEqual(ids(Router.rulesPick(list, 'native', 3, NOW)), ids(Router.rulesPick(list, 'auto', 3, NOW)));
  // auto: after the top picks, newest first
  const auto = Router.rulesPick(list, 'auto', list.length, NOW);
  const top = M.sections(list, NOW).top.length;
  const rest = auto.slice(top);
  assert.ok(rest.every((m, i) => i === 0 || rest[i - 1].created >= m.created));

  const best = Router.rulesPick(list, 'best', list.length, NOW);
  assert.equal(best[0].priceOut, Math.max(...list.map((m) => m.priceOut)));
  assert.ok(best.every((m, i) => i === 0 || best[i - 1].priceOut >= m.priceOut));
  assert.deepEqual(ids(best.slice(0, 3)), ['x-ai/grok-5', 'anthropic/claude-sonnet-5', 'x-ai/grok-4']);

  const free = Router.rulesPick(cand({ mode: 'free' }).list, 'free', 5, NOW);
  assert.deepEqual(ids(free), ['some/zero-price-model', 'deepseek/deepseek-v4:free', 'openai/gpt-oss-200b:free',
    'google/gemma-4-27b:free', 'meta-llama/llama-3.3-70b-instruct:free']);
  // larger context breaks ties
  const tie = [Object.assign({}, byId('google/gemma-4-27b'), { id: 'a/small', context: 1000 }),
    Object.assign({}, byId('google/gemma-4-27b'), { id: 'b/big', context: 9000 })];
  assert.deepEqual(ids(Router.rulesPick(tie, 'free', 2)), ['b/big', 'a/small']);

  const div = Router.rulesPick(list, 'diverse', 6, NOW);
  assert.equal(new Set(div.map((m) => m.provider)).size, 6);
  assert.deepEqual(ids(div.slice(0, 3)), ['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro']);
  assert.equal(Router.rulesPick(list, 'diverse', list.length).length, list.length);

  const manual = [byId('qwen/qwen4-coder'), byId('anthropic/claude-sonnet-5')];
  assert.deepEqual(ids(Router.rulesPick(manual, 'manual', 5)), ['qwen/qwen4-coder', 'anthropic/claude-sonnet-5']);
  assert.equal(Router.rulesPick(list, 'auto', 2).length, 2);
});

test('chooseDecider default chain is chosen then starred', () => {
  assert.deepEqual(chain({}), ['perplexity/pplx-decider-v1.2', 'liquid/d1-ultra']);
  assert.deepEqual(chain({ decisionModel: 'upstage/solar-decide' }), ['upstage/solar-decide', 'liquid/d1-ultra']);
  // starred models missing from the catalog are skipped
  assert.deepEqual(chain({ decisionModel: 'gone/x', starred: ['gone/y', 'inception/mercury-decide', 'liquid/d1-ultra'] }),
    ['inception/mercury-decide', 'liquid/d1-ultra']);
  assert.deepEqual(ids(Router.chooseDecider([], { mode: 'auto', decisionModel: Router.DEFAULT_DECIDER, starred: STARRED })), []);
});

test('chooseDecider free mode: free chosen → mammoth fallback; no free deciders → []', () => {
  assert.deepEqual(chain({ mode: 'free', decisionModel: 'baseten/elephant-1:free' }), ['baseten/elephant-1:free', 'baseten/mammoth-1:free']);
  assert.deepEqual(chain({ mode: 'free' }), ['baseten/mammoth-1:free', 'baseten/elephant-1:free']);
  assert.deepEqual(chain({ mode: 'free', starred: [] }), ['baseten/mammoth-1:free', 'baseten/elephant-1:free']);
  const noMammoth = DECIDERS.filter((d) => !/baseten/.test(d.id));
  assert.deepEqual(ids(Router.chooseDecider(noMammoth, { mode: 'free', decisionModel: Router.DEFAULT_DECIDER, starred: STARRED })),
    ['other/free-decide']);
  const paidOnly = DECIDERS.filter((d) => !d.free);
  assert.deepEqual(ids(Router.chooseDecider(paidOnly, { mode: 'free', decisionModel: Router.DEFAULT_DECIDER, starred: STARRED })), []);
});

test('chooseDecider free mode with allowPaidInFree appends paid', () => {
  const paidOnly = DECIDERS.filter((d) => !d.free);
  assert.deepEqual(ids(Router.chooseDecider(paidOnly, { mode: 'free', decisionModel: Router.DEFAULT_DECIDER, starred: STARRED,
    allowPaidInFree: true })), ['perplexity/pplx-decider-v1.2', 'liquid/d1-ultra']);
  const oneFree = DECIDERS.filter((d) => !d.free || d.id === 'other/free-decide');
  assert.deepEqual(ids(Router.chooseDecider(oneFree, { mode: 'free', decisionModel: Router.DEFAULT_DECIDER, starred: STARRED,
    allowPaidInFree: true })), ['other/free-decide', 'perplexity/pplx-decider-v1.2']);
});

test('chooseDecider free mode keeps free deciders before paid ones even with images', () => {
  const ds = [decider('baseten/mammoth-1:free', { priceIn: 0 }), decider('baseten/elephant-1:free', { priceIn: 0 }),
    decider('liquid/d1-ultra', { images: true }), decider('typesafe/jev-1.14', { images: true })];
  const got = ids(Router.chooseDecider(ds, { mode: 'free', decisionModel: 'liquid/d1-ultra',
    starred: ['liquid/d1-ultra', 'typesafe/jev-1.14', 'baseten/elephant-1:free'], allowPaidInFree: true, hasImages: true }));
  assert.deepEqual(got, ['baseten/mammoth-1:free', 'baseten/elephant-1:free']);
  // images-first applies within the free group
  const mixed = ds.concat([decider('vis/free-eye:free', { priceIn: 0, images: true })]);
  assert.deepEqual(ids(Router.chooseDecider(mixed, { mode: 'free', decisionModel: Router.DEFAULT_DECIDER, starred: [],
    allowPaidInFree: true, hasImages: true })), ['vis/free-eye:free', 'baseten/mammoth-1:free']);
  // and within the paid group
  const onePaidText = [decider('baseten/mammoth-1:free', { priceIn: 0 }), decider('inception/mercury-decide'),
    decider('liquid/d1-ultra', { images: true })];
  assert.deepEqual(ids(Router.chooseDecider(onePaidText.slice(1), { mode: 'free', decisionModel: 'inception/mercury-decide',
    starred: ['liquid/d1-ultra'], allowPaidInFree: true, hasImages: true })), ['liquid/d1-ultra', 'inception/mercury-decide']);
});

test('chooseDecider puts image deciders first when images are attached', () => {
  assert.deepEqual(chain({ hasImages: true }), ['liquid/d1-ultra', 'typesafe/jev-1.14']);
  assert.deepEqual(chain({ hasImages: true, starred: ['inception/mercury-decide'] }),
    ['perplexity/pplx-decider-v1.2', 'inception/mercury-decide']);
  assert.deepEqual(chain({ hasImages: true, starred: ['inception/mercury-decide', 'typesafe/jev-1.14'] }),
    ['typesafe/jev-1.14', 'perplexity/pplx-decider-v1.2']);
});

const D = decider('perplexity/pplx-decider-v1.2');
const req = (opts) => Router.decisionRequest(Object.assign({ mode: 'auto', candidates: cand({}).list, decider: D, text: 'hi',
  systemPrompt: '', contextNote: '', attachments: [], images: {} }, opts));

test('decisionRequest goal per mode and no prices in best', () => {
  for (const mode of ['auto', 'free', 'diverse', 'best', 'manual']) {
    assert.equal(req({ mode }).questions.pick.instructions, Router.GOAL[mode] + ' Answer with the label of one model.');
  }
  assert.equal(Router.GOAL.free, 'Which of these free models will give the best answer to the user message?');
  assert.equal(Router.GOAL.diverse, 'Which model will give the best answer to the user message? Several different models will be chosen to get different perspectives.');
  assert.equal(Router.GOAL.best, 'Which model will give the highest-quality answer to the user message? Ignore price.');

  const auto = req({});
  assert.equal(auto.questions.pick.type, 'choice');
  assert.deepEqual(Object.keys(auto.questions.pick.criteria), auto.candidateIds);
  assert.deepEqual(auto.candidateIds, ids(cand({}).list));
  assert.equal(auto.questions.pick.criteria['anthropic/claude-sonnet-5'],
    'Anthropic: Claude Sonnet 5 · anthropic · $3/$15 per M · 200k ctx · reads images');
  assert.equal(auto.questions.pick.criteria['google/gemini-3-pro'],
    'Google: Gemini 3 Pro · google · $2/$12 per M · 1M ctx · reads images');
  assert.equal(auto.questions.pick.criteria['openai/gpt-5'], 'OpenAI: GPT-5 · openai · $1.25/$10 per M · 400k ctx');
  assert.equal(auto.questions.task.type, 'choice');
  assert.equal(auto.questions.task.instructions, 'What kind of task is the user message?');
  assert.deepEqual(auto.questions.task.criteria, Router.TASKS);

  const best = req({ mode: 'best' });
  assert.ok(Object.values(best.questions.pick.criteria).every((c) => !c.includes('$') && !c.includes('per M')));
  assert.equal(best.questions.pick.criteria['anthropic/claude-sonnet-5'], 'Anthropic: Claude Sonnet 5 · anthropic · 200k ctx · reads images');

  const withDesc = req({ candidates: [Object.assign({}, byId('openai/gpt-5'), { desc: 'A strong model.' }), byId('x-ai/grok-5')] });
  assert.equal(withDesc.questions.pick.criteria['openai/gpt-5'], 'OpenAI: GPT-5 · openai · $1.25/$10 per M · 400k ctx · A strong model.');
});

test('decisionRequest state: message, system prompt, context note, PDF notes', () => {
  assert.deepEqual(req({ text: 'Q?' }).state, ['User message:\nQ?']);
  const r = req({ text: 'Q?', systemPrompt: 'Be brief.', contextNote: 'We talked about cats.',
    attachments: [{ id: 'p1', kind: 'pdf', name: 'report.pdf', mime: 'application/pdf', size: 10 },
      { id: 't1', kind: 'text', name: 'notes.txt', mime: 'text/plain', size: 10 }],
    textContents: { t1: 'Buy milk.\nCall Bob.' } });
  assert.deepEqual(r.state, ['User message:\nQ?', 'System prompt:\nBe brief.', 'Earlier in this chat:\nWe talked about cats.',
    '[PDF attached: report.pdf]', 'notes.txt:\nBuy milk.\nCall Bob.']);
  // only the first 2000 chars of a text file; files without contents are skipped
  const long = req({ text: 'Q?', attachments: [{ id: 't1', kind: 'text', name: 'a.txt' }, { id: 't2', kind: 'text', name: 'b.txt' }],
    textContents: { t1: 'y'.repeat(5000) } });
  assert.deepEqual(long.state, ['User message:\nQ?', 'a.txt:\n' + 'y'.repeat(2000)]);
});

test('decisionRequest cuts text file excerpts before the message', () => {
  const d = { id: 'baseten/mammoth-1:free', context: 16384, images: false };
  const files = Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, kind: 'text', name: `f${i}.txt` }));
  const textContents = Object.fromEntries(files.map((f) => [f.id, 'z'.repeat(5000)]));
  const r = Router.decisionRequest({ mode: 'auto', candidates: models.slice(0, 5), decider: d, text: 'm'.repeat(3000),
    systemPrompt: 's'.repeat(3000), contextNote: 'n'.repeat(3000), attachments: files, images: {}, textContents });
  assert.ok(JSON.stringify(r.state).length / 4 <= Math.floor(16384 * 0.6) * 0.4);
  assert.equal(r.state[0], 'User message:\n' + 'm'.repeat(3000));
  assert.equal(r.state[1], 'System prompt:\n');
  assert.equal(r.state[2], 'Earlier in this chat:\n');
  const excerpts = r.state.slice(3);
  assert.equal(excerpts.length, 12);
  assert.ok(excerpts.every((p, i) => p.startsWith(`f${i}.txt:\nz`) && p.length < 'f0.txt:\n'.length + 2000));
});

test('decisionRequest sends images only to image deciders with allowed types', () => {
  const att = (id, mime) => ({ id, kind: 'image', name: id, mime, size: 1 });
  const attachments = [att('a', 'image/png'), att('b', 'image/jpeg'), att('c', 'image/webp'), att('d', 'image/gif')];
  const images = { a: 'data:image/png;base64,AA', b: 'data:image/jpeg;base64,BB', c: 'data:image/webp;base64,CC', d: 'data:image/gif;base64,DD' };
  const parts = (r) => r.state.filter((p) => typeof p === 'object');

  const text = req({ attachments, images });
  assert.equal(parts(text).length, 0);
  assert.ok(text.state.includes('[4 image(s) attached]'));

  const vis = req({ attachments, images, decider: decider('liquid/d1-ultra', { images: true }) });
  assert.deepEqual(parts(vis).map((p) => p.image_url.url), [images.a, images.b, images.c]);
  assert.deepEqual(parts(vis)[0], { type: 'image_url', image_url: { url: images.a } });
  assert.ok(vis.state.includes('[1 image(s) attached]'));

  const ts = req({ attachments, images, decider: decider('typesafe/jev-1.14', { images: true }) });
  assert.deepEqual(parts(ts).map((p) => p.image_url.url), [images.a, images.b]);
  assert.ok(ts.state.includes('[2 image(s) attached]'));

  const many = Array.from({ length: 6 }, (_, i) => att('i' + i, 'image/png'));
  const manyImages = Object.fromEntries(many.map((a) => [a.id, 'data:image/png;base64,' + a.id]));
  const capped = req({ attachments: many, images: manyImages, decider: decider('liquid/d1-ultra', { images: true }) });
  assert.equal(parts(capped).length, 4);
  assert.ok(capped.state.includes('[2 image(s) attached]'));

  // no image data → note, not a part
  const missing = req({ attachments: [att('a', 'image/png')], images: {}, decider: decider('liquid/d1-ultra', { images: true }) });
  assert.deepEqual(missing.state, ['User message:\nhi', '[1 image(s) attached]']);
});

test('decisionRequest images use at most half of the state budget; the message stays', () => {
  const att = (id) => ({ id, kind: 'image', name: id, mime: 'image/png', size: 1 });
  const atts = ['a', 'b', 'c', 'd'].map(att);
  const images = Object.fromEntries(atts.map((a) => [a.id, 'data:image/png;base64,' + a.id]));
  const small = { id: 'liquid/d1-small', context: 16384, images: true };
  const r = Router.decisionRequest({ mode: 'auto', candidates: models.slice(0, 5), decider: small, text: 'q'.repeat(20000),
    attachments: atts, images });
  const maxState = Math.floor(16384 * 0.6) * 4 * 0.4;
  const imgs = r.state.filter((p) => typeof p === 'object');
  assert.ok(imgs.length >= 1 && imgs.length * 4000 <= maxState / 2);
  assert.ok(r.state.includes(`[${4 - imgs.length} image(s) attached]`));
  assert.ok(r.state[0].startsWith('User message:\nqqq'));
});

test('decisionRequest cuts long state to budget', () => {
  const big = 'x'.repeat(200000);
  const d = { id: 'baseten/mammoth-1:free', context: 16384, images: false };
  const r = Router.decisionRequest({ mode: 'auto', candidates: models.slice(0, 30), decider: d, text: big, attachments: [], images: {} });
  const chars = JSON.stringify(r.state).length + JSON.stringify(r.questions).length;
  assert.ok(chars / 4 <= 16384 * 0.6);
  assert.ok(r.candidateIds.length >= 2);
  assert.ok(r.state[0].startsWith('User message:\nxxx'));
  assert.ok(JSON.stringify(r.state).length / 4 <= Math.floor(16384 * 0.6) * 0.4);

  // the context note and the system prompt are cut before the message
  const r2 = Router.decisionRequest({ mode: 'auto', candidates: models.slice(0, 5), decider: d, text: 'short question',
    systemPrompt: 's'.repeat(100000), contextNote: 'n'.repeat(100000), attachments: [], images: {} });
  assert.equal(r2.state[0], 'User message:\nshort question');
  assert.ok(JSON.stringify(r2.state).length / 4 <= Math.floor(16384 * 0.6) * 0.4);
});

test('fitToContext trims to fit a 16k decider and returns [] below 2', () => {
  const long = models.map((m) => Object.assign({}, m, { desc: 'd'.repeat(150) }));
  const big = { id: 'x/big', context: 1000000 };
  const small = { id: 'x/small', context: 16384 };
  assert.equal(Router.fitToContext(long, big, 1000).length, 30);
  assert.equal(Router.fitToContext(long.slice(0, 5), big, 1000).length, 5);

  const fit = Router.fitToContext(long, small, 36000);
  assert.ok(fit.length >= 2 && fit.length < 30);
  assert.ok(fit.every((m) => m.desc.length <= 60));
  assert.deepEqual(ids(fit), ids(long.slice(0, fit.length)));
  const q = Router.decisionRequest({ mode: 'auto', candidates: fit, decider: { context: 1e9 }, text: '' }).questions;
  assert.ok(36000 + JSON.stringify(q).length <= Math.floor(16384 * 0.6) * 4);

  assert.deepEqual(Router.fitToContext(long, small, 39000), []);
  assert.deepEqual(Router.fitToContext(long.slice(0, 1), big, 0), []);
});

test('rank orders by probability, ignores unknown labels, fills from rules', () => {
  const rule = cand({}).list;
  const cids = ['openai/gpt-5', 'x-ai/grok-5', 'qwen/qwen4-coder', 'z-ai/glm-5'];
  const answers = { pick: { choice: 'x-ai/grok-5', probabilities: { 'x-ai/grok-5': 0.5, 'qwen/qwen4-coder': 0.3, 'unknown/m': 0.9,
    'anthropic/claude-sonnet-5': 0.8 } } };
  const r = Router.rank(answers, cids, rule, 'auto', 4);
  assert.deepEqual(r.slice(0, 2), [{ modelId: 'x-ai/grok-5', p: 0.5 }, { modelId: 'qwen/qwen4-coder', p: 0.3 }]);
  // filled from rule order with p null, no duplicates
  assert.deepEqual(r.slice(2), [{ modelId: rule[0].id, p: null }, { modelId: rule[1].id, p: null }]);
  // ties keep rule order
  const tie = Router.rank({ pick: { probabilities: { 'z-ai/glm-5': 0.4, 'openai/gpt-5': 0.4 } } }, cids, rule, 'auto', 2);
  const idx = (id) => ids(rule).indexOf(id);
  assert.deepEqual(tie.map((x) => x.modelId), idx('openai/gpt-5') < idx('z-ai/glm-5') ? ['openai/gpt-5', 'z-ai/glm-5'] : ['z-ai/glm-5', 'openai/gpt-5']);
  // no answers at all → rule order
  assert.deepEqual(Router.rank(null, cids, rule, 'auto', 3), rule.slice(0, 3).map((m) => ({ modelId: m.id, p: null })));
  assert.equal(Router.rank(answers, cids, rule.slice(0, 1), 'auto', 8).length, 3);
});

test('rank without probabilities puts the choice first', () => {
  const rule = cand({}).list;
  const cids = ids(rule);
  const r = Router.rank({ pick: { choice: 'qwen/qwen4-coder' } }, cids, rule, 'auto', 3);
  assert.deepEqual(r, [{ modelId: 'qwen/qwen4-coder', p: null }, { modelId: rule[0].id, p: null }, { modelId: rule[1].id, p: null }]);
  const conf = Router.rank({ pick: { choice: 'qwen/qwen4-coder', confidence: 0.7 } }, cids, rule, 'auto', 1);
  assert.deepEqual(conf, [{ modelId: 'qwen/qwen4-coder', p: 0.7 }]);
  const bad = Router.rank({ pick: { choice: 'nope/x' } }, cids, rule, 'auto', 2);
  assert.deepEqual(bad.map((x) => x.modelId), ids(rule.slice(0, 2)));
});

test('rank diverse takes one per provider then fills', () => {
  const rule = cand({}).list;
  const cids = ids(rule);
  const probs = { 'x-ai/grok-5': 0.3, 'x-ai/grok-4': 0.25, 'deepseek/deepseek-v4': 0.2, 'deepseek/deepseek-r2': 0.15, 'openai/gpt-5': 0.1 };
  const r = Router.rank({ pick: { probabilities: probs } }, cids, rule, 'diverse', 3);
  assert.deepEqual(r, [{ modelId: 'x-ai/grok-5', p: 0.3 }, { modelId: 'deepseek/deepseek-v4', p: 0.2 }, { modelId: 'openai/gpt-5', p: 0.1 }]);
  // fewer providers than n → next best of any provider
  const two = Router.rank({ pick: { probabilities: probs } }, ['x-ai/grok-5', 'x-ai/grok-4', 'deepseek/deepseek-v4'],
    [byId('x-ai/grok-5'), byId('x-ai/grok-4'), byId('deepseek/deepseek-v4')], 'diverse', 3);
  assert.deepEqual(two.map((x) => x.modelId), ['x-ai/grok-5', 'deepseek/deepseek-v4', 'x-ai/grok-4']);
  // auto keeps the plain ranking
  assert.deepEqual(Router.rank({ pick: { probabilities: probs } }, cids, rule, 'auto', 2).map((x) => x.modelId), ['x-ai/grok-5', 'x-ai/grok-4']);
});

test('judgeRequest and judgeResult pick the highest-probability answer', () => {
  const answers = [{ modelId: 'x-ai/grok-5', name: 'xAI: Grok 5', content: 'Answer A' },
    { modelId: 'openai/gpt-6', name: 'OpenAI: GPT-6', content: 'Answer B' }];
  const j = Router.judgeRequest({ text: 'Why?', answers, decider: D });
  assert.deepEqual(j.state, ['Question:\nWhy?', 'Answer from x-ai/grok-5:\nAnswer A', 'Answer from openai/gpt-6:\nAnswer B']);
  assert.deepEqual(j.questions, { best: { type: 'choice', instructions: 'Which answer best and most correctly answers the question?',
    criteria: { 'x-ai/grok-5': 'xAI: Grok 5', 'openai/gpt-6': 'OpenAI: GPT-6' } } });

  // long answers are cut so the whole request fits the budget
  const small = { id: 'baseten/mammoth-1:free', context: 16384 };
  const long = answers.map((a) => Object.assign({}, a, { content: 'y'.repeat(100000) }));
  const jl = Router.judgeRequest({ text: 'Why?', answers: long, decider: small });
  assert.ok((JSON.stringify(jl.state).length + JSON.stringify(jl.questions).length) / 4 <= 16384 * 0.6);
  assert.equal(jl.state[0], 'Question:\nWhy?');
  assert.ok(jl.state[1].startsWith('Answer from x-ai/grok-5:\nyyy') && jl.state[2].startsWith('Answer from openai/gpt-6:\nyyy'));
  assert.ok(Math.abs(jl.state[1].length - jl.state[2].length) < 50);

  const lanes = { 'x-ai/grok-5': 'L1', 'openai/gpt-6': 'L2' };
  assert.deepEqual(Router.judgeResult({ best: { choice: 'x-ai/grok-5', probabilities: { 'x-ai/grok-5': 0.3, 'openai/gpt-6': 0.7, 'z/z': 0.9 } } }, lanes),
    { laneId: 'L2', modelId: 'openai/gpt-6', p: 0.7 });
  assert.deepEqual(Router.judgeResult({ best: { choice: 'x-ai/grok-5' } }, lanes), { laneId: 'L1', modelId: 'x-ai/grok-5', p: null });
  assert.equal(Router.judgeResult({ best: { choice: 'z/z' } }, lanes), null);
  assert.equal(Router.judgeResult(null, lanes), null);
});

test('taskOf reads the task choice', () => {
  assert.equal(Router.taskOf({ task: { choice: 'code' } }), 'code');
  assert.equal(Router.taskOf({ task: { choice: 'cooking' } }), null);
  assert.equal(Router.taskOf({ task: { choice: 'toString' } }), null);
  assert.equal(Router.taskOf(null), null);
});

test('withDefaults merges extras and clamps count; native keeps the stored count', () => {
  const DEF = { enabled: false, mode: 'auto', count: 3, pool: 'catalog', decisionModel: 'perplexity/pplx-decider-v1.2',
    manualPool: [], extras: { fusion: false, judge: false }, preview: false, allowPaidInFree: false };
  assert.deepEqual(Router.withDefaults(undefined), DEF);
  assert.deepEqual(Router.withDefaults({}), DEF);
  const s = Router.withDefaults({ enabled: true, mode: 'best', count: 12, extras: { judge: true }, manualPool: ['a/b'] });
  assert.deepEqual(s.extras, { fusion: false, judge: true });
  assert.equal(s.count, 8);
  assert.equal(s.mode, 'best');
  assert.equal(s.enabled, true);
  assert.deepEqual(s.manualPool, ['a/b']);
  assert.equal(Router.withDefaults({ count: 0 }).count, 1);
  assert.equal(Router.withDefaults({ count: 'x' }).count, 3);
  assert.equal(Router.withDefaults({ mode: 'native', count: 5 }).count, 5, 'native clamps to 1 only where used');
  assert.equal(Router.withDefaults({ mode: 'weird' }).mode, 'auto');
  assert.equal(Router.withDefaults({ pool: 'weird' }).pool, 'catalog');
  assert.equal(Router.withDefaults({ pool: 'selection' }).pool, 'selection');
  assert.equal(Router.withDefaults({ decisionModel: '' }).decisionModel, 'perplexity/pplx-decider-v1.2');
  assert.deepEqual(Router.withDefaults({ manualPool: 'nope', extras: null }).manualPool, []);
  // the input is not mutated and results do not share arrays with the defaults
  const a = Router.withDefaults({});
  a.manualPool.push('x');
  assert.deepEqual(Router.withDefaults({}).manualPool, []);
});
