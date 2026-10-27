'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
load('util');
const realApi = load('openrouter');
load('clarify');
load('attach');
const C = load('conversation');
load('fusion');
load('cost');
load('models');
const Router = load('router');
const R = load('runner');

const MODELS = [{ id: 'a/one', name: 'One' }, { id: 'b/two', name: 'Two' }];

function fakeApi(behaviour) {
  const calls = [];
  return {
    calls,
    async streamChat(opts) {
      calls.push(opts);
      return behaviour[opts.model](opts);
    },
    async complete(opts) {
      calls.push(opts);
      return behaviour.complete(opts);
    },
    async decide(opts) {
      calls.push(opts);
      return behaviour.decide(opts);
    },
  };
}

function setup(behaviour, key = 'k') {
  const api = fakeApi(behaviour);
  const saves = [];
  const changes = [];
  const runner = R.createRunner({
    api,
    getKey: () => key,
    save: async (c) => { saves.push(JSON.parse(JSON.stringify(c))); },
    onChange: (c, info) => changes.push(info),
  });
  const conv = C.create(MODELS);
  const [A, B] = conv.lanes.map((l) => l.id);
  return { api, runner, conv, A, B, saves, changes };
}

const ok = (text) => async ({ onDelta }) => { onDelta(text); return { content: text, usage: { promptTokens: 1, completionTokens: 2, cost: 0.001 } }; };

test('one lane failing does not affect the other', async () => {
  const { runner, conv, A, B, saves } = setup({
    'a/one': ok('Hello'),
    'b/two': async ({ onDelta }) => { onDelta('x'); throw new realApi.ApiError(500, 'Upstream died', 'x'); },
  });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'hi'));
  assert.equal(turn.responses[A].status, 'done');
  assert.equal(turn.responses[A].content, 'Hello');
  assert.deepEqual(turn.responses[A].usage, { promptTokens: 1, completionTokens: 2, cost: 0.001 });
  assert.equal(turn.responses[B].status, 'error');
  assert.equal(turn.responses[B].content, 'x');
  assert.equal(turn.responses[B].error, 'Upstream died');
  assert.ok(saves.length >= 2);
  assert.equal(saves[saves.length - 1].turns[0].responses[A].status, 'done');
});

test('messages sent per lane come from buildMessages', async () => {
  const { runner, conv, A, api } = setup({ 'a/one': ok('1'), 'b/two': ok('2') });
  await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q1'));
  await runner.send(conv, 'targeted', { [A]: 'follow up' });
  const last = api.calls[api.calls.length - 1];
  assert.equal(last.model, 'a/one');
  assert.deepEqual(last.messages.map((m) => m.content), ['q1', '1', 'follow up']);
  assert.equal(last.key, 'k');
});

test('stop aborts the lane and marks it stopped', async () => {
  let seenSignal;
  const { runner, conv, A, B } = setup({
    'a/one': ok('fine'),
    'b/two': ({ signal, onDelta }) => new Promise((resolve, reject) => {
      seenSignal = signal;
      onDelta('part');
      signal.addEventListener('abort', () => reject(new realApi.ApiError('aborted', 'Stopped', 'part')));
    }),
  });
  const p = runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'hi'));
  await new Promise((r) => setImmediate(r));
  runner.stop(conv.turns[0].id, B);
  const turn = await p;
  assert.equal(seenSignal.aborted, true);
  assert.equal(turn.responses[B].status, 'stopped');
  assert.equal(turn.responses[B].content, 'part');
  assert.equal(turn.responses[A].status, 'done');
});

test('asking answers are flagged', async () => {
  const { runner, conv, A } = setup({ 'a/one': ok('Sure.\n\nWhat month?'), 'b/two': ok('Done.') });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'plan'));
  assert.equal(turn.responses[A].asksQuestion, true);
  assert.equal(turn.responses[A].question, 'What month?');
});

