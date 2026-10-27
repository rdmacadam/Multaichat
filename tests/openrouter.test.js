'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { sseResponse, jsonResponse, delta } = require('./helpers');
load('util');
const api = load('openrouter');

test('sse parser buffers split lines, ignores comments, emits DONE', () => {
  const events = [];
  const p = api.createSseParser((e) => events.push(e));
  p.push(': OPENROUTER PROCESSING\n\n');
  p.push('data: {"a":');
  p.push('1}\n\ndata: [DONE]\n\n');
  p.end();
  assert.deepEqual(events, [{ a: 1 }, '[DONE]']);
});

test('sse parser ignores unparsable payloads', () => {
  const events = [];
  const p = api.createSseParser((e) => events.push(e));
  p.push('data: {oops\n');
  p.end();
  assert.deepEqual(events, []);
});

test('streamChat accumulates deltas and usage', async () => {
  const deltas = [];
  let sentBody;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer k');
    return sseResponse([
      ': OPENROUTER PROCESSING\n\n',
      delta('He'),
      delta('llo'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.0001}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const res = await api.streamChat({ key: 'k', model: 'm/x', messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => deltas.push(t), fetchImpl });
  assert.equal(res.content, 'Hello');
  assert.deepEqual(res.usage, { promptTokens: 3, completionTokens: 2, cost: 0.0001 });
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(deltas, ['He', 'llo']);
  assert.equal(sentBody.stream, true);
  assert.deepEqual(sentBody.usage, { include: true });
  assert.equal(sentBody.model, 'm/x');
});

test('stream error keeps partial', async () => {
  const fetchImpl = async () => sseResponse([delta('He'), 'data: {"error":{"message":"boom","code":502}}\n\n']);
  await assert.rejects(
    api.streamChat({ key: 'k', model: 'm', messages: [], onDelta() {}, fetchImpl }),
    (e) => e instanceof api.ApiError && e.partial === 'He' && e.message === 'boom'
  );
});

test('stream cut without DONE resolves with what arrived', async () => {
  const fetchImpl = async () => sseResponse([delta('partial')]);
  const res = await api.streamChat({ key: 'k', model: 'm', messages: [], onDelta() {}, fetchImpl });
  assert.equal(res.content, 'partial');
});

test('network failure mid-stream rejects with partial', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    pull(ctrl) {
      if (!this.sent) { this.sent = true; ctrl.enqueue(enc.encode(delta('Hi'))); }
      else ctrl.error(new TypeError('network'));
    },
  });
  const fetchImpl = async () => new Response(body, { status: 200 });
  await assert.rejects(
    api.streamChat({ key: 'k', model: 'm', messages: [], onDelta() {}, fetchImpl }),
    (e) => e instanceof api.ApiError && e.status === 'network' && e.partial === 'Hi'
  );
});

test('non-2xx becomes ApiError with status and server message', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'No auth credentials found', code: 401 } }, 401);
  await assert.rejects(
    api.streamChat({ key: 'k', model: 'm', messages: [], onDelta() {}, fetchImpl }),
    (e) => e.status === 401 && /No auth/.test(e.message)
  );
});

test('abort becomes ApiError aborted with partial', async () => {
  const ctrl = new AbortController();
  const enc = new TextEncoder();
  const fetchImpl = async (url, opts) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(delta('Hi')));
      opts.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
    },
  }));
  const p = api.streamChat({ key: 'k', model: 'm', messages: [], signal: ctrl.signal, onDelta() { ctrl.abort(); }, fetchImpl });
  await assert.rejects(p, (e) => e.status === 'aborted' && e.partial === 'Hi');
});

test('complete retries without response_format after 400', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return jsonResponse({ error: { message: 'response_format unsupported' } }, 400);
    return jsonResponse({ choices: [{ message: { content: '{"x":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
  };
  const res = await api.complete({ key: 'k', model: 'm', messages: [], responseFormat: { type: 'json_object' }, fetchImpl });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal('response_format' in bodies[1], false);
  assert.equal(res.content, '{"x":1}');
});

test('headers omit HTTP-Referer without http location', () => {
  const h = api.headers('k');
  assert.equal(h.Authorization, 'Bearer k');
  assert.equal(h['X-Title'], 'Multaichat');
  assert.equal('HTTP-Referer' in h, false);
});

test('fetchModels returns data array', async () => {
  const fetchImpl = async (url) => { assert.match(url, /\/models$/); return jsonResponse({ data: [{ id: 'a' }] }); };
  assert.deepEqual(await api.fetchModels({ fetchImpl }), [{ id: 'a' }]);
});

test('testKey ok and failure', async () => {
  const ok = await api.testKey({ key: 'k', fetchImpl: async () => jsonResponse({ data: { label: 'mine', limit_remaining: 5 } }) });
  assert.deepEqual(ok, { ok: true, label: 'mine', limitRemaining: 5 });
  const bad = await api.testKey({ key: 'k', fetchImpl: async () => jsonResponse({ error: { message: 'x' } }, 401) });
  assert.equal(bad.ok, false);
});

test('errorMessage maps statuses', () => {
  const E = api.ApiError;
  assert.equal(api.errorMessage(new E(401, 'x'), 'a/b'), 'Invalid API key — check Settings');
  assert.equal(api.errorMessage(new E(402, 'x'), 'a/b'), 'Out of OpenRouter credits');
  assert.equal(api.errorMessage(new E(429, 'x'), 'a/b'), 'Rate limited — retry in a moment');
  assert.equal(api.errorMessage(new E(429, 'x'), 'a/b:free'), 'Free model rate-limited — retry or pick the paid variant');
  assert.equal(api.errorMessage(new E('aborted', 'x'), 'a/b'), 'Stopped');
  assert.equal(api.errorMessage(new E('network', 'x'), 'a/b'), 'Network error — check your connection');
  assert.equal(api.errorMessage(new E(500, 'Upstream died'), 'a/b'), 'Upstream died');
});

test('streamChat forwards plugins and omits empty', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return sseResponse([delta('ok'), 'data: [DONE]\n\n']); };
  const plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  await api.streamChat({ key: 'k', model: 'm', messages: [], onDelta() {}, fetchImpl, plugins });
  await api.streamChat({ key: 'k', model: 'm', messages: [], onDelta() {}, fetchImpl, plugins: [] });
  assert.deepEqual(bodies[0].plugins, plugins);
  assert.equal('plugins' in bodies[1], false);
});

test('complete forwards plugins', async () => {
  let body;
  const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return jsonResponse({ choices: [{ message: { content: 'x' } }] }); };
  await api.complete({ key: 'k', model: 'm', messages: [], fetchImpl, plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }] });
  assert.equal(body.plugins[0].pdf.engine, 'native');
});

