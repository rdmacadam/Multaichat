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
const PNG = { name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };
// Models of the chat (streamed) requests sent so far.
const chatModels = (page) => page.requests.filter((r) => r.stream).map((r) => r.model);
const convInfo = (page) => page.evaluate(() => ({ active: MC.app.state.conv.lanes.filter((l) => l.active).map((l) => l.modelId) }));
// localStorage seed for router settings (and other settings).
// The router picks a chat's models once; this arms it for the next message.
const reroute = (page) => page.click('.router-chip .router-reroute');
const routerInit = (router, extra) => ({ 'mc.settings': JSON.stringify(Object.assign({ router: Object.assign({ enabled: true }, router) }, extra)) });

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
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mc.settings')).router.count), 3, 'native does not overwrite the saved count');
    // back to auto: the count is editable again and is still the saved one
    await dlg.locator('input[name="router-mode"][value="auto"]').check();
    assert.equal(await dlg.locator('input.router-count').isDisabled(), false);
    await page.waitForFunction(() => document.querySelector('#topbar .router-btn').textContent.trim() === '🧭 Auto ×3');
    assert.equal(await dlg.locator('input.router-count').inputValue(), '3');
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
    // Escape on a focused ⓘ closes only its tip, not the panel
    const i = dlg.locator('.row-extras .info').first();
    await i.focus();
    assert.equal(await dlg.locator('.row-extras .tip').first().isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dlg.locator('.row-extras .tip').first().isHidden(), true);
    await page.waitForTimeout(200);
    assert.equal(await dlg.isVisible(), true, 'the panel stays open');
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
  // ---------- routed sending (Task 9) ----------

  async 'auto mode routes to the top N and shows the route bar'(page) {
    await ask(page, 'Plan a trip');
    await allDone(page, 1);
    assert.equal(page.decisions.length, 1);
    assert.equal(page.decisions[0].model, 'perplexity/pplx-decider-v1.2');
    const ranked = Object.keys(page.decisions[0].questions.pick.criteria);
    const want = ranked.slice(0, 2);
    assert.deepEqual(chatModels(page).sort(), want.slice().sort());
    assert.equal(await page.locator('.turn .cell.status-done').count(), 2);
    const conv = await convInfo(page);
    const unpicked = conv.active.filter((id) => !want.includes(id));
    assert.equal(await page.locator('.turn .cell.not-routed').count(), unpicked.length);
    if (unpicked.length) assert.equal((await page.locator('.turn .cell.not-routed').first().textContent()).trim(), '— not routed this turn');
    // the toolbar shows the picked models as active lanes
    for (const id of want) assert.ok(conv.active.includes(id), id + ' joined the chat');
    const bar = page.locator('.turn .route-bar');
    assert.equal(await bar.count(), 1);
    const text = await bar.textContent();
    assert.match(text, /🧭 Full auto/);
    assert.match(text, /Decider V1\.2/);
    assert.match(text, /task: chat/);
    assert.match(text, /\d\.\d s/);
    assert.match(text, / 50 %/);
    assert.match(text, /candidates \(\d+\)/);
    // the bar sits above the answers
    assert.equal(await page.evaluate(() => document.querySelector('.turn .route-bar').nextElementSibling.classList.contains('lanes')), true);
    // the route is stored with the turn
    const route = await page.evaluate(() => MC.app.state.conv.turns[0].route);
    assert.equal(route.method, 'model');
    assert.deepEqual(route.picks.map((p) => p.modelId), want);
    // the composer is cleared
    assert.equal(await page.inputValue('#prompt'), '');
  },

  async 'an image is never routed to a model without image input'(page) {
    await page.setInputFiles('#composer input.attach-input', PNG);
    await ask(page, 'What is this?');
    await allDone(page, 1);
    assert.equal(await page.locator('#attach-dialog').isVisible(), false, 'no capability dialog');
    const imageIds = ['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro', 'meta-llama/llama-5-405b'];
    const models = chatModels(page);
    assert.equal(models.length, 3);
    for (const m of models) assert.ok(imageIds.includes(m), m + ' reads images');
    for (const id of Object.keys(page.decisions[0].questions.pick.criteria)) assert.ok(imageIds.includes(id), id);
    // the image reached the decider and the answering models
    assert.ok(page.decisions[0].state.some((p) => p && p.type === 'image_url'));
    for (const b of page.requests.filter((r) => r.stream)) {
      const last = b.messages[b.messages.length - 1];
      assert.ok(Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url'), 'image sent to ' + b.model);
    }
    assert.equal(await page.locator('.turn .att-thumb').count(), 1);
    assert.equal(await page.locator('#composer .att-chip').count(), 0, 'tray cleared');
  },

  async 'picker filters restrict the decision candidates'(page) {
    await ask(page);
    await allDone(page, 1);
    const ids = Object.keys(page.decisions[0].questions.pick.criteria).sort();
    assert.deepEqual(ids, ['anthropic/claude-sonnet-5', 'google/gemini-3-pro']);
    assert.match(await page.textContent('.route-bar'), /only 2 models fit \(filters\)/);
  },

  async 'selection pool only offers the toolbar models'(page) {
    const selected = await page.evaluate(() => MC.app.state.settings.get().selected);
    await ask(page);
    await allDone(page, 1);
    assert.deepEqual(Object.keys(page.decisions[0].questions.pick.criteria).sort(), selected.slice().sort());
    for (const m of chatModels(page)) assert.ok(selected.includes(m));
  },

  async 'diverse mode picks distinct providers'(page) {
    await ask(page);
    await allDone(page, 1);
    assert.match(page.decisions[0].questions.pick.instructions, /different perspectives/);
    const models = chatModels(page);
    assert.equal(models.length, 3);
    assert.equal(new Set(models.map((m) => m.split('/')[0])).size, 3);
    assert.match(await page.textContent('.route-bar'), /🧭 Diverse perspectives/);
  },

  async 'best free without free deciders uses rules and makes no decision request'(page) {
    await ask(page);
    await allDone(page, 1);
    assert.equal(page.decisions.length, 0);
    const models = chatModels(page);
    assert.equal(models.length, 2);
    const free = await page.evaluate((ids) => ids.map((id) => MC.app.modelById(id).free), models);
    assert.deepEqual(free, [true, true]);
    const text = await page.textContent('.route-bar');
    assert.match(text, /🧭 Best free · picked by rules/);
    assert.match(text, /no free decision model available/);
  },

  async 'decision 429 falls back to the next starred decider, then rules with a note'(page, opts) {
    await ask(page, 'first');
    await allDone(page, 1);
    assert.deepEqual(page.decisions.map((d) => d.model), ['perplexity/pplx-decider-v1.2', 'liquid/d1-ultra']);
    let bar = await page.locator('.route-bar').last().textContent();
    assert.match(bar, /d1-ultra/);
    assert.equal(chatModels(page).length, 2);
    opts.decideStatus['liquid/d1-ultra'] = 500;
    await reroute(page);
    await ask(page, 'second');
    await allDone(page, 2);
    assert.equal(page.decisions.length, 4, 'two more tries, no third decider');
    bar = await page.locator('.route-bar').last().textContent();
    assert.match(bar, /picked by rules/);
    assert.match(bar, /decision failed/);
    assert.equal(await page.evaluate(() => MC.app.state.conv.turns[1].route.method), 'rules');
  },

  async 'preview: remove a pick, cancel keeps the text, send uses the edited picks'(page) {
    await ask(page, 'Preview me');
    const dlg = page.locator('#route-preview-dialog');
    await dlg.waitFor({ state: 'visible' });
    assert.equal(await dlg.locator('.pick-chip').count(), 3);
    assert.match(await dlg.locator('.pick-chip').first().textContent(), /50 %/);
    await dlg.locator('.pick-chip .chip-x').first().click();
    assert.equal(await dlg.locator('.pick-chip').count(), 2);
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dlg.waitFor({ state: 'hidden' });
    assert.equal(await page.inputValue('#prompt'), 'Preview me');
    assert.equal(chatModels(page).length, 0);
    assert.equal(await page.locator('.turn').count(), 0);

    // again: remove all picks → Send disabled; add one from the pool; send
    await page.press('#prompt', 'Enter');
    await dlg.waitFor({ state: 'visible' });
    const first = await dlg.locator('.pick-chip').first().getAttribute('data-id');
    while (await dlg.locator('.pick-chip').count()) await dlg.locator('.pick-chip .chip-x').first().click();
    assert.equal(await dlg.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    const add = dlg.locator('select.pick-add');
    const options = await add.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    assert.ok(options.includes(first), 'removed picks return to the pool: ' + first + ' in ' + options.join(','));
    const other = options.find((v) => v !== first);
    await add.selectOption(first);
    await add.selectOption(other);
    assert.equal(await dlg.locator('.pick-chip').count(), 2);
    await dlg.getByRole('button', { name: 'Send', exact: true }).click();
    await allDone(page, 1);
    assert.deepEqual(chatModels(page).sort(), [first, other].sort());
    const route = await page.evaluate(() => MC.app.state.conv.turns[0].route);
    assert.deepEqual(route.picks.map((p) => p.modelId), [first, other]);
    assert.equal(await page.inputValue('#prompt'), '');

    // "Send to my selection instead" sends to the toolbar models without routing
    const before = page.decisions.length;
    await reroute(page);
    await ask(page, 'All of you');
    await dlg.waitFor({ state: 'visible' });
    await dlg.getByRole('button', { name: 'Send to my selection instead' }).click();
    await allDone(page, 2);
    assert.equal(page.decisions.length, before + 1);
    const t = await page.evaluate(() => { const c = MC.app.state.conv; const t = c.turns[1]; return { route: !!t.route, n: Object.keys(t.inputs).length, active: c.lanes.filter((l) => l.active).length }; });
    assert.equal(t.route, false);
    assert.equal(t.n, t.active);
  },

  async 'native mode sends openrouter/auto with allowed_models and session_id; shows answered by'(page) {
    const selected = await page.evaluate(() => MC.app.state.settings.get().selected);
    await ask(page);
    await allDone(page, 1);
    assert.equal(page.decisions.length, 0);
    let chat = page.requests.filter((r) => r.stream);
    assert.equal(chat.length, 1);
    const convId = await page.evaluate(() => MC.app.state.conv.id);
    assert.equal(chat[0].model, 'openrouter/auto');
    assert.equal(chat[0].session_id, convId);
    const plugin = chat[0].plugins.find((p) => p.id === 'auto-router');
    assert.deepEqual(plugin.allowed_models.slice().sort(), selected.slice().sort());
    const lane = await page.evaluate(() => MC.app.state.conv.lanes.find((l) => l.modelId === 'openrouter/auto'));
    assert.equal(lane.modelName, 'OpenRouter Auto');
    assert.equal((await page.textContent('.cell.status-done .served')).trim(), '→ answered by GPT-6');
    assert.equal(await page.locator('.turn .cell.not-routed').count(), 0, 'the chat holds only the native lane');
    assert.match(await page.textContent('.route-bar'), /🧭 OpenRouter Auto · answered by GPT-6/);
    // a second message goes to the native lane with the same allowed pool, no new decision
    await ask(page, 'again');
    await allDone(page, 2);
    chat = page.requests.filter((r) => r.stream);
    assert.equal(chat.length, 2);
    assert.deepEqual(chat[1].plugins.find((p) => p.id === 'auto-router').allowed_models.slice().sort(), selected.slice().sort());
  },

  async 'targeted reply bypasses the router'(page) {
    await ask(page);
    await allDone(page, 1);
    assert.equal(page.decisions.length, 1);
    await page.locator('.turn .cell.status-done').first().getByRole('button', { name: '↳ Reply' }).click();
    await ask(page, 'just you');
    await allDone(page, 2);
    assert.equal(page.decisions.length, 1, 'no new decision');
    const t = await page.evaluate(() => MC.app.state.conv.turns[1]);
    assert.equal(t.kind, 'targeted');
    assert.equal(t.route, undefined);
    assert.equal(await page.locator('.turn').last().locator('.route-bar').count(), 0);
  },

  async 'Stop while routing sends nothing and keeps the text'(page) {
    await ask(page, 'Keep me');
    await page.waitForFunction(() => /🧭 routing…/.test(document.querySelector('#composer').textContent));
    const stop = page.locator('#composer button.danger');
    assert.equal(await stop.isVisible(), true, 'Stop is offered while routing');
    await page.focus('#prompt');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !/🧭 routing…/.test(document.querySelector('#composer').textContent));
    await page.waitForTimeout(2300);
    assert.equal(await page.inputValue('#prompt'), 'Keep me');
    assert.equal(chatModels(page).length, 0);
    assert.equal(await page.locator('.turn').count(), 0);
    assert.equal(await page.locator('.toast').count(), 0, 'no toast for a stop');
    // the Stop button aborts too
    await page.press('#prompt', 'Enter');
    await page.waitForFunction(() => /🧭 routing…/.test(document.querySelector('#composer').textContent));
    await stop.click();
    await page.waitForFunction(() => !/🧭 routing…/.test(document.querySelector('#composer').textContent));
    assert.equal(await page.inputValue('#prompt'), 'Keep me');
    assert.equal(await page.locator('.turn').count(), 0);
  },

  async 'very best with judge marks the best answer and the counter includes the judge'(page) {
    await ask(page, 'Which is best?');
    await allDone(page, 1);
    await page.waitForSelector('.cell .badge.best');
    assert.equal(await page.locator('.badge.best').count(), 1);
    assert.match(await page.textContent('.badge.best'), /^🏆 best \(70 %\)$/);
    assert.equal(await page.locator('.cell:has(.badge.best) .cell-head .badge.best').count(), 1);
    assert.equal(page.decisions.length, 2, 'one pick decision and one judge decision');
    const judge = page.decisions[1];
    assert.deepEqual(Object.keys(judge.questions), ['best']);
    const j = await page.evaluate(() => MC.app.state.conv.turns[0].judge);
    assert.equal(j.status, 'done');
    // the counter includes the judge
    await page.focus('.cost-wrap .info');
    await page.waitForFunction(() => /Judge: /.test(document.querySelector('.cost-wrap .tip').textContent));
    // Judge again replaces the verdict and moves the old cost to spentReplaced
    const again = page.locator('.route-bar button', { hasText: 'Judge again' });
    await again.waitFor();
    assert.equal(await again.isDisabled(), false);
    await again.click();
    await page.waitForFunction(() => MC.app.state.conv.turns[0].judge.createdAt !== undefined && MC.app.state.conv.turns[0].spentReplaced && MC.app.state.conv.turns[0].spentReplaced.judge > 0);
    await page.waitForFunction(() => MC.app.state.conv.turns[0].judge.status === 'done');
    assert.equal(page.decisions.length, 3);
    assert.equal(await page.locator('.badge.best').count(), 1);
  },

  async 'very best with fuse renders a Fusion'(page) {
    await ask(page, 'Merge please');
    await allDone(page, 1);
    await page.waitForSelector('.derived-card.fusion .topic');
    assert.equal(await page.locator('.badge.best').count(), 0, 'no judge, no badge');
    assert.equal(await page.locator('.route-bar button', { hasText: 'Judge again' }).count(), 0);
    // exactly one Fusion request (json_object response format)
    assert.equal(page.requests.filter((r) => r.response_format).length, 1);
  },

  async 'auto Fusion and the fuse extra run Fusion once'(page) {
    await ask(page, 'Once only');
    await allDone(page, 1);
    await page.waitForSelector('.derived-card.fusion .topic');
    await page.waitForTimeout(500);
    assert.equal(page.requests.filter((r) => r.response_format).length, 1);
  },

  async 'New chat or opening another chat while routing sends nothing into the other chat'(page) {
    const routing = () => page.waitForFunction(() => /🧭 routing…/.test(document.querySelector('#composer').textContent));
    const inputsOf = (id) => page.evaluate((i) => MC.app.state.store.get(i).then((c) => c.turns.map((t) => Object.values(t.inputs)[0])), id);
    await ask(page, 'Chat A first');
    await allDone(page, 1);
    const aId = await page.evaluate(() => MC.app.state.conv.id);
    const sent = chatModels(page).length;
    await reroute(page);
    // New chat while routing in chat A
    await ask(page, 'SECRET for A');
    await routing();
    await page.click('#sidebar button:has-text("New chat")');
    await page.waitForTimeout(1600);
    assert.equal(await page.evaluate(() => MC.app.state.conv), null, 'still the new, empty chat');
    assert.equal(await page.inputValue('#prompt'), 'SECRET for A', 'composer keeps the text');
    assert.equal(chatModels(page).length, sent, 'nothing sent');
    assert.deepEqual(await inputsOf(aId), ['Chat A first']);
    assert.equal(await page.locator('.turn').count(), 0);
    // opening chat A while routing in the new chat
    await page.fill('#prompt', 'SECRET for the new chat');
    await page.press('#prompt', 'Enter');
    await routing();
    await page.click(`#sidebar li.conv[data-id="${aId}"] .conv-open`);
    await page.waitForTimeout(1600);
    assert.equal(await page.evaluate(() => MC.app.state.conv.id), aId);
    assert.equal(await page.inputValue('#prompt'), 'SECRET for the new chat');
    assert.equal(chatModels(page).length, sent, 'nothing sent');
    assert.deepEqual(await inputsOf(aId), ['Chat A first']);
    assert.equal(await page.locator('.turn').count(), 1);
    assert.equal((await page.evaluate(() => MC.app.state.store.list())).length, 1, 'no new chat was stored');
  },

  async 'chat changed while the preview is open: nothing sent, decision still counted'(page) {
    const dlg = page.locator('#route-preview-dialog');
    await ask(page, 'Chat A first');
    await dlg.waitFor({ state: 'visible' });
    await dlg.getByRole('button', { name: 'Send', exact: true }).click();
    await allDone(page, 1);
    const aId = await page.evaluate(() => MC.app.state.conv.id);
    const sent = chatModels(page).length;
    await reroute(page);
    await ask(page, 'SECRET for A');
    await dlg.waitFor({ state: 'visible' });
    await page.evaluate(() => MC.app.newChat());
    await dlg.getByRole('button', { name: 'Send', exact: true }).click();
    await dlg.waitFor({ state: 'hidden' });
    await page.waitForSelector('.toast:has-text("Chat changed — message not sent")');
    assert.equal(await page.evaluate(() => MC.app.state.conv), null);
    assert.equal(await page.inputValue('#prompt'), 'SECRET for A');
    assert.equal(chatModels(page).length, sent, 'nothing sent');
    const a = await page.evaluate((i) => MC.app.state.store.get(i), aId);
    assert.equal(a.turns.length, 1);
    assert.equal(await page.evaluate((c) => MC.cost.summary(c).parts.router, a), 0.000004, 'chat A counts both decisions');
  },

  async 'cancelled preview and "my selection instead" still count the decision in Σ'(page) {
    const dlg = page.locator('#route-preview-dialog');
    const router = () => page.evaluate(() => MC.cost.summary(MC.app.state.conv).parts.router);
    await ask(page, 'Cancel me');
    await dlg.waitFor({ state: 'visible' });
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dlg.waitFor({ state: 'hidden' });
    await page.press('#prompt', 'Enter');
    await dlg.waitFor({ state: 'visible' });
    await dlg.getByRole('button', { name: 'Send', exact: true }).click();
    await allDone(page, 1);
    assert.equal(page.decisions.length, 2);
    assert.equal(await router(), 0.000004, 'the cancelled decision counts too');
    await reroute(page);
    await ask(page, 'All of you');
    await dlg.waitFor({ state: 'visible' });
    await dlg.getByRole('button', { name: 'Send to my selection instead' }).click();
    await allDone(page, 2);
    assert.equal(await router(), 0.000006);
    await page.reload(); await page.waitForSelector('.turn');
    assert.equal(await router(), 0.000006, 'survives reload');
    await page.focus('.cost-wrap .info');
    assert.match(await tip(page).textContent(), /Router decisions/);
  },

  async 'judge without probabilities still shows the best badge'(page) {
    await ask(page, 'Which is best?');
    await allDone(page, 1);
    await page.waitForFunction(() => MC.app.state.conv.turns[0].judge && MC.app.state.conv.turns[0].judge.status === 'done');
    assert.equal(await page.evaluate(() => MC.app.state.conv.turns[0].judge.p), null);
    await page.waitForSelector('.cell .badge.best');
    assert.equal(await page.locator('.badge.best').count(), 1);
    assert.equal((await page.textContent('.badge.best')).trim(), '🏆 best');
  },

  async 'a free decision shows "free" in the route bar'(page) {
    await ask(page);
    await allDone(page, 1);
    const bar = await page.textContent('.route-bar');
    assert.match(bar, / · free · /);
    assert.doesNotMatch(bar, /<\$0\.0001/);
  },
  async 'the router picks once: the first message creates only the picked columns'(page) {
    await ask(page, 'Plan a trip');
    await allDone(page, 1);
    const want = Object.keys(page.decisions[0].questions.pick.criteria).slice(0, 2);
    const conv = await convInfo(page);
    assert.deepEqual(conv.active.slice().sort(), want.slice().sort(), 'only the picks are in the chat');
    assert.equal(await page.locator('.turn .cell.not-routed').count(), 0);
  },

  async 'later messages go to the picked models without a new decision'(page) {
    await ask(page, 'Plan a trip');
    await allDone(page, 1);
    const want = Object.keys(page.decisions[0].questions.pick.criteria).slice(0, 2);
    const before = page.requests.filter((r) => r.stream).length;
    await ask(page, 'Make it 5 days');
    await allDone(page, 2);
    assert.equal(page.decisions.length, 1, 'no second decision');
    assert.deepEqual(chatModels(page).slice(before).sort(), want.slice().sort());
    assert.equal(await page.locator('.turn').nth(1).locator('.route-bar').count(), 0);
    assert.match(await page.locator('.router-chip').textContent(), /Re-route next/);
  },

  async 're-route next makes one new decision and replaces unpicked models'(page) {
    await ask(page, 'Plan a trip');
    await allDone(page, 1);
    await page.click('.router-chip .router-reroute');
    assert.match(await page.locator('.router-chip').textContent(), /Next message is re-routed/);
    await page.reload();
    await page.waitForSelector('.turn');
    assert.match(await page.locator('.router-chip').textContent(), /Next message is re-routed/, 'armed re-route survives reload');
    await ask(page, 'Now something about code');
    await allDone(page, 2);
    assert.equal(page.decisions.length, 2);
    const want = Object.keys(page.decisions[1].questions.pick.criteria).slice(0, 2);
    const conv = await convInfo(page);
    assert.deepEqual(conv.active.slice().sort(), want.slice().sort());
    await ask(page, 'Thanks');
    await allDone(page, 3);
    assert.equal(page.decisions.length, 2, 'the following message is not routed again');
  },

  async 'turning the router on in an existing chat routes nothing until re-route'(page) {
    await page.evaluate(() => { const s = MC.app.state.settings; s.set({ router: MC.router.withDefaults(Object.assign(s.get().router, { enabled: false })) }); MC.app.refresh(); });
    await ask(page, 'Hello');
    await allDone(page, 1);
    await page.evaluate(() => { const s = MC.app.state.settings; s.set({ router: MC.router.withDefaults(Object.assign(s.get().router, { enabled: true })) }); MC.app.refresh(); });
    await ask(page, 'Second');
    await allDone(page, 2);
    assert.equal(page.decisions.length, 0);
    await page.click('.router-chip .router-reroute');
    await ask(page, 'Third');
    await allDone(page, 3);
    assert.equal(page.decisions.length, 1);
  },
};
cases['starred deciders missing from the catalog are greyed'].opts = { noDeciders: true };
cases['the router picks once: the first message creates only the picked columns'].init = routerInit({ mode: 'auto', count: 2, pool: 'catalog' });
cases['later messages go to the picked models without a new decision'].init = routerInit({ mode: 'auto', count: 2, pool: 'catalog' });
cases['re-route next makes one new decision and replaces unpicked models'].init = routerInit({ mode: 'auto', count: 2, pool: 'catalog' });
cases['turning the router on in an existing chat routes nothing until re-route'].init = routerInit({ mode: 'auto', count: 2, pool: 'catalog' });
cases['auto mode routes to the top N and shows the route bar'].init = routerInit({ mode: 'auto', count: 2, pool: 'catalog' });
cases['an image is never routed to a model without image input'].init = routerInit({ mode: 'auto', count: 3, pool: 'catalog' });
cases['picker filters restrict the decision candidates'].init = routerInit({ mode: 'auto', count: 3 }, { pickerFilters: { maxIn: '', maxOut: '', minContext: '', images: false, files: true } });
cases['selection pool only offers the toolbar models'].init = routerInit({ mode: 'auto', count: 2, pool: 'selection' });
cases['diverse mode picks distinct providers'].init = routerInit({ mode: 'diverse', count: 3 });
cases['best free without free deciders uses rules and makes no decision request'].init = routerInit({ mode: 'free', count: 2 });
cases['best free without free deciders uses rules and makes no decision request'].opts = { noDeciders: true };
cases['decision 429 falls back to the next starred decider, then rules with a note'].init = routerInit({ mode: 'auto', count: 2 });
cases['decision 429 falls back to the next starred decider, then rules with a note'].opts = { decideStatus: { 'perplexity/pplx-decider-v1.2': 429 } };
cases['preview: remove a pick, cancel keeps the text, send uses the edited picks'].init = routerInit({ mode: 'auto', count: 3, preview: true });
cases['native mode sends openrouter/auto with allowed_models and session_id; shows answered by'].init = routerInit({ mode: 'native', pool: 'selection' });
cases['targeted reply bypasses the router'].init = routerInit({ mode: 'auto', count: 2 });
cases['Stop while routing sends nothing and keeps the text'].init = routerInit({ mode: 'auto', count: 2 });
cases['Stop while routing sends nothing and keeps the text'].opts = { decideDelay: 2000 };
cases['very best with judge marks the best answer and the counter includes the judge'].init = routerInit({ mode: 'best', count: 3, extras: { judge: true } });
cases['very best with fuse renders a Fusion'].init = routerInit({ mode: 'best', count: 3, extras: { fusion: true } });
cases['auto Fusion and the fuse extra run Fusion once'].init = routerInit({ mode: 'best', count: 3, extras: { fusion: true } }, { autoFusion: true });

cases['New chat or opening another chat while routing sends nothing into the other chat'].init = routerInit({ mode: 'auto', count: 2 });
cases['New chat or opening another chat while routing sends nothing into the other chat'].opts = { decideDelay: 1200 };
cases['chat changed while the preview is open: nothing sent, decision still counted'].init = routerInit({ mode: 'auto', count: 2, preview: true });
cases['cancelled preview and "my selection instead" still count the decision in Σ'].init = routerInit({ mode: 'auto', count: 2, preview: true });
cases['judge without probabilities still shows the best badge'].init = routerInit({ mode: 'best', count: 3, extras: { judge: true } });
cases['judge without probabilities still shows the best badge'].opts = { judgeNoProb: true };
cases['a free decision shows "free" in the route bar'].init = routerInit({ mode: 'auto', count: 2 });
cases['a free decision shows "free" in the route bar'].opts = { decisionCost: 0 };

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
      await fn(page, fn.opts);
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