test('missing key errors every lane without fetching', async () => {
  const { runner, conv, A, api } = setup({ 'a/one': ok('x'), 'b/two': ok('y') }, '');
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'hi'));
  assert.equal(api.calls.length, 0);
  assert.equal(turn.responses[A].status, 'error');
  assert.equal(turn.responses[A].error, 'Add your OpenRouter API key in Settings');
});

test('retry keeps previous version', async () => {
  let n = 0;
  const { runner, conv, A } = setup({ 'a/one': async () => ({ content: 'v' + ++n }), 'b/two': ok('b') });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'hi'));
  await runner.retry(conv, turn.id, A);
  assert.equal(turn.responses[A].content, 'v2');
  assert.equal(turn.responses[A].previous[0].content, 'v1');
});

test('runTldr streams into turn.tldr', async () => {
  const { runner, conv } = setup({ 'a/one': ok('A'), 'b/two': ok('B'), 's/sum': ok('- short') });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await runner.runTldr(conv, turn.id, 's/sum');
  assert.deepEqual({ s: turn.tldr.status, c: turn.tldr.content, m: turn.tldr.modelId }, { s: 'done', c: '- short', m: 's/sum' });
});

test('runFusion stores parsed data, or raw on junk', async () => {
  let reply = JSON.stringify({ overview: 'o', topics: [{ title: 'T', merged: 'm', models: ['a/one'], excerpts: [] }] });
  const { runner, conv, api } = setup({ 'a/one': ok('A'), 'b/two': ok('B'), complete: async () => ({ content: reply }) });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await runner.runFusion(conv, turn.id, 'f/fuse');
  assert.equal(turn.fusion.status, 'done');
  assert.equal(turn.fusion.data.topics[0].title, 'T');
  assert.deepEqual(api.calls[api.calls.length - 1].responseFormat, { type: 'json_object' });
  reply = 'I cannot do JSON';
  await runner.runFusion(conv, turn.id, 'f/fuse');
  assert.equal(turn.fusion.status, 'error');
  assert.equal(turn.fusion.raw, 'I cannot do JSON');
});

test('runTldr stores usage and keeps the replaced cost', async () => {
  const sum = async () => ({ content: '- s', usage: { cost: 0.0001, promptTokens: 5, completionTokens: 2 } });
  const { runner, conv } = setup({ 'a/one': ok('A'), 'b/two': ok('B'), 's/sum': sum });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await runner.runTldr(conv, turn.id, 's/sum');
  assert.equal(turn.tldr.usage.cost, 0.0001);
  assert.equal(turn.spentReplaced, undefined);
  await runner.runTldr(conv, turn.id, 's/sum');
  assert.equal(turn.tldr.usage.cost, 0.0001);
  assert.equal(turn.spentReplaced.derived, 0.0001);
});

test('runFusion stores usage and keeps the replaced cost', async () => {
  let reply = JSON.stringify({ overview: 'o', topics: [{ title: 'T', merged: 'm', models: ['a/one'], excerpts: [] }] });
  const { runner, conv } = setup({ 'a/one': ok('A'), 'b/two': ok('B'), complete: async () => ({ content: reply, usage: { cost: 0.0002 } }) });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await runner.runFusion(conv, turn.id, 'f/fuse');
  assert.equal(turn.fusion.usage.cost, 0.0002);
  reply = 'junk';
  await runner.runFusion(conv, turn.id, 'f/fuse');
  assert.equal(turn.fusion.status, 'error');
  assert.equal(turn.fusion.usage.cost, 0.0002);
  assert.equal(turn.spentReplaced.derived, 0.0002);
});

test('runFusion api error is stored as error', async () => {
  const { runner, conv } = setup({ 'a/one': ok('A'), 'b/two': ok('B'), complete: async () => { throw new realApi.ApiError(402, 'x'); } });
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await runner.runFusion(conv, turn.id, 'f/fuse');
  assert.equal(turn.fusion.status, 'error');
  assert.equal(turn.fusion.error, 'Out of OpenRouter credits');
});