const mcChunk = (text, model) => 'data: ' + JSON.stringify(Object.assign({ choices: [{ delta: { content: text } }] }, model ? { model } : {})) + '\n\n';

test('decide posts to alpha/decisions with model, state, questions', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return jsonResponse({ model: 'perplexity/pplx-decider-v1.2', answers: { pick: { type: 'choice', choice: 'a/x', probabilities: { 'a/x': 0.7 } } }, usage: { input_tokens: 120, output_tokens: 0, cost: 0.0000024 } }); };
  const r = await api.decide({ key: 'k', model: 'perplexity/pplx-decider-v1.2', state: ['hi'], questions: { pick: { type: 'choice' } }, fetchImpl });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['model', 'questions', 'state']);
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
  assert.deepEqual(r.usage, { inputTokens: 120, cost: 0.0000024 });
  assert.equal(r.answers.pick.choice, 'a/x');
  assert.equal(r.model, 'perplexity/pplx-decider-v1.2');
});

test('decide retries systemone once on 404', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (urls.length === 1) return jsonResponse({ error: { message: 'nope' } }, 404);
    return jsonResponse({ model: 'm/d', answers: { q: { type: 'choice', choice: 'x' } }, usage: { input_tokens: 5 } });
  };
  const r = await api.decide({ key: 'k', model: 'm/d', state: ['hi'], questions: {}, fetchImpl });
  assert.deepEqual(urls, ['https://openrouter.ai/api/alpha/decisions', 'https://openrouter.ai/api/v1/systemone']);
  assert.equal(r.answers.q.choice, 'x');
  assert.deepEqual(r.usage, { inputTokens: 5, cost: null });
  assert.deepEqual(api.DECIDE_URLS, urls);
});

test('decide throws ApiError with status on 429 and does not retry', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return jsonResponse({ error: { message: 'slow down' } }, 429); };
  await assert.rejects(
    api.decide({ key: 'k', model: 'm/d', state: [], questions: {}, fetchImpl }),
    (err) => err instanceof api.ApiError && err.status === 429 && err.message === 'slow down',
  );
  assert.equal(n, 1);
});

test('decide throws when every URL returns 404', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return jsonResponse({}, 404); };
  await assert.rejects(api.decide({ key: 'k', model: 'm/d', state: [], questions: {}, fetchImpl }), (err) => err.status === 404);
  assert.equal(n, 2);
});

test('fetchDeciders requests output_modalities=decisions', async () => {
  let seen;
  const fetchImpl = async (url) => { seen = url; return jsonResponse({ data: [{ id: 'a/d' }, { id: 'b/d' }] }); };
  const r = await api.fetchDeciders({ fetchImpl });
  assert.ok(seen.endsWith('/models?output_modalities=decisions'));
  assert.deepEqual(r.map((m) => m.id), ['a/d', 'b/d']);
});

test('streamChat sends extraBody and returns servedModel', async () => {
  let body;
  const fetchImpl = async (url, opts) => {
    body = JSON.parse(opts.body);
    return sseResponse([mcChunk('Hi', 'anthropic/claude-sonnet-5'), mcChunk('!', 'anthropic/claude-sonnet-5'), 'data: [DONE]\n\n']);
  };
  const res = await api.streamChat({ key: 'k', model: 'openrouter/auto', messages: [], extraBody: { session_id: 'c_1' }, fetchImpl });
  assert.equal(body.session_id, 'c_1');
  assert.equal(body.model, 'openrouter/auto');
  assert.equal(res.servedModel, 'anthropic/claude-sonnet-5');
  assert.equal(res.content, 'Hi!');
});

test('streamChat servedModel is null when chunks have no model', async () => {
  const fetchImpl = async () => sseResponse([delta('Hi'), 'data: [DONE]\n\n']);
  const res = await api.streamChat({ key: 'k', model: 'm/x', messages: [], fetchImpl });
  assert.equal(res.servedModel, null);
});
