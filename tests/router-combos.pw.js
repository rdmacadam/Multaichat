'use strict';
// End-to-end router sweep: every mode × pool × (text | image) — first message,
// follow-up, re-route and one more message. Usage: node tests/router-combos.pw.js
const { chromium } = require('playwright');
const { mockOpenRouter, serve } = require('./pw-helpers');
const fixture = require('./fixtures/models.json');
const imageIds = new Set(fixture.data.filter((m) => (m.architecture.input_modalities || []).includes('image')).map((m) => m.id));
const PNG = { name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };
const SEL = ['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro', 'deepseek/deepseek-v4:free', 'x-ai/grok-5'];
(async () => {
  const b = await chromium.launch(); const s = await serve(); const base = `http://127.0.0.1:${s.address().port}/`;
  const fails = []; let runs = 0;
  for (const mode of ['auto', 'free', 'diverse', 'best', 'manual', 'native']) for (const pool of ['catalog', 'selection']) for (const img of [false, true]) {
    runs++;
    const name = `${mode}/${pool}/${img ? 'image' : 'text'}`;
    const ctxB = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctxB.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    const opts = { requests: [], decisions: [], delay: 20 };
    await mockOpenRouter(p, opts);
    await p.addInitScript(([mode, pool, SEL]) => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1'); localStorage.setItem('mc.apiKey', 'k');
      localStorage.setItem('mc.settings', JSON.stringify({ selected: SEL, router: { enabled: true, mode, pool, count: 2, manualPool: SEL.slice(0, 4) } })); }, [mode, pool, SEL]);
    const check = (c, msg) => { if (!c) fails.push(name + ': ' + msg); };
    const done = (n) => p.waitForFunction((n) => document.querySelectorAll('.turn').length === n && !document.querySelector('.cell.status-streaming') && !/routing…/.test(document.querySelector('#composer').textContent), n, { timeout: 15000 });
    const chat = () => opts.requests.filter((r) => r.stream);
    const lanes = () => p.evaluate(() => MC.app.state.conv.lanes.filter((l) => l.active).map((l) => l.modelId));
    try {
      await p.goto(base); await p.waitForSelector('#prompt');
      if (img) await p.setInputFiles('#composer input[type=file]', PNG);
      await p.fill('#prompt', 'First'); await p.press('#prompt', 'Enter');
      if (mode === 'free' && img) { await p.waitForSelector('.toast:has-text("No free model fits")'); check(chat().length === 0, 'sent despite no fitting model'); check(await p.inputValue('#prompt') === 'First', 'composer text lost'); await ctxB.close(); continue; }
      await done(1);
      const first = chat().map((r) => r.model);
      const l1 = await lanes();
      check(first.length >= 1, 'first message reached no model');
      check(JSON.stringify(l1.slice().sort()) === JSON.stringify(first.slice().sort()), `chat lanes ${l1} != models asked ${first}`);
      if (mode === 'native') check(first.length === 1 && first[0] === 'openrouter/auto', 'native did not use openrouter/auto');
      else check(opts.decisions.length === 1 || /picked by rules/.test(await p.textContent('.route-bar')), 'no decision and no rules note');
      if (img) check(first.every((m) => m === 'openrouter/auto' || imageIds.has(m)), 'image sent to non-image model: ' + first);
      if (pool === 'selection' && mode !== 'manual' && mode !== 'native') check(first.every((m) => SEL.includes(m)), 'selection pool picked outside selection: ' + first);
      if (mode === 'manual') check(first.every((m) => SEL.slice(0, 4).includes(m)), 'manual picked outside manual pool: ' + first);
      if (mode === 'free') check(first.every((m) => /:free$/.test(m) || m === 'some/zero-price-model'), 'free mode picked paid: ' + first);
      const dec1 = opts.decisions.length; const sent1 = chat().length;
      await p.fill('#prompt', 'Second'); await p.press('#prompt', 'Enter'); await done(2);
      check(opts.decisions.length === dec1, 'second message made a decision');
      check(JSON.stringify(chat().slice(sent1).map((r) => r.model).sort()) === JSON.stringify(l1.slice().sort()), 'second message did not go to all chat models');
      await p.click('.router-chip .router-reroute'); const sent2 = chat().length;
      await p.fill('#prompt', 'Third'); await p.press('#prompt', 'Enter'); await done(3);
      const third = chat().slice(sent2).map((r) => r.model); const l3 = await lanes();
      check(JSON.stringify(l3.slice().sort()) === JSON.stringify(third.slice().sort()), `after re-route lanes ${l3} != asked ${third}`);
      const dec3 = opts.decisions.length; const sent3 = chat().length;
      await p.fill('#prompt', 'Fourth'); await p.press('#prompt', 'Enter'); await done(4);
      check(opts.decisions.length === dec3, 'message after re-route made a decision');
      check(chat().length - sent3 === l3.length, 'fourth message count mismatch');
      await p.click('.view-switch [data-view="columns"]');
      check(await p.locator('.compare-col').count() >= l3.length, 'compare columns missing');
    } catch (e) { fails.push(name + ': EXCEPTION ' + e.message.split('\n')[0]); }
    if (errors.length) fails.push(name + ': page errors ' + errors.join(' | '));
    await ctxB.close();
  }
  for (const f of fails) console.log('not ok - ' + f);
  console.log(`ok - ${runs - new Set(fails.map((f) => f.split(':')[0])).size} of ${runs} router combinations`);
  await b.close(); s.close();
  process.exit(fails.length ? 1 : 0);
})();