test('isBusy reflects in-flight lanes', async () => {
  let release;
  const { runner, conv } = setup({ 'a/one': () => new Promise((r) => { release = () => r({ content: 'x' }); }), 'b/two': ok('y') });
  const p = runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await new Promise((r) => setImmediate(r));
  assert.equal(runner.isBusy(conv.turns[0].id), true);
  release();
  await p;
  assert.equal(runner.isBusy(conv.turns[0].id), false);
});

test('liveConversation returns the in-flight object, and null after', async () => {
  let release;
  const { runner, conv } = setup({ 'a/one': () => new Promise((r) => { release = () => r({ content: 'x' }); }), 'b/two': ok('y') });
  const p = runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'q'));
  await new Promise((r) => setImmediate(r));
  assert.equal(runner.liveConversation(conv.id), conv);
  assert.equal(runner.isBusy(null, conv.id), true);
  release();
  await p;
  assert.equal(runner.liveConversation(conv.id), null);
  assert.equal(runner.isBusy(null, conv.id), false);
});

test('stopConversation aborts only that conversation', async () => {
  const hang = ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new realApi.ApiError('aborted', 'Stopped'))));
  const s1 = setup({ 'a/one': hang, 'b/two': hang });
  const conv2 = C.create(MODELS);
  const p1 = s1.runner.send(s1.conv, 'broadcast', C.broadcastInputs(s1.conv, 'q'));
  const p2 = s1.runner.send(conv2, 'broadcast', C.broadcastInputs(conv2, 'q'));
  await new Promise((r) => setImmediate(r));
  s1.runner.stopConversation(s1.conv.id);
  const t1 = await p1;
  assert.ok(Object.values(t1.responses).every((r) => r.status === 'stopped'));
  assert.equal(s1.runner.isBusy(null, conv2.id), true);
  s1.runner.stopAll();
  await p2;
});


test('pdf adds file-parser plugin with engine per model', async () => {
  const PDFREF = { id: 'p1', kind: 'pdf', name: 'doc.pdf' };
  const api = fakeApi({ 'a/one': ok('A'), 'b/two': ok('B') });
  let mode = 'auto';
  const runner = R.createRunner({
    api, getKey: () => 'k', save: async () => {},
    loadAttachments: async (ids) => Object.fromEntries(ids.map((id) => [id, 'data:application/pdf;base64,BB'])),
    getModel: (id) => ({ 'a/one': { files: true }, 'b/two': { files: false } })[id],
    getPdfMode: () => mode,
  });
  const conv = C.create(MODELS);
  const [A, B] = conv.lanes.map((l) => l.id);
  const extra = { attachments: [PDFREF], delivery: { [A]: 'full', [B]: 'full' } };
  await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'Read'), extra);
  const engine = (m) => api.calls.filter((c) => c.model === m).pop().plugins[0].pdf.engine;
  assert.equal(engine('a/one'), 'native');
  assert.equal(engine('b/two'), 'pdf-text');
  const call = api.calls.find((c) => c.model === 'b/two');
  assert.equal(call.messages[0].content[1].file.file_data, 'data:application/pdf;base64,BB');
  mode = 'ocr';
  await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'Again'));
  assert.equal(engine('b/two'), 'mistral-ocr', 'earlier PDF in history still needs the plugin');
});

test('requests without PDFs carry no plugins; skipped lanes get no request', async () => {
  const { runner, conv, A, B, api } = setup({ 'a/one': ok('A'), 'b/two': ok('B') });
  const IMGREF = { id: 'i1', kind: 'image', name: 'tiny.png' };
  await runner.send(conv, 'broadcast', { [A]: 'Look' }, { attachments: [IMGREF], delivery: { [A]: 'full' }, skipped: { [B]: "can't read images" } });
  assert.deepEqual(api.calls.map((c) => c.model), ['a/one']);
  assert.equal(api.calls[0].plugins, undefined);
  assert.deepEqual(api.calls[0].messages[0].content[1], { type: 'text', text: '[attachment unavailable: tiny.png]' }, 'default loader resolves nothing');
});

