'use strict';
// Browser regressions for issues found in review. Usage: node tests/regressions.pw.js
const { chromium } = require('playwright');
const assert = require('assert/strict');
const { mockOpenRouter, serve } = require('./pw-helpers');

let base;

async function open(browser, opts = {}, init) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await mockOpenRouter(page, opts);
  await page.addInitScript((initial) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('mc.apiKey', 'sk-or-v1-test');
    for (const [k, v] of Object.entries(initial || {})) localStorage.setItem(k, v);
  }, init);
  await page.goto(base);
  await page.waitForSelector('.empty-state');
  return page;
}

async function ask(page, text = 'Plan a trip') {
  await page.fill('#prompt', text);
  await page.press('#prompt', 'Enter');
}
const allDone = (page, turns) => page.waitForFunction((n) => document.querySelectorAll('.turn').length === n &&
  !document.querySelector('.cell.status-streaming'), turns);
const storedConvs = (page) => page.evaluate(() => MC.app.state.store.all());

const cases = {
  async 'answer-together does not resend previous batches'(browser) {
    const page = await open(browser);
    await ask(page);
    await allDone(page, 1);
    for (const [n, tag] of [[2, 'FIRST'], [3, 'SECOND']]) {
      await page.click('.ask-banner button');
      const boxes = page.locator('#batch-dialog textarea');
      await boxes.nth(0).fill(tag + '-A');
      await boxes.nth(1).fill(tag + '-B');
      await page.keyboard.press('Control+Enter');
      await allDone(page, n);
    }
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.turn').count(), 3);
    const turns = (await storedConvs(page))[0].turns;
    assert.equal(turns.length, 3);
    assert.ok(Object.values(turns[2].inputs).every((v) => v.startsWith('SECOND')));
  },

  async 'reopening a streaming chat keeps its answers'(browser) {
    const page = await open(browser, { delay: 1200 });
    await ask(page);
    await page.waitForSelector('.cell.status-streaming');
    await page.click('.conv-open');
    await allDone(page, 1);
    assert.equal(await page.locator('.cell.status-done').count(), 3);
    await page.waitForTimeout(1200);
    const t = (await storedConvs(page))[0].turns[0];
    assert.ok(Object.values(t.responses).every((r) => r.status === 'done'), 'stored as done');
  },

  async 'Esc in another input does not stop streaming'(browser) {
    const page = await open(browser, { delay: 1200 });
    await ask(page);
    await page.waitForSelector('.cell.status-streaming');
    await page.focus('.quick-input');
    await page.keyboard.press('Escape');
    await allDone(page, 1);
    assert.equal(await page.locator('.cell.status-done').count(), 3);
  },

  async 'Esc clearing the target chip does not stop streaming'(browser) {
    const page = await open(browser, { delay: 300 });
    await ask(page);
    await allDone(page, 1);
    await page.locator('.cell-actions button', { hasText: 'Reply' }).first().click();
    await page.evaluate(() => { MC.app.state.runner.retry(MC.app.state.conv, MC.app.state.conv.turns[0].id, MC.app.state.conv.lanes[1].id); });
    await page.waitForSelector('.cell.status-streaming');
    await page.focus('#prompt');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.target-chip:not([hidden])').count(), 0);
    await allDone(page, 1);
    assert.equal(await page.locator('.cell.status-stopped').count(), 0);
  },

  async 'deleting a streaming chat keeps it deleted'(browser) {
    const page = await open(browser, { delay: 800 });
    page.on('dialog', (d) => d.accept());
    await ask(page);
    await page.waitForSelector('.cell.status-streaming');
    await page.hover('.conv');
    await page.click('.conv button[title="Delete"]');
    await page.waitForTimeout(2500);
    assert.equal((await storedConvs(page)).length, 0);
    assert.equal(await page.locator('.conv').count(), 0);
  },

  async 'fork during streaming does not leave the fork spinning'(browser) {
    const page = await open(browser, { delay: 800 });
    await ask(page);
    await page.waitForSelector('.cell.status-streaming');
    await page.locator('.turn-actions button', { hasText: 'Fork' }).click();
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('.cell.status-streaming').count(), 0);
    const convs = await storedConvs(page);
    const fork = convs.find((c) => c.parentId);
    assert.ok(fork, 'fork stored');
    assert.ok(Object.values(fork.turns[0].responses).every((r) => r.status !== 'streaming'));
  },

  async 'sidebar search keeps focus while answers stream'(browser) {
    const page = await open(browser, { delay: 2500 });
    await ask(page);
    await page.waitForSelector('.cell.status-streaming');
    await page.click('.conv-search');
    await page.keyboard.type('pla');
    await page.waitForTimeout(3500);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.className), 'conv-search');
  },

  async 'targeted send keeps text typed in other inline boxes'(browser) {
    const page = await open(browser, { delay: 300 });
    await ask(page);
    await allDone(page, 1);
    const boxes = page.locator('.inline-reply');
    await boxes.nth(1).fill('draft for gemini');
    await boxes.nth(0).fill('April');
    await boxes.nth(0).press('Enter');
    await allDone(page, 2);
    assert.equal(await page.locator('.turn').nth(0).locator('.inline-reply').last().inputValue(), 'draft for gemini');
  },

  // Firefox for Android shrinks only the visual viewport when the keyboard
  // opens; the composer must follow the visible area, not the layout height.
  async 'composer stays above the on-screen keyboard'(browser) {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await mockOpenRouter(page);
    await page.addInitScript(() => {
      localStorage.setItem('mc.apiKey', 'sk-or-v1-test');
      const vv = new EventTarget();
      Object.assign(vv, { width: 390, height: 800, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      window.__setKeyboard = (h) => { vv.height = h; vv.dispatchEvent(new Event('resize')); };
    });
    await page.goto(base);
    await page.waitForSelector('#prompt');
    const bottom = () => page.evaluate(() => document.getElementById('composer').getBoundingClientRect().bottom);
    await page.focus('#prompt');
    await page.evaluate(() => window.__setKeyboard(450));
    await page.waitForTimeout(50);
    assert.ok(await bottom() <= 451, 'composer bottom ' + (await bottom()) + ' is under the keyboard (visible height 450)');
    await page.evaluate(() => window.__setKeyboard(800));
    await page.waitForTimeout(50);
    assert.ok(Math.abs((await bottom()) - 800) <= 1, 'composer returns to the bottom when the keyboard closes');
    await context.close();
  },

  async 'offline start keeps the saved model choices'(browser) {
    const saved = { selected: ['qwen/qwen4-coder', 'x-ai/grok-5'], summaryModel: 'x-ai/grok-5', fusionModel: 'qwen/qwen4-coder' };
    const page = await open(browser, { failModels: true }, { 'mc.settings': JSON.stringify(saved) });
    const s = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')));
    assert.deepEqual(s.selected, saved.selected);
    assert.equal(s.summaryModel, saved.summaryModel);
    assert.equal(s.fusionModel, saved.fusionModel);
  },
};

(async () => {
  const browser = await chromium.launch();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}/`;
  const only = process.argv[2];
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    if (only && !name.includes(only)) continue;
    try { await fn(browser); console.log('ok - ' + name); }
    catch (e) { failed++; console.log('not ok - ' + name + '\n  ' + String(e.message).split('\n').slice(0, 3).join('\n  ')); }
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
