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
const openPresets = async (page) => { await page.click('#topbar button:has-text("Presets")'); await page.waitForSelector('#presets-dialog[open]'); };
const applyPresetNamed = (page, name) => page.locator('#presets-dialog .preset-row', { hasText: name }).locator('button:has-text("Apply")').click();
// Creates a version-1 database holding two chats, as the production app (v1) leaves it.
async function seedV1(page) {
  await page.goto(base + 'tests/fixtures/models.json');
  await page.evaluate(() => new Promise((res, rej) => {
    const d = indexedDB.deleteDatabase('multaichat');
    d.onsuccess = res; d.onerror = () => rej(d.error); d.onblocked = () => rej(new Error('delete blocked'));
  }));
  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('multaichat', 1);
    r.onupgradeneeded = () => { const os = r.result.createObjectStore('conversations', { keyPath: 'id' }); os.createIndex('updatedAt', 'updatedAt'); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('conversations', 'readwrite');
      for (const [id, title, n] of [['c_old1', 'Old chat A', 1], ['c_old2', 'Old chat B', 2]]) {
        tx.objectStore('conversations').put({
          id, title, createdAt: n, updatedAt: n,
          lanes: [{ id: 'l_1', modelId: 'openai/gpt-6', modelName: 'OpenAI: GPT-6', active: true, joinedAtTurn: 0 }],
          turns: [{ id: 't_' + n, index: 0, createdAt: n, kind: 'broadcast', inputs: { l_1: 'old question' },
            responses: { l_1: { status: 'done', content: 'old answer ' + title.slice(-1), previous: [], asksQuestion: false } } }],
        });
      }
      tx.oncomplete = () => { db.close(); res(); };
    };
  }));
}
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

  async 'apply preset to new chat'(page) {
    await openPresets(page);
    await applyPresetNamed(page, 'Code reviewer');
    assert.equal((await page.textContent('.sys-chip')).trim(), '📝 Code reviewer');
    assert.ok((await page.inputValue('#prompt')).startsWith('Review this code:'));
    await page.fill('#prompt', 'Review this code:\n\nlet x = 1');
    await page.press('#prompt', 'Enter');
    await allDone(page, 1);
    assert.equal(page.requests.length, 3);
    for (const r of page.requests) {
      assert.equal(r.messages[0].role, 'system');
      assert.match(r.messages[0].content, /^You are a meticulous senior code reviewer\./);
    }
  },

  async 'save current as preset round-trip'(page) {
    await page.click('.sys-add');
    await page.fill('#sysprompt-dialog textarea', 'Custom rules');
    await page.click('#sysprompt-dialog button[type=submit]');
    assert.equal((await page.textContent('.sys-chip')).trim(), '📝 Custom');
    await page.locator('#topbar .chip-x').last().click();
    const models = await page.$$eval('#topbar .chip', (cs) => cs.map((c) => c.title));
    assert.equal(models.length, 2);
    await page.fill('#prompt', 'Summarize:');
    await openPresets(page);
    await page.click('#presets-dialog button:has-text("Save current as preset")');
    await page.fill('#preset-save-dialog input[name=name]', 'Mine');
    assert.equal(await page.inputValue('#preset-save-dialog textarea[name=systemPrompt]'), 'Custom rules');
    assert.equal(await page.inputValue('#preset-save-dialog textarea[name=template]'), 'Summarize:');
    await page.click('#preset-save-dialog button[type=submit]');
    assert.equal(await page.locator('#presets-dialog .preset-row', { hasText: 'Mine' }).count(), 1, 'list shows the new preset');
    await page.click('#presets-dialog button[aria-label=Close]');
    await page.click('button:has-text("+ New chat")');
    await page.evaluate(() => MC.app.setSelection(['x-ai/grok-5', 'qwen/qwen4-coder', 'openai/gpt-6']));
    await page.fill('#prompt', '');
    assert.equal(await page.locator('.sys-chip').count(), 0);
    await openPresets(page);
    await applyPresetNamed(page, 'Mine');
    assert.equal((await page.textContent('.sys-chip')).trim(), '📝 Mine');
    assert.deepEqual(await page.$$eval('#topbar .chip', (cs) => cs.map((c) => c.title)), models);
    assert.equal(await page.inputValue('#prompt'), 'Summarize:');
  },

  async 'edited preset offers update'(page) {
    await page.evaluate(() => MC.app.state.presets.save({ id: 'p_mine', name: 'Mine', systemPrompt: 'one' }));
    await openPresets(page);
    await applyPresetNamed(page, 'Mine');
    await page.click('.sys-chip');
    await page.fill('#sysprompt-dialog textarea', 'two');
    await page.click('#sysprompt-dialog button[type=submit]');
    assert.equal((await page.textContent('.sys-chip')).trim(), '📝 Mine (edited)');
    await page.click('.sys-chip');
    assert.equal(await page.locator('#sysprompt-dialog button:has-text("Update preset")').count(), 1);
    await page.click('#sysprompt-dialog button:has-text("Update preset")');
    assert.equal(await page.evaluate(() => MC.app.state.presets.get('p_mine').systemPrompt), 'two');
    assert.equal((await page.textContent('.sys-chip')).trim(), '📝 Mine');
    await openPresets(page);
    await applyPresetNamed(page, 'Concise expert');
    await page.click('.sys-chip');
    await page.fill('#sysprompt-dialog textarea', 'changed');
    await page.click('#sysprompt-dialog button[type=submit]');
    await page.click('.sys-chip');
    assert.equal(await page.locator('#sysprompt-dialog button:has-text("Update preset")').count(), 0);
    assert.equal(await page.locator('#sysprompt-dialog button:has-text("Save as new preset")').count(), 1);
  },

  async 'default preset applies to new chats'(page) {
    await page.click('button[aria-label=Settings]');
    await page.selectOption('#settings-dialog select[name=defaultPreset]', 'builtin-simple');
    await page.click('#settings-dialog button[type=submit]');
    await page.click('button:has-text("+ New chat")');
    assert.equal((await page.textContent('.sys-chip')).trim(), '📝 Explain simply');
  },

  async 'presets in export'(page) {
    await page.evaluate(() => MC.app.state.presets.save({ name: 'Mine', systemPrompt: 'one' }));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export all")')]);
    const json = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
    assert.deepEqual(json.presets.map((p) => p.name), ['Mine']);
  },

  async 'v1 database upgrades with chats intact'(page) {
    await seedV1(page);
    await page.goto(base);
    await page.waitForSelector('.conv');
    assert.equal(await page.locator('.conv').count(), 2);
    assert.equal(await page.evaluate(() => MC.app.state.store.kind), 'idb');
    await page.locator('.conv-open', { hasText: 'Old chat B' }).click();
    await page.waitForSelector('.turn');
    assert.ok((await page.textContent('.turn')).includes('old answer B'));
    const info = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('multaichat');
      r.onsuccess = () => { const db = r.result; res({ v: db.version, stores: [...db.objectStoreNames].sort() }); db.close(); };
    }));
    assert.deepEqual(info, { v: 2, stores: ['attachments', 'conversations'] });
  },

  async 'upgrade waits for an old tab instead of losing history'(page) {
    await seedV1(page);
    const old = await page.context().newPage();
    await old.goto(base + 'tests/fixtures/models.json');
    await old.evaluate(() => new Promise((res) => { const r = indexedDB.open('multaichat', 1); r.onsuccess = () => { window.held = r.result; res(); }; }));
    await page.goto(base);
    await page.waitForTimeout(800);
    await old.close();
    await page.waitForSelector('.conv');
    assert.equal(await page.locator('.conv').count(), 2);
    assert.equal(await page.evaluate(() => MC.app.state.store.kind), 'idb');
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