// ---- routing (route, judge, native lanes) ----

const mdl = (id, extra) => Object.assign({ id, name: id.toUpperCase(), provider: id.split('/')[0], priceIn: 1, priceOut: 2,
  context: 128000, images: false, files: false, free: false, open: false, created: 1000, desc: '', router: false }, extra);
const CATALOG = [
  mdl('p1/alpha', { images: true, created: 5000 }),
  mdl('p2/bravo', { created: 4000 }),
  mdl('p3/gamma:free', { free: true, priceIn: 0, priceOut: 0, created: 3000 }),
  mdl('p4/delta', { images: true, created: 2000 }),
  mdl('p5/eps:free', { free: true, priceIn: 0, priceOut: 0, created: 1000 }),
  mdl('openrouter/auto', { name: 'Auto Router', router: true, priceIn: null, priceOut: null }),
];
const dec = (id, extra) => Object.assign({ id, name: id, provider: id.split('/')[0], priceIn: 1, context: 128000,
  inputs: ['text'], images: false, files: false, free: /:free$/.test(id), desc: '' }, extra);
const PPLX = 'perplexity/pplx-decider-v1.2';
const LIQUID = 'liquid/d1-ultra';
const MAMMOTH = 'baseten/mammoth-1:free';
const STARRED = [LIQUID, PPLX, MAMMOTH];
const PAID_DECIDERS = [dec(LIQUID, { images: true }), dec(PPLX)];
const DECIDERS = PAID_DECIDERS.concat([dec(MAMMOTH, { priceIn: 0 })]);
const IMG = { id: 'i1', kind: 'image', mime: 'image/png', name: 'x.png' };
const IMAGES = { i1: 'data:image/png;base64,AA' };
const hang = () => new Promise(() => {});
const hasImagePart = (state) => state.some((p) => p && typeof p === 'object' && p.type === 'image_url');
const decision = (probs, task = 'code', cost = 0.0005) => ({
  model: 'x', answers: { pick: { choice: Object.keys(probs)[0], probabilities: probs }, task: { choice: task } },
  usage: { inputTokens: 100, cost },
});

function routeSetup(decide, key = 'k') {
  const calls = [];
  const api = { calls, async decide(opts) { calls.push(opts); return decide(opts, calls.length); } };
  const runner = R.createRunner({ api, getKey: () => key, save: async () => {} });
  const go = (opts) => runner.route(Object.assign({
    text: 'Write a sort function', attachments: [], images: {}, settings: { mode: 'auto', count: 2 },
    models: CATALOG, deciders: DECIDERS, starred: STARRED, selection: [], filters: {}, systemPrompt: '', contextNote: '',
  }, opts));
  return { api, calls, runner, go };
}

test('route picks by probability with the default decider', async () => {
  const { calls, go } = routeSetup(async () => decision({ 'p2/bravo': 0.6, 'p4/delta': 0.3, 'p1/alpha': 0.1 }));
  const res = await go({});
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, PPLX, 'the chosen decision model goes first');
  assert.equal(calls[0].key, 'k');
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.ok(calls[0].questions.pick && calls[0].questions.task);
  assert.equal(calls[0].state[0], 'User message:\nWrite a sort function');
  const r = res.route;
  assert.equal(r.mode, 'auto');
  assert.equal(r.count, 2);
  assert.equal(r.method, 'model');
  assert.equal(r.decisionModel, PPLX);
  assert.equal(r.task, 'code');
  assert.deepEqual(r.picks, [{ modelId: 'p2/bravo', p: 0.6 }, { modelId: 'p4/delta', p: 0.3 }]);
  assert.deepEqual(r.candidates, Object.keys(calls[0].questions.pick.criteria));
  assert.ok(!r.candidates.includes('openrouter/auto'));
  assert.deepEqual(r.usage, { inputTokens: 100, cost: 0.0005 });
  assert.equal(r.note, undefined);
  assert.equal(typeof r.ms, 'number');
  assert.ok(r.ms >= 0);
  assert.deepEqual(res.picks.map((m) => m.id), ['p2/bravo', 'p4/delta']);
  assert.equal(res.picks[0].name, 'P2/BRAVO', 'picks are catalog models');
});

