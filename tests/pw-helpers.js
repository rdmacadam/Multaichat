'use strict';
// Shared Playwright helpers: a mocked OpenRouter and a tiny static server.
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const fixture = require('./fixtures/models.json');

const ANSWERS = {
  'anthropic/claude-sonnet-5': 'Happy to help with your trip.\n\nWhat month are you going?',
  'openai/gpt-6': 'Here is a plan:\n\n1. **Day 1** Tokyo\n2. **Day 2** Hakone\n\nEnjoy!',
  'google/gemini-3-pro': 'Quick questions:\n- Budget?\n- First visit?',
};
const FUSION = {
  overview: 'Models agree on Tokyo first.',
  topics: [{
    title: 'Itinerary', merged: 'Start in **Tokyo**, then Hakone.', models: ['openai/gpt-6', 'anthropic/claude-sonnet-5'],
    excerpts: [{ model: 'openai/gpt-6', quote: 'Day 1** Tokyo' }, { model: 'anthropic/claude-sonnet-5', quote: 'Kyoto is a must' }],
  }],
  disagreements: [], unique: [{ model: 'google/gemini-3-pro', point: 'Asks about budget' }],
};

function sse(text) {
  const parts = text.match(/.{1,12}/gs) || [''];
  return parts.map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') +
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.00042 } }) + '\n\ndata: [DONE]\n\n';
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

// opts.delay: ms before each chat response; opts.failModels: true makes /models fail;
// opts.requests: array that receives every chat request body.
async function mockOpenRouter(page, opts = {}) {
  await page.route('https://openrouter.ai/api/v1/**', async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.endsWith('/models') && opts.failModels) return route.abort();
    if (url.endsWith('/models')) return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ data: fixture.data.map((m) => Object.assign({}, m, { created: m.created + Math.floor((Date.now() - fixture.now) / 1000) })) }) });
    if (url.endsWith('/key')) return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ data: { label: 'test' } }) });
    const body = JSON.parse(req.postData() || '{}');
    if (opts.requests) opts.requests.push(body);
    if (body.response_format || !body.stream) {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(FUSION) } }] }) });
    }
    const sys = body.messages[0] && body.messages[0].role === 'system' ? body.messages[0].content : '';
    const text = sys.startsWith('Summarize') ? '- Tokyo first\n- Two models asked questions' : (ANSWERS[body.model] || 'OK from ' + body.model);
    await new Promise((r) => setTimeout(r, opts.delay != null ? opts.delay : 150));
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/event-stream' }, CORS), body: sse(text) });
  });
}

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

module.exports = { ROOT, ANSWERS, FUSION, mockOpenRouter, serve };
