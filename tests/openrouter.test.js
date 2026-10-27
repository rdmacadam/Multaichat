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
