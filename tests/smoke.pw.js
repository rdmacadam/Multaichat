'use strict';
// Browser smoke test: runs the real app against a mocked OpenRouter, both from
// file:// and over http://. Usage: node tests/smoke.pw.js [--shots <dir>]
const { chromium } = require('playwright');
const path = require('path');
const http = require('http');
const fs = require('fs');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const fixture = require('./fixtures/models.json');
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;

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

async function mockOpenRouter(page) {
  await page.route('https://openrouter.ai/api/v1/**', async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.endsWith('/models')) return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ data: fixture.data.map((m) => Object.assign({}, m, { created: m.created + Math.floor((Date.now() - fixture.now) / 1000) })) }) });
    if (url.endsWith('/key')) return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ data: { label: 'test' } }) });
    const body = JSON.parse(req.postData() || '{}');
    if (body.response_format || !body.stream) {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(FUSION) } }] }) });
    }
    const sys = body.messages[0] && body.messages[0].role === 'system' ? body.messages[0].content : '';
    const text = sys.startsWith('Summarize') ? '- Tokyo first\n- Two models asked questions' : (ANSWERS[body.model] || 'OK from ' + body.model);
    await new Promise((r) => setTimeout(r, 150));
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

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}

async function run(browser, url, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await mockOpenRouter(page);
  await page.goto(url);

  // first run: key card
  await page.waitForSelector('.first-run');
  await shot(page, label + '-1-first-run');
  await page.fill('#first-key', '  Bearer sk-or-v1-test  ');
  await page.click('.first-run button.primary');
  await page.waitForSelector('.empty-state');
  assert.equal(await page.evaluate(() => localStorage.getItem('mc.apiKey')), 'sk-or-v1-test');

  // picker: search filters, keyboard works
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#picker-dialog[open] .picker-search');
  assert.ok(await page.locator('.picker-section h3', { hasText: 'Top picks' }).count());
  assert.ok(await page.locator('.picker-section h3', { hasText: 'Open-weight' }).count());
  await shot(page, label + '-2-picker');
  await page.fill('.picker-search', 'free');
  await page.waitForTimeout(250);
  const rows = await page.locator('.model-row').count();
  assert.ok(rows >= 4, 'free results');
  assert.equal(await page.locator('.model-row').filter({ hasNot: page.locator('.badge.free') }).count(), 0, 'only free rows');
  await page.fill('.picker-search', '');
  await page.waitForTimeout(250);
  await page.click('#picker-dialog .dialog-foot .primary');
  assert.equal(await page.locator('#topbar .chip').count(), 3);

  // broadcast
  await page.fill('#prompt', 'Plan a 5-day trip to Japan');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.cell.status-done').length === 3);
  assert.equal(await page.locator('.bubble').first().textContent(), 'Plan a 5-day trip to Japan');
  assert.ok(await page.locator('.ask-box').count() >= 2, 'inline reply boxes for askers');
  await page.waitForSelector('.ask-banner:not([hidden])');
  await shot(page, label + '-3-answers');

  // answer together
  await page.click('.ask-banner button');
  await page.waitForSelector('#batch-dialog[open]');
  const boxes = page.locator('#batch-dialog textarea');
  assert.equal(await boxes.count(), 2);
  await boxes.nth(0).fill('April');
  await boxes.nth(1).fill('$2000, yes');
  await shot(page, label + '-4-batch');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.turn').length === 2 && document.querySelectorAll('.turn:nth-child(2) .cell.status-done').length === 2);
  assert.equal(await page.locator('.turn').nth(1).locator('.cell.not-asked').count(), 1);
  assert.ok((await page.locator('.turn').nth(1).locator('.prompt-label').textContent()).includes('answered each model'));

  // inline reply to one model
  const inline = page.locator('.turn').nth(1).locator('.inline-reply').first();
  await inline.fill('Mostly cities');
  await inline.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.turn').length === 3 && document.querySelectorAll('.turn:nth-child(3) .cell.status-done').length === 1);
  assert.equal(await page.locator('.turn').nth(2).locator('.cell.not-asked').count(), 2);

  // reply via composer target chip
  await page.locator('.turn').nth(0).locator('.cell-actions button', { hasText: 'Reply' }).nth(1).click();
  assert.ok(await page.locator('.target-chip:not([hidden])').count());

  // TL;DR and Fusion on first turn
  const t0 = page.locator('.turn').nth(0);
  await t0.locator('.turn-actions button', { hasText: 'TL;DR' }).click();
  await page.waitForSelector('.derived-card.tldr li');
  await t0.locator('.turn-actions button', { hasText: 'Fusion' }).click();
  await page.waitForSelector('.derived-card.fusion .topic');
  await page.locator('.sources summary').first().click();
  assert.ok(await page.locator('.excerpt-col blockquote.unverified').count() === 1, 'invented quote marked');
  assert.ok(await page.locator('.excerpt-col blockquote:not(.unverified)').count() === 1, 'real quote verified');
  await t0.scrollIntoViewIfNeeded();
  await shot(page, label + '-5-fusion');

  // reload: persisted
  await page.reload();
  await page.waitForSelector('.turn');
  assert.equal(await page.locator('.turn').count(), 3);
  assert.ok(await page.locator('.derived-card.fusion .topic').count());
  assert.equal(await page.locator('.conv').count(), 1);

  // fork
  await page.locator('.turn').nth(0).locator('.turn-actions button', { hasText: 'Fork' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conv').length === 2);
  await page.waitForSelector('.fork-mark');
  assert.equal(await page.locator('.turn').count(), 1);

  // mobile layout
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.lanes .cell:visible').count(), 1, 'one lane visible on mobile');
  await page.locator('.lane-head').nth(1).click();
  assert.ok((await page.locator('.lanes .cell:visible').first().textContent()).includes('Day 1'));
  await shot(page, label + '-6-mobile');

  assert.deepEqual(errors, [], 'no page errors');
  await context.close();
  console.log(`ok - ${label}`);
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const server = await serve();
  let failed = false;
  try {
    for (const [label, url] of [['file', 'file://' + path.join(ROOT, 'index.html')], ['http', `http://127.0.0.1:${server.address().port}/`]]) {
      try { await run(browser, url, label); } catch (e) { failed = true; console.log(`not ok - ${label}\n  ${e.stack.split('\n').slice(0, 4).join('\n  ')}`); }
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
})();
