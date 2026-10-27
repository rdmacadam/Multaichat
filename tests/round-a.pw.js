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
const PNG = { name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };
const PDF = { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n') };
const LLAMA = 'meta-llama/llama-3.3-70b-instruct:free';
const attachFiles = (page, files) => page.setInputFiles('#composer input.attach-input', files);
async function pasteFile(page, f) {
  await page.evaluate(({ name, type, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, { name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') });
}
const useFourModels = (page) => page.evaluate((l) => MC.app.setSelection(['anthropic/claude-sonnet-5', 'openai/gpt-6', 'google/gemini-3-pro', l]), LLAMA);
const reqFor = (page, model) => page.requests.filter((r) => r.model === model).pop();
const lastUser = (req) => req.messages.filter((m) => m.role === 'user').pop();
const laneCell = (page, turn, col) => page.locator('.turn').nth(turn).locator(`.cell[data-col="${col}"]`);
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

  async 'attach image via button and pdf via paste'(page) {
    await attachFiles(page, [PNG]);
    await pasteFile(page, PDF);
    assert.equal(await page.locator('#composer .att-chip').count(), 2);
    await ask(page, 'What is this?');
    await allDone(page, 1);
    assert.equal(await page.locator('.turn .att-thumb').count(), 1);
    assert.equal(await page.locator('.turn .att-file').count(), 1);
    assert.equal(await page.locator('#composer .att-chip').count(), 0, 'chips cleared after send');
    const claude = reqFor(page, 'anthropic/claude-sonnet-5');
    const types = lastUser(claude).content.map((p) => p.type);
    assert.deepEqual(types, ['text', 'image_url', 'file']);
    assert.equal(claude.plugins[0].pdf.engine, 'native');
    assert.equal(reqFor(page, 'openai/gpt-6').plugins[0].pdf.engine, 'pdf-text');
  },

  async 'capability dialog skip'(page) {
    await useFourModels(page);
    await attachFiles(page, [PNG]);
    await ask(page, 'Describe');
    await page.waitForSelector('#attach-dialog[open]');
    assert.ok((await page.textContent('#attach-dialog')).includes('Llama 3.3 70B Instruct (free)'));
    await page.click('#attach-dialog button:has-text("Skip them")');
    await allDone(page, 1);
    assert.ok((await laneCell(page, 0, 3).textContent()).includes("not sent: can't read images"));
    assert.equal(page.requests.filter((r) => r.model === LLAMA).length, 0);
    assert.equal(page.requests.length, 3);
  },

  async 'capability dialog text only'(page) {
    await useFourModels(page);
    await attachFiles(page, [PNG]);
    await ask(page, 'Describe');
    await page.click('#attach-dialog button:has-text("Send text only")');
    await allDone(page, 1);
    const llama = reqFor(page, LLAMA);
    assert.equal(typeof lastUser(llama).content, 'string');
    assert.ok(lastUser(llama).content.includes('[image omitted: tiny.png]'));
    assert.equal(await laneCell(page, 0, 3).locator('.tag-text-only').count(), 1);
    assert.equal(await page.locator('.turn .prompt-label').first().textContent(), 'You → all');
  },

  async 'remember for this chat'(page) {
    await useFourModels(page);
    await attachFiles(page, [PNG]);
    await ask(page, 'One');
    await page.check('#attach-dialog input[type=checkbox]');
    await page.click('#attach-dialog button:has-text("Skip them")');
    await allDone(page, 1);
    await attachFiles(page, [PNG]);
    await ask(page, 'Two');
    await allDone(page, 2);
    assert.equal(await page.locator('#attach-dialog[open]').count(), 0);
    assert.ok((await laneCell(page, 1, 3).textContent()).includes("not sent: can't read images"));
  },

  async 'cancel keeps composer'(page) {
    await useFourModels(page);
    await attachFiles(page, [PNG]);
    await page.fill('#prompt', 'Keep me');
    await page.press('#prompt', 'Enter');
    await page.click('#attach-dialog button:has-text("Cancel")');
    await page.waitForTimeout(300);
    assert.equal(page.requests.length, 0);
    assert.equal(await page.inputValue('#prompt'), 'Keep me');
    assert.equal(await page.locator('#composer .att-chip').count(), 1);
  },

  async 'text file inlined'(page) {
    await attachFiles(page, [{ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\nhello') }]);
    await ask(page, 'Summarize');
    await allDone(page, 1);
    assert.equal(page.requests.length, 3);
    for (const r of page.requests) {
      const c = lastUser(r).content;
      assert.equal(typeof c, 'string');
      assert.ok(c.includes('--- file: notes.md ---\n# Notes\nhello\n--- end of notes.md ---'));
    }
    assert.equal(await page.locator('.turn .att-file').count(), 1);
  },

  async 'attachments survive reload'(page) {
    await attachFiles(page, [PNG]);
    await ask(page, 'Look');
    await allDone(page, 1);
    await page.reload();
    await page.waitForSelector('.turn .att-thumb img[src^="blob:"]');
    const before = page.requests.length;
    await laneCell(page, 0, 0).locator('button:has-text("Retry")').click();
    for (let i = 0; i < 100 && page.requests.length <= before; i++) await page.waitForTimeout(50);
    assert.ok(page.requests.length > before, 'retry sent a request');
    const again = page.requests[page.requests.length - 1];
    assert.equal(lastUser(again).content[1].type, 'image_url');
  },

  async 'downscales large image'(page) {
    await page.evaluate(async () => {
      const c = new OffscreenCanvas(6000, 4000);
      const g = c.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 6000, 4000);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'huge.png', { type: 'image/png' }));
      document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    });
    await page.waitForSelector('#composer .att-chip');
    await ask(page, 'Big');
    await allDone(page, 1);
    const url = lastUser(reqFor(page, 'anthropic/claude-sonnet-5')).content[1].image_url.url;
    const size = await page.evaluate(async (u) => { const b = await createImageBitmap(await (await fetch(u)).blob()); return [b.width, b.height]; }, url);
    assert.ok(Math.max(...size) <= 2048 && Math.max(...size) >= 2000, 'downscaled to 2048: ' + size);
  },

  async 'attachment save failure keeps composer'(page) {
    await page.evaluate(() => { MC.app.state.store.putAttachment = async () => { throw new Error('QuotaExceededError'); }; });
    await attachFiles(page, [PNG]);
    await page.fill('#prompt', 'Keep me');
    await page.press('#prompt', 'Enter');
    await page.waitForSelector('.toast:has-text("Could not save attachment")');
    assert.equal(page.requests.length, 0);
    assert.equal(await page.inputValue('#prompt'), 'Keep me');
    assert.equal(await page.locator('#composer .att-chip').count(), 1);
  },

  async 'ocr setting'(page) {
    await page.click('button[aria-label=Settings]');
    await page.selectOption('#settings-dialog select[name=pdfMode]', 'ocr');
    await page.click('#settings-dialog button[type=submit]');
    await attachFiles(page, [PDF]);
    await ask(page, 'Read');
    await allDone(page, 1);
    assert.equal(reqFor(page, 'openai/gpt-6').plugins[0].pdf.engine, 'mistral-ocr');
    assert.equal(reqFor(page, 'anthropic/claude-sonnet-5').plugins[0].pdf.engine, 'native');
  },

  async 'export includes attachments and import restores them'(page) {
    page.on('dialog', (d) => d.accept());
    await attachFiles(page, [PNG]);
    await ask(page, 'Keep');
    await allDone(page, 1);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export all")')]);
    const file = await dl.path();
    const json = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    assert.equal(json.attachments.length, 1);
    assert.ok(json.attachments[0].data.startsWith('data:image/png'));
    const attId = await page.evaluate(() => MC.app.state.conv.turns[0].attachments[0].id);
    await page.hover('.conv');
    await page.click('.conv button[title="Delete"]');
    await page.waitForFunction(() => !document.querySelector('.conv'));
    assert.equal(await page.evaluate(async (id) => (await MC.app.state.store.getAttachment(id)) || null, attId), null, 'attachment deleted with chat');
    await page.setInputFiles('#sidebar input[type=file]', file);
    await page.waitForSelector('.conv');
    await page.click('.conv-open');
    await page.waitForSelector('.turn .att-thumb img[src^="blob:"]');
  },

  async 'opened attachments never run as pages'(page) {
    await attachFiles(page, [{ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>document.title="PWNED"</script>') }]);
    await ask(page, 'Review');
    await allDone(page, 1);
    await page.waitForSelector('.turn .att-file[href^="blob:"]');
    const type = await page.evaluate(async () => (await (await fetch(document.querySelector('.turn .att-file').href)).blob()).type);
    assert.match(type, /^text\/plain/);
  },

  async 'import rejects attachment records with active content'(page) {
    const conv = { id: 'c_imp', title: 'Imported', createdAt: 1, updatedAt: 1, lanes: [{ id: 'l1', modelId: 'openai/gpt-6', modelName: 'GPT-6', active: true, joinedAtTurn: 0 }],
      turns: [{ id: 't1', index: 0, kind: 'broadcast', inputs: { l1: 'x' }, responses: { l1: { status: 'done', content: 'y', previous: [] } }, attachments: [{ id: 'evil', kind: 'image', name: 'cat.png' }] }] };
    const evil = { id: 'evil', kind: 'image', name: 'cat.png', mime: 'image/png', size: 1, data: 'data:text/html;base64,' + Buffer.from('<script>document.title=localStorage.getItem("mc.apiKey")</script>').toString('base64') };
    const file = require('path').join(require('os').tmpdir(), 'mc-evil-export.json');
    require('fs').writeFileSync(file, JSON.stringify({ app: 'multaichat', version: 2, conversations: [conv], attachments: [evil], presets: [] }));
    await page.setInputFiles('#sidebar input[type=file]', file);
    await page.waitForSelector('.conv');
    assert.equal(await page.evaluate(() => MC.app.state.store.getAttachment('evil')), undefined);
    await page.click('.conv-open');
    await page.waitForSelector('.turn .att-thumb.missing');
  },

  async 'attachment quota failure on IndexedDB keeps composer'(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(base).origin, quotaSize: 200 * 1024 });
    const noise = await page.evaluate(async () => {
      const c = new OffscreenCanvas(1500, 1500); const g = c.getContext('2d'); const d = g.createImageData(1500, 1500);
      for (let i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0;
      g.putImageData(d, 0, 0);
      return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
    });
    await attachFiles(page, [{ name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(noise) }]);
    await page.fill('#prompt', 'Keep me');
    await page.press('#prompt', 'Enter');
    await page.waitForSelector('.toast:has-text("Could not save attachment")', { timeout: 10000 });
    assert.equal(page.requests.length, 0);
    assert.equal(await page.inputValue('#prompt'), 'Keep me');
    assert.equal(await page.locator('#composer .att-chip').count(), 1);
  },

  async 'double click on Send sends once'(page) {
    await attachFiles(page, [PNG]);
    await page.fill('#prompt', 'Once');
    await page.evaluate(() => { const b = document.querySelector('#composer button[aria-label=Send]'); b.click(); b.click(); });
    await allDone(page, 1);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.turn').count(), 1);
    assert.equal(page.requests.length, 3);
  },

  async 'clear all local data removes attachments'(page) {
    page.on('dialog', (d) => d.accept());
    await attachFiles(page, [PNG]);
    await ask(page, 'Keep');
    await allDone(page, 1);
    await page.click('button[aria-label=Settings]');
    await Promise.all([page.waitForNavigation(), page.click('#settings-dialog button:has-text("Clear all local data")')]);
    const n = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('multaichat');
      r.onsuccess = () => { const db = r.result; const q = db.transaction('attachments').objectStore('attachments').count(); q.onsuccess = () => { res(q.result); db.close(); }; };
    }));
    assert.equal(n, 0);
  },

  async 'typed text shows when every model got text only'(page) {
    await page.evaluate((l) => MC.app.setSelection([l]), LLAMA);
    await attachFiles(page, [PNG]);
    await ask(page, 'WHAT IS THIS PICTURE');
    await page.click('#attach-dialog button:has-text("Send text only")');
    await allDone(page, 1);
    assert.ok((await page.textContent('.turn .bubble')).includes('WHAT IS THIS PICTURE'));
    assert.ok(!(await page.textContent('.turn .bubble')).includes('[image omitted'));
  },

  async 'large opaque PNG is sent as JPEG, transparent stays PNG'(page) {
    const make = (alpha) => page.evaluate(async (a) => {
      const c = new OffscreenCanvas(3000, 2000); const g = c.getContext('2d');
      g.fillStyle = a ? 'rgba(50,100,200,0.5)' : '#3264c8'; g.fillRect(0, 0, 3000, 2000);
      return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
    }, alpha);
    await attachFiles(page, [{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(await make(false)) }, { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(await make(true)) }]);
    await ask(page, 'Two');
    await allDone(page, 1);
    const parts = lastUser(reqFor(page, 'anthropic/claude-sonnet-5')).content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url.slice(0, 15));
    assert.deepEqual(parts, ['data:image/jpeg', 'data:image/png;']);
  },

  async 'large text file is read only up to the limit'(page) {
    await attachFiles(page, [{ name: 'big.log', mimeType: 'text/plain', buffer: Buffer.alloc(3 * 1024 * 1024, 'a') }]);
    await ask(page, 'Log');
    await allDone(page, 1);
    const id = await page.evaluate(() => MC.app.state.conv.turns[0].attachments[0].id);
    const len = await page.evaluate(async (i) => (await MC.app.state.store.getAttachment(i)).data.length, id);
    assert.ok(len <= 204800 + 40, 'stored text capped: ' + len);
    assert.ok(lastUser(page.requests[0]).content.includes('…[truncated at 200 KB]'));
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

