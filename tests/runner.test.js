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
