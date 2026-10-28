'use strict';
// Browser tests for answer viewing (fullscreen answer). Usage: node tests/view.pw.js [name filter]
const { chromium } = require('playwright');
const assert = require('assert/strict');
const { mockOpenRouter, serve } = require('./pw-helpers');

let base;

async function open(browser, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await mockOpenRouter(page, opts);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('mc.apiKey', 'sk-or-v1-test');
  });
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
};
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
      page = await open(browser, fn.opts || {});
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
