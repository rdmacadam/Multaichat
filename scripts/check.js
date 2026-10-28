'use strict';
// Production check: the site as GitHub Pages serves it (static files under
// /Multaichat/) and as opened from disk, plus every test suite.
// Usage: npm run check   (CHECK_ROOT=<dir> checks another copy of the site)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { mockOpenRouter, serve } = require('../tests/pw-helpers');

const REPO = path.join(__dirname, '..');
const ROOT = path.resolve(process.env.CHECK_ROOT || REPO);
const MOUNT = '/Multaichat';
let failed = 0;

function report(name, problems) {
  if (problems.length) { failed++; console.log(`not ok - ${name}\n  ${problems.join('\n  ')}`); }
  else console.log(`ok - ${name}`);
}

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listJs(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const noQuery = (u) => u.split('?')[0];
const links = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'));

// 1. every asset is relative and exists (absolute paths break under /Multaichat/)
report('assets are relative and exist', scripts.concat(links).flatMap((u) => {
  if (/^([a-z]+:)?\/\//i.test(u) || u.startsWith('/')) return [`${u}: not a relative path`];
  return fs.existsSync(path.join(ROOT, noQuery(u))) ? [] : [`${u}: file missing`];
}));

// 1b. every script and stylesheet carries a version query so a deploy never
// mixes freshly fetched files with stale cached ones
report('scripts and styles are cache-busted (?v=…)', scripts.concat(links).filter((u) => !/[?&]v=[\w.-]+$/.test(u)).map((u) => `${u}: no ?v= version`));

// 2. every js file is loaded exactly once and app.js runs last
const jsFiles = listJs(path.join(ROOT, 'js')).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
const bare = scripts.map(noQuery);
report('every script is loaded once, app.js last', [
  ...jsFiles.filter((f) => bare.filter((s) => s === f).length !== 1).map((f) => `${f}: referenced ${bare.filter((s) => s === f).length} times`),
  ...(bare[bare.length - 1] === 'js/app.js' ? [] : ['js/app.js is not the last script']),
]);

async function loads(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => { if (!r.url().startsWith('https://openrouter.ai')) errors.push('failed to load ' + r.url()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await mockOpenRouter(page);
  await page.goto(url);
  try { await page.waitForSelector('body.ready', { timeout: 10000 }); } catch (e) { errors.push('app did not start'); }
  if (!(await page.evaluate(() => !!(window.MC && MC.app && MC.app.state && MC.app.state.store)))) errors.push('MC.app.state missing');
  await page.close();
  return errors;
}

(async () => {
  // 3. the page starts cleanly under the Pages path and from disk
  const browser = await chromium.launch();
  const server = await serve({ mount: MOUNT, root: ROOT });
  try {
    report(`loads under http://…${MOUNT}/ (GitHub Pages layout)`, await loads(browser, `http://127.0.0.1:${server.address().port}${MOUNT}/`));
    report('loads from file://', await loads(browser, 'file://' + path.join(ROOT, 'index.html')));
  } finally {
    await browser.close();
    server.close();
  }

  // 4. all test suites (against the repo)
  if (ROOT === REPO) {
    for (const [name, cmd, args] of [
      ['unit tests', 'node', ['--test', 'tests/*.test.js']],
      ['browser flow (smoke)', 'node', ['tests/smoke.pw.js']],
      ['browser regressions', 'node', ['tests/regressions.pw.js']],
      ['browser Round A', 'node', ['tests/round-a.pw.js']],
      ['browser Round B', 'node', ['tests/round-b.pw.js']],
      ['browser answer views', 'node', ['tests/view.pw.js']],
    ]) {
      const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      const summary = (out.match(/^# (pass|fail) \d+$/gm) || []).join(', ') || `${(out.match(/^ok - /gm) || []).length} ok`;
      report(`${name} (${summary})`, r.status === 0 ? [] : out.split('\n').filter((l) => /^not ok|Error/.test(l)).slice(0, 10));
    }
  } else {
    console.log('# skipped test suites (CHECK_ROOT is not the repo)');
  }
  console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nAll production checks passed');
  process.exit(failed ? 1 : 0);
})();
