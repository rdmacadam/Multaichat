'use strict';
// Browser tests for Round A (filters, presets, attachments). Usage: node tests/round-a.pw.js [name filter]
const { chromium } = require('playwright');
const assert = require('assert/strict');
const { mockOpenRouter, serve } = require('./pw-helpers');

let base;

async function open(browser, opts = {}, init) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  opts.requests = opts.requests || [];
  page.requests = opts.requests;
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
const openPicker = async (page) => { await page.keyboard.press('Control+k'); await page.waitForSelector('#picker-dialog[open] .picker-search'); };
const rowIds = (page) => page.$$eval('#picker-dialog .model-row', (rs) => rs.map((r) => r.dataset.id));

const cases = {
  async 'filters narrow every section'(page) {
    await openPicker(page);
    const before = (await rowIds(page)).length;
    await page.check('#picker-dialog .filter-images');
    const ids = await rowIds(page);
    assert.ok(ids.length > 0 && ids.length < before);
    assert.equal(await page.locator('#picker-dialog .model-row:not(:has(.badge.img))').count(), 0);
    assert.ok((await page.locator('#picker-dialog .filter-count').textContent()).includes('Filters (1)'));
    const top = await page.$$eval('#picker-dialog .picker-section', (secs) => {
      const s = secs.find((x) => x.querySelector('h3').textContent.startsWith('Top picks'));
      return s ? [...s.querySelectorAll('.model-row')].map((r) => r.dataset.id) : [];
    });
    const imageModels = ['anthropic/claude-sonnet-5', 'google/gemini-3-pro', 'meta-llama/llama-5-405b', 'openai/gpt-6'];
    assert.ok(top.length > 0 && top.every((id) => imageModels.includes(id)));
  },

  async 'filters persist'(page) {
    await openPicker(page);
    await page.selectOption('#picker-dialog .filter-context', '200000');
    const count = (await rowIds(page)).length;
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForSelector('.empty-state');
    await openPicker(page);
    assert.equal(await page.inputValue('#picker-dialog .filter-context'), '200000');
    assert.equal((await rowIds(page)).length, count);
  },

  async 'filters exclude everything'(page) {
    await openPicker(page);
    await page.fill('#picker-dialog .filter-max-out', '0.01');
    await page.dispatchEvent('#picker-dialog .filter-max-out', 'change');
    await page.check('#picker-dialog .filter-images');
    assert.equal((await rowIds(page)).length, 0);
    assert.ok((await page.locator('#picker-dialog .picker-body').textContent()).includes('No models match these filters'));
    await page.click('#picker-dialog .picker-body button:has-text("Clear filters")');
    assert.ok((await rowIds(page)).length > 10);
    await page.check('#picker-dialog .filter-images');
    await page.fill('#picker-dialog .filter-max-out', '0.01');
    await page.dispatchEvent('#picker-dialog .filter-max-out', 'change');
    await page.click('#picker-dialog .dialog-foot .primary');
    await page.focus('.quick-input');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.quick-list').isVisible(), false);
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
    let page;
    try {
      page = await open(browser, fn.opts || {}, fn.init);
      await fn(page);
      assert.deepEqual(page.errors, [], 'no page errors');
      console.log('ok - ' + name);
    } catch (e) {
      failed++;
      console.log('not ok - ' + name + '\n  ' + String(e.message).split('\n').slice(0, 3).join('\n  '));
    } finally {
      if (page) await page.context().close();
    }
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();

