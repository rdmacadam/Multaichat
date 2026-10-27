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

  async 'router panel saves mode, count and pool; toolbar and chip update'(page) {
    const btn = page.locator('#topbar button.router-btn');
    assert.equal((await btn.textContent()).trim(), '🧭 Off');
    assert.equal(await page.locator('.router-chip').isVisible(), false);
    // the 🧭 button sits right before the cost counter
    assert.equal(await page.evaluate(() => document.querySelector('#topbar .router-btn').nextElementSibling.classList.contains('cost-wrap')), true);
    await btn.click();
    const dlg = page.locator('#router-dialog');
    await dlg.waitFor({ state: 'visible' });
    await dlg.locator('input.router-enabled').check();
    await dlg.locator('input[name="router-mode"][value="diverse"]').check();
    await dlg.locator('input.router-count').fill('3');
    await dlg.locator('input.router-count').dispatchEvent('change');
    await dlg.locator('input[name="router-pool"][value="selection"]').check();
    await page.waitForFunction(() => document.querySelector('#topbar .router-btn').textContent.trim() === '🧭 Diverse ×3');
    const r = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')).router);
    assert.equal(r.enabled, true);
    assert.equal(r.mode, 'diverse');
    assert.equal(r.count, 3);
    assert.equal(r.pool, 'selection');
    assert.equal(r.decisionModel, 'perplexity/pplx-decider-v1.2', 'full router object saved');
    // + raises the count
    await dlg.locator('button.count-up').click();
    await page.waitForFunction(() => document.querySelector('#topbar .router-btn').textContent.trim() === '🧭 Diverse ×4');
    // rows per mode: Pick from hidden in manual, extras only in best
    assert.equal(await dlg.locator('.row-extras').isHidden(), true);
    await dlg.locator('input[name="router-mode"][value="best"]').check();
    assert.equal(await dlg.locator('.row-extras').isVisible(), true);
    await dlg.locator('input[name="router-mode"][value="manual"]').check();
    assert.equal(await dlg.locator('.row-pool').isHidden(), true);
    assert.equal(await dlg.locator('.row-manual').isVisible(), true);
    await dlg.locator('input[name="router-mode"][value="diverse"]').check();
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'hidden' });
    const chip = page.locator('.router-chip');
    await chip.waitFor({ state: 'visible' });
    assert.match(await chip.textContent(), /🧭 Diverse ×4/);
    assert.equal(await page.getAttribute('#prompt', 'placeholder'), 'Ask — the router picks 4 models…');
    // survives reload
    await page.reload(); await page.waitForSelector('.empty-state');
    assert.equal((await page.textContent('#topbar .router-btn')).trim(), '🧭 Diverse ×4');
    // ✕ on the chip turns the router off
    await page.locator('.router-chip .chip-x').click();
    await page.waitForFunction(() => document.querySelector('#topbar .router-btn').textContent.trim() === '🧭 Off');
    assert.equal(await page.locator('.router-chip').isVisible(), false);
    const r2 = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')).router);
    assert.equal(r2.enabled, false);
    assert.equal(r2.mode, 'diverse');
    assert.equal(r2.count, 4);
  },

  async 'native mode disables the count at 1'(page) {
    await page.click('#topbar button.router-btn');
    const dlg = page.locator('#router-dialog');
    await dlg.locator('input.router-enabled').check();
    await dlg.locator('input[name="router-mode"][value="native"]').check();
    assert.equal(await dlg.locator('input.router-count').isDisabled(), true);
    assert.equal(await dlg.locator('input.router-count').inputValue(), '1');
    assert.equal(await dlg.locator('.row-decider').isHidden(), true, 'no decision model in native');
    assert.equal(await dlg.locator('.row-pool').isVisible(), true);
    await page.waitForFunction(() => document.querySelector('#topbar .router-btn').textContent.trim() === '🧭 Native');
    assert.equal(await page.getAttribute('#prompt', 'placeholder'), 'Ask — OpenRouter picks the model…');
    // back to auto: the count is editable again
    await dlg.locator('input[name="router-mode"][value="auto"]').check();
    assert.equal(await dlg.locator('input.router-count').isDisabled(), false);
    await page.waitForFunction(() => /^🧭 Auto ×\d$/.test(document.querySelector('#topbar .router-btn').textContent.trim()));
  },

  async 'decider list shows the six stars first and filters by images and free'(page) {
    await page.click('#topbar button.router-btn');
    const dlg = page.locator('#router-dialog');
    await dlg.locator('.decider-row').first().waitFor();
    const ids = () => dlg.locator('.decider-row').evaluateAll((rs) => rs.map((r) => r.dataset.id));
    const all = await ids();
    assert.deepEqual(all.slice(0, 6), ['liquid/d1-ultra', 'typesafe/jev-1.14', 'inception/mercury-decide',
      'perplexity/pplx-decider-v1.2', 'baseten/mammoth-1:free', 'baseten/elephant-1:free']);
    assert.deepEqual(all.slice(6), ['upstage/solar-decide']);
    const liquid = dlg.locator('.decider-row[data-id="liquid/d1-ultra"]');
    assert.match(await liquid.textContent(), /\$0\.042\/M in/);
    assert.match(await liquid.textContent(), /33k|32\.8k/);
    assert.match(await dlg.locator('.decider-row[data-id="baseten/mammoth-1:free"]').textContent(), /FREE/);
    assert.match(await dlg.locator('.decider-current').textContent(), /Decider V1\.2/);
    await dlg.locator('input.decider-free').check();
    assert.deepEqual(await ids(), ['baseten/mammoth-1:free', 'baseten/elephant-1:free']);
    await dlg.locator('input.decider-free').uncheck();
    await dlg.locator('input.decider-images').check();
    const img = await ids();
    assert.ok(!img.includes('baseten/mammoth-1:free') && !img.includes('baseten/elephant-1:free') && !img.includes('upstage/solar-decide'));
    assert.equal(img.length, 4);
    await dlg.locator('input.decider-images').uncheck();
    await dlg.locator('input.decider-search').fill('solar');
    await page.waitForFunction(() => document.querySelectorAll('#router-dialog .decider-row').length === 1);
    assert.deepEqual(await ids(), ['upstage/solar-decide']);
    // clicking a row chooses the decision model
    await dlg.locator('.decider-row[data-id="upstage/solar-decide"]').click();
    assert.match(await dlg.locator('.decider-current').textContent(), /Solar Decide/);
    const r = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')).router);
    assert.equal(r.decisionModel, 'upstage/solar-decide');
    assert.equal(r.mode, 'auto');
    assert.equal(await page.evaluate(() => MC.app.state.deciders.length), 7);
  },

  async 'starring a decider persists'(page) {
    await page.click('#topbar button.router-btn');
    const dlg = page.locator('#router-dialog');
    const star = dlg.locator('.decider-row[data-id="upstage/solar-decide"] .star');
    assert.equal((await star.textContent()).trim(), '☆');
    await star.click();
    await dlg.locator('.decider-row[data-id="upstage/solar-decide"] .star', { hasText: '★' }).waitFor();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')).starredDeciders);
    assert.equal(stored[stored.length - 1], 'upstage/solar-decide');
    assert.equal(stored.length, 7);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')).router.decisionModel), 'perplexity/pplx-decider-v1.2', 'starring does not choose');
    // unstar liquid: it leaves the ★ group
    await dlg.locator('.decider-row[data-id="liquid/d1-ultra"] .star').click();
    await page.reload(); await page.waitForSelector('.empty-state');
    await page.click('#topbar button.router-btn');
    await dlg.locator('.decider-row').first().waitFor();
    const ids = await dlg.locator('.decider-row').evaluateAll((rs) => rs.map((r) => r.dataset.id));
    assert.equal(ids[5], 'upstage/solar-decide');
    assert.equal(ids[6], 'liquid/d1-ultra');
    assert.equal((await dlg.locator('.decider-row[data-id="liquid/d1-ultra"] .star').textContent()).trim(), '☆');
  },

  async 'starred deciders missing from the catalog are greyed'(page) {
    await page.click('#topbar button.router-btn');
    const dlg = page.locator('#router-dialog');
    const row = dlg.locator('.decider-row.unavailable');
    await row.first().waitFor();
    assert.equal(await row.count(), 6);
    assert.match(await row.first().textContent(), /not available right now/);
  },

  async 'every router option has an info button'(page) {
    await page.click('#topbar button.router-btn');
    const dlg = page.locator('#router-dialog');
    assert.ok(await dlg.locator('.info').count() >= 9);
    const texts = await dlg.locator('.tip').evaluateAll((ts) => ts.map((t) => t.textContent));
    assert.ok(texts.some((t) => t.startsWith('When on, a decision model chooses which of your models answer')));
    assert.ok(texts.some((t) => t.startsWith('OpenRouter\'s own Auto Router picks one model per message')));
    assert.ok(texts.some((t) => t.startsWith('How many models answer each routed message.')));
    // mode-specific rows carry their own ⓘ
    await dlg.locator('input[name="router-mode"][value="free"]').check();
    assert.equal(await dlg.locator('.row-paid').isVisible(), true);
    assert.equal(await dlg.locator('.row-paid .info').count(), 1);
    await dlg.locator('input[name="router-mode"][value="best"]').check();
    assert.equal(await dlg.locator('.row-paid').isHidden(), true);
    assert.equal(await dlg.locator('.row-extras .info').count(), 2);
  },

  async 'router panel fits a phone-width screen'(page) {
    await page.setViewportSize({ width: 375, height: 740 });
    // the toolbar scrolls instead of pushing ⚙ off the page
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    await page.locator('#topbar button[aria-label="Settings"]').scrollIntoViewIfNeeded();
    await page.click('#topbar button.router-btn');
    const dlg = page.locator('#router-dialog');
    await dlg.locator('.decider-row').first().waitFor();
    const over = await page.evaluate(() => {
      const d = document.querySelector('#router-dialog');
      return { scroll: d.scrollWidth - d.clientWidth, right: d.getBoundingClientRect().right - window.innerWidth };
    });
    assert.ok(over.scroll <= 1, 'no horizontal scroll inside the panel: ' + over.scroll);
    assert.ok(over.right <= 0, 'panel inside the viewport');
  },
};
cases['starred deciders missing from the catalog are greyed'].opts = { noDeciders: true };

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
