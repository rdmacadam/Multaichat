'use strict';
// Minimal in-memory localStorage stand-in.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}
module.exports = { memoryStorage };

// A fetch Response whose body streams the given string chunks.
function sseResponse(chunks, init = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(body, Object.assign({ status: 200, headers: { 'content-type': 'text/event-stream' } }, init));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function delta(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
}

module.exports.sseResponse = sseResponse;
module.exports.jsonResponse = jsonResponse;
module.exports.delta = delta;
