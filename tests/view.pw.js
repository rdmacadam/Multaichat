'use strict';
// Browser tests for answer viewing (fullscreen answer). Usage: node tests/view.pw.js [name filter]
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

async function ask(page, text = 'Hello') {
  await page.fill('#prompt', text);
  await page.press('#prompt', 'Enter');
}
const allDone = (page, turns) => page.waitForFunction((n) => document.querySelectorAll('.turn').length === n &&
  !document.querySelector('.cell.status-streaming'), turns);
const dlg = (page) => page.locator('#answer-dialog');
const toColumns = (page) => page.click('.view-switch [data-view="columns"]');
const toRows = (page) => page.click('.view-switch [data-view="rows"]');
const count = (page, sel) => page.locator(sel).count();
const SIX = ['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro', 'x-ai/grok-5', 'deepseek/deepseek-v4', 'qwen/qwen4-235b'];
const shownModel = async (page) => (await dlg(page).locator('.fs-model').textContent()).trim();
const shownText = async (page) => (await dlg(page).locator('.fs-body .md').textContent()).trim();

const cases = {
  async 'fullscreen shows the answer, flips between models with arrows and closes on Escape'(page) {
    await ask(page);
    await allDone(page, 1);
    const cells = page.locator('.turn').first().locator('.cell');
    const names = await page.locator('.lane-head .lane-name').allTextContents();
    await cells.nth(0).locator('button.fs-open').click();
    await page.waitForSelector('#answer-dialog[open]');
    assert.equal(await shownModel(page), names[0]);
    const firstText = await shownText(page);
    assert.ok(firstText.length > 0);
    await page.keyboard.press('ArrowRight');
    assert.equal(await shownModel(page), names[1]);
    assert.notEqual(await shownText(page), firstText);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await shownModel(page), names[0]);
    await page.keyboard.press('ArrowLeft'); // wraps around to the last model
    assert.equal(await shownModel(page), names[names.length - 1]);
    await dlg(page).locator('button.fs-next').click();
    assert.equal(await shownModel(page), names[0]);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#answer-dialog:not([open])', { state: 'attached' });
  },

  async 'fullscreen skips models that were not asked in that turn'(page) {
    await ask(page);
    await allDone(page, 1);
    const names = await page.locator('.lane-head .lane-name').allTextContents();
    // remove the middle model, then ask again: it is "not asked" in turn 2
    await page.locator('#topbar .chip').nth(1).locator('.chip-x').click();
    await ask(page, 'Second');
    await allDone(page, 2);
    const turn2 = page.locator('.turn').nth(1);
    await turn2.locator('.cell:not(.not-asked)').first().locator('button.fs-open').click();
    assert.equal(await shownModel(page), names[0]);
    await page.keyboard.press('ArrowRight');
    assert.equal(await shownModel(page), names[2], 'the removed model is skipped');
    assert.match(await dlg(page).locator('.fs-pos').textContent(), /2 \/ 2/);
  },

  async 'fullscreen follows a streaming answer'(page) {
    await ask(page);
    await page.waitForSelector('.cell.status-streaming button.fs-open');
    await page.locator('.turn').first().locator('.cell').nth(0).locator('button.fs-open').click();
    await page.waitForSelector('#answer-dialog[open]');
    assert.equal(await shownText(page), '…', 'shows the streaming placeholder first');
    await allDone(page, 1);
    await page.waitForFunction(() => document.querySelector('#answer-dialog .fs-body .md').textContent.trim().length > 10);
    const cellText = (await page.locator('.turn').first().locator('.cell').nth(0).locator('.md').textContent()).trim();
    assert.equal(await shownText(page), cellText);
  },
  async 'switch to Compare shows one column per model and survives reload'(page) {
    await ask(page);
    await allDone(page, 1);
    const lanes = await count(page, '.lane-head');
    await toColumns(page);
    await page.waitForSelector('.compare-col');
    assert.equal(await count(page, '.compare-col'), lanes);
    assert.equal(await count(page, '.turns'), 0);
    assert.equal(await page.getAttribute('.view-switch [data-view="columns"]', 'aria-pressed'), 'true');
    await page.reload();
    await page.waitForSelector('.compare-col');
    assert.equal(await count(page, '.compare-col'), lanes);
    await toRows(page);
    await page.waitForSelector('.turns');
    assert.equal(await count(page, '.compare'), 0);
  },

  async 'a model not asked in a turn has no marker for it'(page) {
    await ask(page);
    await allDone(page, 1);
    await page.locator('#topbar .chip').nth(1).locator('.chip-x').click();
    await ask(page, 'Second');
    await allDone(page, 2);
    await toColumns(page);
    const cols = page.locator('.compare-col');
    assert.equal(await cols.nth(0).locator('.msg-mark').count(), 2);
    assert.equal(await cols.nth(1).locator('.msg-mark').count(), 1);
    assert.equal(await cols.nth(0).locator('.col-answer .md').first().textContent() !== '', true);
  },

  async 'phone width renders rows even with Compare saved'(page) {
    await ask(page);
    await page.waitForFunction(() => document.querySelectorAll('.compare .col-answer').length === 3 && !document.querySelector('.col-answer.status-streaming'));
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForSelector('.turns');
    assert.equal(await count(page, '.compare'), 0);
    assert.equal(await page.locator('.view-bar').isVisible(), false);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForSelector('.compare');
  },

  async 'columns keep min width'(page) {
    await ask(page);
    await allDone(page, 1);
    await toColumns(page);
    const widths = await page.locator('.compare-col').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    assert.equal(widths.length, 6);
    assert.ok(widths.every((w) => w >= 319), 'widths ' + widths.join(','));
    assert.ok(await page.evaluate(() => { const c = document.querySelector('.compare'); return c.scrollWidth > c.clientWidth; }));
  },
};
cases['phone width renders rows even with Compare saved'].init = { 'mc.settings': JSON.stringify({ chatView: 'columns' }) };
cases['columns keep min width'].init = { 'mc.settings': JSON.stringify({ selected: SIX }) };
cases['fullscreen follows a streaming answer'].opts = { delay: 1500 };

(async () => {
  const browser = await chromium.launch();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}/`;
  const only = process.argv[2];
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    if (only && !name.includes(only)) continue;
    let page;
    try {
      page = await open(browser, fn.opts || {}, fn.init);
      await fn(page);
      assert.deepEqual(page.errors, [], 'no page errors');
      console.log('ok - ' + name);
    } catch (e) {
      failed++;
      console.log('not ok - ' + name + '\n  ' + String(e.message).split('\n').slice(0, 6).join('\n  '));
    } finally {
      if (page) await page.context().close();
    }
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