test('route with no deciders uses rules', async () => {
  const { calls, go } = routeSetup(async () => { throw new Error('must not be called'); });
  const res = await go({ deciders: [] });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(res.route.method, 'rules');
  assert.equal(res.route.note, 'no decision model available');
  assert.equal(res.route.decisionModel, undefined);
  assert.equal(res.route.usage, undefined);
  assert.equal(res.route.picks.length, 2);
  assert.ok(res.route.picks.every((x) => x.p === null));
  const pool = Router.candidates(CATALOG, { mode: 'auto', pool: 'catalog', selection: [], manualPool: [], filters: {}, attachments: [] }).list;
  assert.deepEqual(res.route.candidates, pool.map((m) => m.id));
  assert.deepEqual(res.route.picks.map((x) => x.modelId), Router.rulesPick(pool, 'auto', 2).map((m) => m.id));
  assert.deepEqual(res.picks.map((m) => m.id), res.route.picks.map((x) => x.modelId));
});

test('route best free without a free decider uses rules and stays free', async () => {
  const { calls, go } = routeSetup(async () => { throw new Error('must not be called'); });
  const res = await go({ deciders: PAID_DECIDERS, settings: { mode: 'free', count: 3 } });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0, 'no paid decision');
  assert.equal(res.route.method, 'rules');
  assert.ok(res.route.note.includes('no free decision model available'), res.route.note);
  assert.ok(res.route.note.includes('only 2 models fit (free)'), res.route.note);
  assert.deepEqual(res.route.picks.map((x) => x.modelId), ['p3/gamma:free', 'p5/eps:free']);
  assert.ok(res.picks.every((m) => m.free));
  // with a free decider, the free one decides
  const s2 = routeSetup(async () => decision({ 'p5/eps:free': 0.7, 'p3/gamma:free': 0.3 }));
  const res2 = await s2.go({ settings: { mode: 'free', count: 2 } });
  assert.equal(s2.calls[0].model, MAMMOTH);
  assert.equal(res2.route.method, 'model');
  assert.deepEqual(res2.route.picks.map((x) => x.modelId), ['p5/eps:free', 'p3/gamma:free']);
});

test('route falls back to the second decider on 429, then to rules', async () => {
  const s1 = routeSetup(async (opts, n) => {
    if (n === 1) throw new realApi.ApiError(429, 'slow down');
    return decision({ 'p1/alpha': 0.9, 'p2/bravo': 0.1 }, 'chat', 0.0002);
  });
  const r1 = await s1.go({});
  assert.deepEqual(s1.calls.map((c) => c.model), [PPLX, LIQUID]);
  assert.equal(r1.route.method, 'model');
  assert.equal(r1.route.decisionModel, LIQUID);
  assert.deepEqual(r1.route.usage, { inputTokens: 100, cost: 0.0002 });

  const s2 = routeSetup(async (opts, n) => {
    if (n === 1) throw new realApi.ApiError(429, 'slow down');
    throw new realApi.ApiError(503, 'Upstream overloaded');
  });
  const r2 = await s2.go({});
  assert.equal(r2.ok, true);
  assert.equal(s2.calls.length, 2, 'at most 2 deciders');
  assert.equal(r2.route.method, 'rules');
  assert.equal(r2.route.note, 'decision failed: Upstream overloaded');
  assert.equal(r2.route.picks.length, 2);
  assert.equal(r2.route.decisionModel, undefined);

  const s3 = routeSetup(async (opts, n) => {
    if (n === 1) throw new realApi.ApiError('network', 'fetch failed');
    throw new realApi.ApiError(500, 'boom');
  });
  const r3 = await s3.go({});
  assert.equal(s3.calls.length, 2, 'network errors fall through too');
  assert.equal(r3.route.method, 'rules');
});

