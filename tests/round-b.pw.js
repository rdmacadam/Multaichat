'use strict';
// Browser tests for Round B (cost counter, router). Usage: node tests/round-b.pw.js [name filter]
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
  opts.decisions = opts.decisions || [];
  page.requests = opts.requests;
  page.decisions = opts.decisions;
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
const costText = async (page) => (await page.textContent('#cost')).trim();
const tip = (page) => page.locator('.cost-wrap .tip');

const cases = {
  async 'cost counter sums the answers and survives reload'(page) {
    assert.equal(await costText(page), 'Σ $0.00');
    await ask(page); await allDone(page, 1);
    const n = await page.evaluate(() => Object.keys(MC.app.state.conv.turns[0].responses).length);
    const expected = 'Σ ' + (await page.evaluate((c) => MC.util.formatCost(c), n * 0.00042));
    await page.waitForFunction((t) => document.querySelector('#cost').textContent.trim() === t, expected);
    assert.equal(await costText(page), expected);
    assert.equal(n, 3);
    assert.equal(expected, 'Σ $0.0013');
    await page.reload(); await page.waitForSelector('.turn');
    assert.equal(await costText(page), expected);
    // breakdown lists the non-zero parts
    await page.focus('.cost-wrap .info');
    assert.match(await tip(page).textContent(), /Answers/);
    assert.doesNotMatch(await tip(page).textContent(), /Judge|Router decisions/);
  },

  async 'info tooltip shows after a long hover, on focus, hides on Escape'(page) {
    const btn = page.locator('.cost-wrap .info');
    assert.equal(await btn.getAttribute('aria-label'), 'More info');
    const id = await btn.getAttribute('aria-describedby');
    assert.equal(await tip(page).getAttribute('id'), id);
    assert.equal(await tip(page).getAttribute('role'), 'tooltip');
    assert.match(await tip(page).textContent(), /.+/);
    await btn.hover();
    assert.equal(await tip(page).isHidden(), true, 'not shown at once on hover');
    await tip(page).waitFor({ state: 'visible', timeout: 3000 });
    await page.mouse.move(700, 500);
    await tip(page).waitFor({ state: 'hidden' });
    await btn.focus();
    assert.equal(await tip(page).isVisible(), true, 'focus shows at once');
    await page.keyboard.press('Escape');
    assert.equal(await tip(page).isHidden(), true);
    await btn.blur();
    await btn.click();
    assert.equal(await tip(page).isVisible(), true, 'click opens');
    await btn.click();
    assert.equal(await tip(page).isHidden(), true, 'second click closes');
    // text is the Appendix A wording
    assert.match(await tip(page).evaluate((e) => e.textContent), /What this chat has cost so far/);
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
      console.log('not ok - ' + name + '\n  ' + String(e.message).split('\n').slice(0, 8).join('\n  '));
    } finally {
      if (page) await page.context().close();
    }
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
