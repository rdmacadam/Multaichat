/* MC.api — OpenRouter HTTP client: model list, key check, streaming and
   non-streaming chat completions. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.api = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE = 'https://openrouter.ai/api/v1';
  // Decision endpoint: documented alpha path first, systemone only on 404.
  const DECIDE_URLS = ['https://openrouter.ai/api/alpha/decisions', 'https://openrouter.ai/api/v1/systemone'];

  class ApiError extends Error {
    // status: HTTP status number, or 'aborted' | 'network'
    constructor(status, message, partial = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.partial = partial;
    }
  }

  function createSseParser(onEvent) {
    let buf = '';
    function line(l) {
      if (l.endsWith('\r')) l = l.slice(0, -1);
      if (!l || l.startsWith(':') || !l.startsWith('data:')) return;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') { onEvent('[DONE]'); return; }
      try { onEvent(JSON.parse(payload)); } catch (e) { /* ignore malformed */ }
    }
    return {
      push(text) {
        buf += text;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          line(l);
        }
      },
      end() { if (buf) { line(buf); buf = ''; } },
    };
  }

  function headers(key) {
    const h = { 'Content-Type': 'application/json', 'X-Title': 'Multaichat' };
    if (key) h.Authorization = 'Bearer ' + key;
    const loc = globalThis.location;
    if (loc && /^https?:$/.test(loc.protocol)) h['HTTP-Referer'] = loc.origin;
    return h;
  }

  function normUsage(u) {
    if (!u) return null;
    return { promptTokens: u.prompt_tokens || 0, completionTokens: u.completion_tokens || 0, cost: u.cost != null ? u.cost : null };
  }

  function isAbort(e, signal) {
    return (e && e.name === 'AbortError') || (signal && signal.aborted);
  }

  async function errorFromResponse(res) {
    let msg = res.statusText || 'Request failed';
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) msg = body.error.message;
    } catch (e) { /* not JSON */ }
    return new ApiError(res.status, msg);
  }

  async function doFetch(fetchImpl, url, opts, signal) {
    try {
      return await fetchImpl(url, opts);
    } catch (e) {
      if (isAbort(e, signal)) throw new ApiError('aborted', 'Stopped');
      throw new ApiError('network', e && e.message ? e.message : 'Network error');
    }
  }

  const withPlugins = (body, plugins) => (Array.isArray(plugins) && plugins.length ? Object.assign(body, { plugins }) : body);

  async function streamChat({ key, model, messages, signal, onDelta, plugins, extraBody, fetchImpl = globalThis.fetch }) {
    const res = await doFetch(fetchImpl, BASE + '/chat/completions', {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(Object.assign(withPlugins({ model, messages, stream: true, usage: { include: true } }, plugins), extraBody || {})),
      signal,
    }, signal);
    if (!res.ok) throw await errorFromResponse(res);

    let content = '';
    let usage = null;
    let finishReason = null;
    let servedModel = null;
    let streamError = null;
    let done = false;
    const parser = createSseParser((ev) => {
      if (ev === '[DONE]') { done = true; return; }
      if (ev.error) { streamError = new ApiError(ev.error.code || 500, ev.error.message || 'Stream error'); return; }
      if (ev.model) servedModel = ev.model;
      const ch = ev.choices && ev.choices[0];
      if (ch) {
        const t = ch.delta && ch.delta.content;
        if (t) { content += t; onDelta && onDelta(t); }
        if (ch.finish_reason) finishReason = ch.finish_reason;
      }
      if (ev.usage) usage = normUsage(ev.usage);
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      while (!done && !streamError) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        parser.push(dec.decode(value, { stream: true }));
      }
      parser.end();
    } catch (e) {
      if (isAbort(e, signal)) throw new ApiError('aborted', 'Stopped', content);
      throw new ApiError('network', e && e.message ? e.message : 'Network error', content);
    } finally {
      if (done || streamError) { try { reader.cancel(); } catch (e) { /* ignore */ } }
    }
    if (streamError) { streamError.partial = content; throw streamError; }
    return { content, usage, finishReason, servedModel };
  }

  async function complete({ key, model, messages, responseFormat, signal, plugins, fetchImpl = globalThis.fetch }) {
    const send = async (withFormat) => {
      const body = withPlugins({ model, messages, usage: { include: true } }, plugins);
      if (withFormat) body.response_format = responseFormat;
      return doFetch(fetchImpl, BASE + '/chat/completions', { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal }, signal);
    };
    let res = await send(!!responseFormat);
    if (res.status === 400 && responseFormat) res = await send(false);
    if (!res.ok) throw await errorFromResponse(res);
    const data = await res.json();
    if (data.error) throw new ApiError(data.error.code || 500, data.error.message || 'Error');
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return { content: (msg && msg.content) || '', usage: normUsage(data.usage) };
  }

  async function fetchModels({ fetchImpl = globalThis.fetch } = {}) {
    const res = await doFetch(fetchImpl, BASE + '/models', { headers: { 'X-Title': 'Multaichat' } });
    if (!res.ok) throw await errorFromResponse(res);
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  }

  async function fetchDeciders({ fetchImpl = globalThis.fetch } = {}) {
    const res = await doFetch(fetchImpl, BASE + '/models?output_modalities=decisions', { headers: { 'X-Title': 'Multaichat' } });
    if (!res.ok) throw await errorFromResponse(res);
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  }

  async function decide({ key, model, state, questions, signal, fetchImpl = globalThis.fetch }) {
    let res;
    for (const url of DECIDE_URLS) {
      res = await doFetch(fetchImpl, url, { method: 'POST', headers: headers(key), body: JSON.stringify({ model, state, questions }), signal }, signal);
      if (res.status !== 404) break; // only a 404 falls through to the next URL
    }
    if (!res.ok) throw await errorFromResponse(res);
    const data = await res.json();
    if (data.error) throw new ApiError(data.error.code || 500, data.error.message || 'Error');
    const u = data.usage || {};
    return { model: data.model || model, answers: data.answers || {}, usage: { inputTokens: u.input_tokens || 0, cost: u.cost != null ? u.cost : null } };
  }

  async function testKey({ key, fetchImpl = globalThis.fetch }) {
    try {
      const res = await doFetch(fetchImpl, BASE + '/key', { headers: headers(key) });
      if (!res.ok) return { ok: false };
      const d = (await res.json()).data || {};
      return { ok: true, label: d.label, limitRemaining: d.limit_remaining };
    } catch (e) {
      return { ok: false };
    }
  }

  function errorMessage(err, modelId) {
    const s = err && err.status;
    if (s === 401) return 'Invalid API key — check Settings';
    if (s === 402) return 'Out of OpenRouter credits';
    if (s === 429) {
      return /:free$/.test(modelId || '') ? 'Free model rate-limited — retry or pick the paid variant' : 'Rate limited — retry in a moment';
    }
    if (s === 'aborted') return 'Stopped';
    if (s === 'network') return 'Network error — check your connection';
    return (err && err.message) || 'Something went wrong';
  }

  return { BASE, DECIDE_URLS, ApiError, createSseParser, headers, streamChat, complete, fetchModels, fetchDeciders, decide, testKey, errorMessage };
});