test('route retries without images on 413', async () => {
  const { calls, go } = routeSetup(async (opts, n) => {
    if (n === 1) throw new realApi.ApiError(413, 'Payload too large');
    return decision({ 'p4/delta': 0.8, 'p1/alpha': 0.2 }, 'vision', 0.0001);
  });
  const res = await go({ attachments: [IMG], images: IMAGES });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, LIQUID, 'image decider first');
  assert.equal(calls[1].model, LIQUID, 'same decider retried');
  assert.equal(hasImagePart(calls[0].state), true);
  assert.equal(hasImagePart(calls[1].state), false);
  assert.ok(calls[1].state.includes('[1 image(s) attached]'));
  assert.equal(res.route.method, 'model');
  assert.equal(res.route.decisionModel, LIQUID);
  assert.equal(res.route.note, 'decided without the images');
  assert.deepEqual(res.route.picks.map((x) => x.modelId), ['p4/delta', 'p1/alpha']);
  assert.ok(res.picks.every((m) => m.images), 'pool keeps image models only');

  // a 400 without images in state goes to the next decider instead
  const s2 = routeSetup(async (opts, n) => {
    if (n === 1) throw new realApi.ApiError(400, 'bad');
    return decision({ 'p1/alpha': 1 });
  });
  const r2 = await s2.go({});
  assert.deepEqual(s2.calls.map((c) => c.model), [PPLX, LIQUID]);
  assert.equal(r2.route.note, undefined);
});

test('route returns auth on 401 and credits on 402', async () => {
  const s1 = routeSetup(async () => { throw new realApi.ApiError(401, 'no auth'); });
  assert.deepEqual(await s1.go({}), { ok: false, reason: 'auth', message: 'Invalid API key — check Settings' });
  assert.equal(s1.calls.length, 1, 'no fallback on 401');
  const s2 = routeSetup(async () => { throw new realApi.ApiError(402, 'no money'); });
  assert.deepEqual(await s2.go({}), { ok: false, reason: 'credits', message: 'Out of OpenRouter credits' });
  assert.equal(s2.calls.length, 1, 'no fallback on 402');
  const s3 = routeSetup(async () => { throw new Error('must not be called'); }, '');
  const r3 = await s3.go({});
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'auth');
  assert.equal(r3.message, R.NO_KEY);
});

test('route times out after timeoutMs', async () => {
  const { calls, go } = routeSetup(hang);
  const t0 = Date.now();
  const res = await go({ timeoutMs: 20 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2, 'timeout tries the next decider');
  assert.ok(calls.every((c) => c.signal.aborted), 'timed-out requests are aborted');
  assert.equal(res.route.method, 'rules');
  assert.equal(res.route.note, 'decision failed: timed out');
});

test('route aborted by signal', async () => {
  const ctrl = new AbortController();
  const { calls, go } = routeSetup(hang);
  const p = go({ signal: ctrl.signal, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  ctrl.abort();
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'aborted');
  assert.equal(calls.length, 1, 'no fallback after Stop');
  assert.equal(calls[0].signal.aborted, true);
  // already aborted before the call
  const s2 = routeSetup(async () => { throw new Error('must not be called'); });
  const pre = new AbortController();
  pre.abort();
  const r2 = await s2.go({ signal: pre.signal });
  assert.equal(r2.reason, 'aborted');
  assert.equal(s2.calls.length, 0);
  // Stop while the first decider fails: no second decider, no rules
  const mid = new AbortController();
  const s3 = routeSetup(async () => { mid.abort(); throw new realApi.ApiError(429, 'slow down'); });
  const r3 = await s3.go({ signal: mid.signal });
  assert.deepEqual(r3, { ok: false, reason: 'aborted', message: 'Stopped' });
  assert.equal(s3.calls.length, 1);
});

test('route native sends no decision and lists candidates', async () => {
  const { calls, go } = routeSetup(async () => { throw new Error('must not be called'); });
  const res = await go({ settings: { mode: 'native', count: 5 } });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(res.route.method, 'native');
  assert.equal(res.route.count, 1);
  assert.deepEqual(res.route.picks, [{ modelId: Router.NATIVE_ID, p: null }]);
  assert.ok(!res.route.candidates.includes(Router.NATIVE_ID));
  assert.equal(res.route.candidates.length, 5);
  assert.equal(res.picks.length, 1);
  assert.equal(res.picks[0].id, 'openrouter/auto');
  assert.equal(res.picks[0].name, 'OpenRouter Auto');
  // at most 100 allowed models, in rule order
  const many = CATALOG.concat(Array.from({ length: 120 }, (_, i) => mdl('q' + i + '/m', { created: 100 + i })));
  const r2 = await go({ settings: { mode: 'native' }, models: many });
  assert.equal(r2.route.candidates.length, 100);
  const pool = Router.candidates(many, { mode: 'native', pool: 'catalog', selection: [], manualPool: [], filters: {}, attachments: [] }).list;
  assert.deepEqual(r2.route.candidates, pool.slice(0, 100).map((m) => m.id));
});

test('route empty pool returns reason empty', async () => {
  const { calls, go } = routeSetup(async () => { throw new Error('must not be called'); });
  const r1 = await go({ filters: { freeOnly: true, images: true } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'empty');
  assert.match(r1.message, /filter/i);
  const r2 = await go({ settings: { mode: 'auto', pool: 'selection' }, selection: [] });
  assert.equal(r2.reason, 'empty');
  assert.match(r2.message, /selection/i);
  const r3 = await go({ settings: { mode: 'free' }, attachments: [IMG], images: IMAGES });
  assert.equal(r3.reason, 'empty');
  assert.match(r3.message, /free/i);
  assert.equal(calls.length, 0);
});

test('native lane request carries auto-router plugin and session_id; servedModel stored', async () => {
  const PDFREF = { id: 'p1', kind: 'pdf', name: 'doc.pdf' };
  let fail = false;
  const api = fakeApi({
    'openrouter/auto': async ({ onDelta }) => {
      if (fail) throw new realApi.ApiError(404, 'No models match your request and model restrictions');
      onDelta('hi');
      return { content: 'hi', usage: { cost: 0.001 }, servedModel: 'p2/bravo' };
    },
    'a/one': async () => ({ content: 'plain', servedModel: 'a/one' }),
  });
  const runner = R.createRunner({
    api, getKey: () => 'k', save: async () => {},
    loadAttachments: async (ids) => Object.fromEntries(ids.map((id) => [id, 'data:application/pdf;base64,BB'])),
  });
  const conv = C.create([{ id: 'openrouter/auto', name: 'OpenRouter Auto' }, { id: 'a/one', name: 'One' }]);
  const [N, A] = conv.lanes.map((l) => l.id);
  const route = { mode: 'native', count: 1, method: 'native', picks: [{ modelId: 'openrouter/auto', p: null }], candidates: ['p1/alpha', 'p2/bravo'], ms: 1 };
  const turn = await runner.send(conv, 'broadcast', { [N]: 'q' }, { route });
  const call = api.calls.find((c) => c.model === 'openrouter/auto');
  assert.deepEqual(call.plugins, [{ id: 'auto-router', allowed_models: ['p1/alpha', 'p2/bravo'] }]);
  assert.deepEqual(call.extraBody, { session_id: conv.id });
  assert.equal(turn.responses[N].servedModel, 'p2/bravo');
  assert.equal(turn.responses[N].status, 'done');

  // with a PDF: file-parser and auto-router side by side
  const t2 = await runner.send(conv, 'broadcast', { [N]: 'read', [A]: 'read' },
    { route, attachments: [PDFREF], delivery: { [N]: 'full', [A]: 'full' } });
  const call2 = api.calls.filter((c) => c.model === 'openrouter/auto').pop();
  assert.deepEqual(call2.plugins.map((p) => p.id), ['file-parser', 'auto-router']);
  assert.deepEqual(call2.plugins[1].allowed_models, ['p1/alpha', 'p2/bravo']);
  const plain = api.calls.filter((c) => c.model === 'a/one').pop();
  assert.equal(plain.extraBody, undefined, 'only the native lane carries session_id');
  assert.deepEqual(plain.plugins.map((p) => p.id), ['file-parser']);
  assert.equal(t2.responses[A].servedModel, undefined);

  // 404 "No models match" gets the friendly error
  fail = true;
  const t3 = await runner.send(conv, 'broadcast', { [N]: 'again' }, { route });
  assert.equal(t3.responses[N].status, 'error');
  assert.equal(t3.responses[N].error, 'No allowed model fits — loosen filters or remove images');
});

test('runJudge stores the winning lane and keeps the replaced cost', async () => {
  let seen;
  let fails = 0;
  const judged = { model: PPLX, answers: { best: { choice: 'b/two', probabilities: { 'a/one': 0.2, 'b/two': 0.8 } } }, usage: { inputTokens: 50, cost: 0.0003 } };
  const s = setup({
    'a/one': ok('Answer A'), 'b/two': ok('Answer B'),
    decide: async (opts) => {
      seen = { status: s.conv.turns[0].judge.status, busy: s.runner.isBusy(s.conv.turns[0].id) };
      if (fails > 0) { fails--; throw new realApi.ApiError(500, 'down'); }
      return judged;
    },
  });
  const { runner, conv, B, api, saves } = s;
  const turn = await runner.send(conv, 'broadcast', C.broadcastInputs(conv, 'Which is best?'));
  const chain = [dec(PPLX), dec(LIQUID)];
  const j = await runner.runJudge(conv, turn.id, chain);
  assert.deepEqual(seen, { status: 'streaming', busy: true });
  assert.equal(runner.isBusy(turn.id), false);
  const call = api.calls[api.calls.length - 1];
  assert.equal(call.model, PPLX);
  assert.equal(call.state[0], 'Question:\nWhich is best?');
  assert.deepEqual(call.questions.best.criteria, { 'a/one': 'One', 'b/two': 'Two' });
  assert.equal(j, turn.judge);
  assert.equal(turn.judge.status, 'done');
  assert.equal(turn.judge.modelId, PPLX);
  assert.equal(turn.judge.laneId, B);
  assert.equal(turn.judge.p, 0.8);
  assert.deepEqual(turn.judge.usage, { inputTokens: 50, cost: 0.0003 });
  assert.equal(typeof turn.judge.createdAt, 'number');
  assert.equal(turn.spentReplaced, undefined);
  assert.equal(saves[saves.length - 1].turns[0].judge.status, 'done');

  // judge again: falls back to the second decider; old cost moves to spentReplaced
  fails = 1;
  await runner.runJudge(conv, turn.id, chain);
  assert.equal(turn.judge.status, 'done');
  assert.equal(turn.judge.modelId, LIQUID);
  assert.equal(turn.spentReplaced.judge, 0.0003);

  // a 402 stops at once and is stored as an error
  fails = 0;
  s.api.decide = async (opts) => { api.calls.push(opts); throw new realApi.ApiError(402, 'x'); };
  const before = api.calls.length;
  await runner.runJudge(conv, turn.id, chain);
  assert.equal(api.calls.length - before, 1);
  assert.equal(turn.judge.status, 'error');
  assert.equal(turn.judge.error, 'Out of OpenRouter credits');
  assert.equal(turn.spentReplaced.judge, 0.0006);

  // fewer than 2 answers → nothing to judge
  const t2 = await runner.send(conv, 'targeted', { [B]: 'only you' });
  assert.equal(await runner.runJudge(conv, t2.id, chain), null);
  assert.equal(t2.judge, undefined);
});
