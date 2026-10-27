# Round B — Decision-Model Router and Chat Cost Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-chat cost counter to the toolbar and a router that lets an OpenRouter decision model pick which N models answer each message, in six modes.

**Architecture:** Pure logic goes in two new core modules — `js/core/router.js` (pool, decider chain, decision request, ranking, judge) and `js/core/cost.js` (chat cost summary) — Node-tested like the rest of `js/core`. `MC.api` gains `decide()` for `/api/alpha/decisions`; `MC.runner` gains `route()` and `runJudge()`. UI lives in a new `js/ui/router.js` (panel, decider list, preview) plus small changes to `dom.js`, `chat.js`, `composer.js` and `app.js`.

**Tech Stack:** Vanilla JS with classic `<script>` tags on `window.MC` (UMD footer for Node), `node --test`, Playwright with a mocked OpenRouter. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-round-b-router-design.md` — read it alongside this plan; § numbers below refer to it.

## Global Constraints

- Branch `round-b-router`. Never modify or push `main`. No merge, deploy or pull request without the user's approval.
- Run `npm run check` before starting and after every task; all suites must stay green (baseline: 158 unit, smoke 2, regressions 9, Round A 29).
- No build step, no npm dependencies, no ES modules; works from `file://` and under `/Multaichat/`.
- `js/core/*` has no DOM access. Untrusted text reaches `innerHTML` only through `MC.md.render`.
- Every `<script>`/`<link>` in `index.html` carries `?v=3` (bump from `?v=2` in Task 7, once).
- Decision endpoint: `POST https://openrouter.ai/api/alpha/decisions`, fallback on 404 to `POST https://openrouter.ai/api/v1/systemone`.
- Decision model list: `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`.
- Default decision model `perplexity/pplx-decider-v1.2`; default free decision model `baseten/mammoth-1:free`.
- Default starred deciders, in order: `liquid/d1-ultra`, `typesafe/jev-1.14`, `inception/mercury-decide`, `perplexity/pplx-decider-v1.2`, `baseten/mammoth-1:free`, `baseten/elephant-1:free`.
- Native router model id `openrouter/auto`, plugin id `auto-router`.
- Router count range 1–8; native forces 1. Decision timeout 15 000 ms. At most 2 deciders tried per message. At most 30 candidates in a decision; 60 % of decider context as budget; chars/4 token estimate. At most 100 ids in `allowed_models`. At most 4 images to a decider.
- ⓘ texts are exactly those in spec Appendix A.
- Commit messages end with the two attribution lines from the session (`Co-Authored-By: …`, `Claude-Session: …`).

## Review Focus

1. **The decision model list fails to load or is empty** (offline, API change) → routing must still work by rule ranking with a note, never throw. Test in Task 6 (`route with no deciders uses rules`).
2. **A picked model has an inactive (removed) lane in the chat** → the lane is reactivated, never duplicated. Test in Task 3 (`ensureLanes reactivates and never duplicates`).
3. **A very long message or pasted text file** on a 16k decider → the decision `state` is cut to fit, the request is still sent. Test in Task 5 (`decisionRequest cuts long state to budget`).
4. **Streaming / errored answers in the cost counter** → a streaming answer without usage is neither cost nor "no price"; only finished answers without a cost count as unknown. Test in Task 4 (`summary ignores streaming and errors`).
5. **Pool "Only my current selection" while every lane was removed** → empty pool with reason `'selection'` and a toast, nothing sent. Test in Task 5 (`candidates empty selection reason`).

---

### Task 1: API client — decisions, served model, extra body

**Files:**
- Modify: `js/core/openrouter.js`
- Test: `tests/openrouter.test.js`

**Interfaces:**
- Produces:
  - `MC.api.decide({ key, model, state, questions, signal, fetchImpl }) -> Promise<{ model: string, answers: object, usage: { inputTokens: number, cost: number|null } }>`; throws `ApiError` like `complete()`.
  - `MC.api.DECIDE_URLS = ['https://openrouter.ai/api/alpha/decisions', 'https://openrouter.ai/api/v1/systemone']`
  - `MC.api.fetchDeciders({ fetchImpl }) -> Promise<raw[]>` (GET `BASE + '/models?output_modalities=decisions'`).
  - `streamChat({ …, extraBody })` merges `extraBody` into the request body; its result gains `servedModel: string|null` (the last non-empty `model` field seen in stream events).

- [ ] **Step 1: Write the failing tests**

```js
test('decide posts to alpha/decisions with model, state, questions', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return jsonResponse({ model: 'perplexity/pplx-decider-v1.2', answers: { pick: { type: 'choice', choice: 'a/x', probabilities: { 'a/x': 0.7 } } }, usage: { input_tokens: 120, output_tokens: 0, cost: 0.0000024 } }); };
  const r = await api.decide({ key: 'k', model: 'perplexity/pplx-decider-v1.2', state: ['hi'], questions: { pick: { type: 'choice' } }, fetchImpl });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['model', 'questions', 'state']);
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
  assert.deepEqual(r.usage, { inputTokens: 120, cost: 0.0000024 });
  assert.equal(r.answers.pick.choice, 'a/x');
});
test('decide retries systemone once on 404', async () => { /* first 404, second 200 → urls [alpha, systemone], result ok */ });
test('decide throws ApiError with status on 429 and does not retry', async () => { /* one call; err.status === 429 */ });
test('fetchDeciders requests output_modalities=decisions', async () => { /* url endsWith '/models?output_modalities=decisions'; returns data[] */ });
test('streamChat sends extraBody and returns servedModel', async () => {
  // SSE chunks carry "model":"anthropic/claude-sonnet-5"; extraBody { session_id: 'c_1' }
  // assert body.session_id === 'c_1'; res.servedModel === 'anthropic/claude-sonnet-5'
});
test('streamChat servedModel is null when chunks have no model', async () => {});
```

- [ ] **Step 2: Run to see them fail** — `node --test tests/openrouter.test.js` → FAIL (`api.decide is not a function`).
- [ ] **Step 3: Implement** `decide`, `fetchDeciders`, `DECIDE_URLS`, and the `streamChat` changes. `decide` uses `headers(key)` and `doFetch`; only a 404 moves to the next URL; errors via `errorFromResponse`; `usage.input_tokens` → `inputTokens`, missing `cost` → `null`.
- [ ] **Step 4: Run** `node --test tests/openrouter.test.js` → PASS; `npm test` → all pass.
- [ ] **Step 5: Commit** — `feat: decisions API client and served model on streams`

---

### Task 2: Catalog — router flag, short description, decision models

**Files:**
- Modify: `js/core/models.js`
- Test: `tests/models.test.js`

**Interfaces:**
- Consumes: `MC.api.fetchDeciders` (Task 1).
- Produces:
  - `normalize()` models gain `router: boolean` (true when `Number(pricing.prompt) < 0`) and `desc: string` (first sentence of `description`, ≤ 160 chars, `''` if none).
  - `MC.models.normalizeDeciders(raw) -> Decider[]`, `Decider = { id, name, provider, priceIn, context, inputs, images, files, free, desc }`; keeps only entries whose `architecture.output_modalities` includes `'decisions'`; `free` = id ends `:free` or `priceIn === 0`.
  - `MC.models.loadDeciders({ ls, fetchDecidersFn, now, force }) -> Promise<{ deciders: Decider[], stale: boolean, source: 'cache'|'network'|'none' }>` — cache key `mc.decidersCache`, TTL 24 h, same shape/fallback logic as `loadCached` except the last resort is `[]` with `source: 'none'`.

- [ ] **Step 1: Write the failing tests**

```js
test('normalize flags router models by negative price and keeps a short desc', () => {
  const [m] = M.normalize([{ id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' }, description: 'Picks a model. More text here.' }]);
  assert.equal(m.router, true); assert.equal(m.desc, 'Picks a model.');
});
test('normalizeDeciders keeps decision models with inputs and free flag', () => {
  const d = M.normalizeDeciders([
    { id: 'baseten/mammoth-1:free', name: 'Baseten: Mammoth', context_length: 16384, pricing: { prompt: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['decisions'] } },
    { id: 'liquid/d1-ultra', name: 'LiquidAI: d1-ultra', context_length: 32768, pricing: { prompt: '0.000000042' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['decisions'] } },
    { id: 'openai/gpt-6', architecture: { output_modalities: ['text'] } }]);
  assert.deepEqual(d.map((x) => [x.id, x.free, x.images, x.context]), [['baseten/mammoth-1:free', true, false, 16384], ['liquid/d1-ultra', false, true, 32768]]);
  assert.equal(d[1].priceIn, 0.042);
});
test('loadDeciders caches for 24 h, refetches when stale, falls back to stale cache, then none', async () => {});
```

- [ ] **Step 2: Run** `node --test tests/models.test.js` → FAIL.
- [ ] **Step 3: Implement** the three changes in `js/core/models.js`; export `normalizeDeciders`, `loadDeciders`.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat: decision model catalog and router-model flag`

---

### Task 3: Conversation — route on turns, lanes for picks

**Files:**
- Modify: `js/core/conversation.js`
- Test: `tests/conversation.test.js`

**Interfaces:**
- Produces:
  - `addTurn(conv, kind, inputs, extra)` stores `extra.route` (deep copy) as `turn.route` when given.
  - `MC.conv.ensureLanes(conv, models: {id, name}[]) -> laneId[]` — for each model, in order: an active lane with that `modelId` → its id; an inactive one → set `active = true`, its id; none → `addLane` (late joiner with `seedContext`). Returns lane ids in the input order.
  - `MC.conv.isRouted(turn, laneId) -> boolean` — true when `turn.route` exists and `laneId` is in `turn.inputs`.
  - `recoverInterrupted` also turns a `streaming` `turn.judge` into `{status:'error', error:'Interrupted'}`.

- [ ] **Step 1: Write the failing tests**

```js
test('addTurn stores route', () => { /* route {mode:'auto', picks:[{modelId:'a/one', p:0.6}]} → turn.route deepEqual, not same object */ });
test('ensureLanes reactivates and never duplicates', () => {
  const c = C.create([{ id: 'a/one', name: 'One' }, { id: 'b/two', name: 'Two' }]);
  C.removeLane(c, c.lanes[1].id);
  const ids = C.ensureLanes(c, [{ id: 'b/two', name: 'Two' }, { id: 'c/three', name: 'Three' }, { id: 'a/one', name: 'One' }]);
  assert.equal(c.lanes.length, 3);
  assert.equal(c.lanes[1].active, true);
  assert.deepEqual(ids, [c.lanes[1].id, c.lanes[2].id, c.lanes[0].id]);
});
test('fork keeps route and judge on copied turns', () => {});
test('recoverInterrupted marks a streaming judge as interrupted', () => {});
```

- [ ] **Step 2: Run** `node --test tests/conversation.test.js` → FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat: routed turns and lanes for router picks`

---

### Task 4: Chat cost summary and stored usage for TL;DR / Fusion

**Files:**
- Create: `js/core/cost.js` (UMD, `MC.cost`)
- Modify: `js/core/runner.js` (`runTldr`, `runFusion`), `tests/load.js` (add `cost: ['core/cost', 'cost']`, `router: ['core/router', 'router']`), `index.html` (script `js/core/cost.js?v=2` after `conversation.js`)
- Test: `tests/cost.test.js` (new), `tests/runner.test.js`

**Interfaces:**
- Produces:
  - `MC.cost.summary(conv|null) -> { total: number, unknown: number, parts: { answers, earlier, router, derived, judge } }` (numbers in USD; `null` conv → all zero).
  - `MC.cost.addReplaced(turn, kind: 'derived'|'judge', usage)` — adds `usage.cost` (if a number) to `turn.spentReplaced[kind]`.
  - `runTldr` / `runFusion` store `usage` (from the API result) on `turn.tldr` / `turn.fusion`, and call `addReplaced(turn, 'derived', old.usage)` before replacing an existing one.
- Counting rules (spec §7): a request counts when it is a response with status `done`/`stopped`/`error` that has `usage`, a `previous[]` entry with `usage`, `turn.route.usage`, `turn.tldr.usage`, `turn.fusion.usage`, `turn.judge.usage`. `cost == null` on such a usage → `unknown += 1`. A response that is `streaming`, or has no `usage` at all, is ignored.

- [ ] **Step 1: Write the failing tests**

```js
test('summary adds every part', () => {
  const conv = { turns: [{ responses: {
      l1: { status: 'done', usage: { cost: 0.001 }, previous: [{ usage: { cost: 0.0005 } }] },
      l2: { status: 'done', usage: { cost: 0 }, previous: [] } },
    route: { usage: { cost: 0.00002 } }, tldr: { usage: { cost: 0.0001 } }, fusion: { usage: { cost: 0.0002 } },
    judge: { usage: { cost: 0.00003 } }, spentReplaced: { derived: 0.0004, judge: 0.00001 } }] };
  const s = Cost.summary(conv);
  assert.deepEqual(s.parts, { answers: 0.001, earlier: 0.0005, router: 0.00002, derived: 0.0007, judge: 0.00004 });
  assert.equal(Math.round(s.total * 1e8), Math.round(0.00226 * 1e8));
  assert.equal(s.unknown, 0);
});
test('summary counts finished answers without cost as unknown', () => {});
test('summary ignores streaming and errors without usage', () => {});
test('summary of null and of an old chat without new fields', () => {});
test('runTldr stores usage and keeps the replaced cost', async () => { /* run twice with cost 0.0001 each → spentReplaced.derived 0.0001, tldr.usage.cost 0.0001 */ });
test('runFusion stores usage', async () => {});
```

- [ ] **Step 2: Run** `node --test tests/cost.test.js tests/runner.test.js` → FAIL.
- [ ] **Step 3: Implement** `js/core/cost.js` and the runner changes; add the script tag and `load.js` entries (the `router` entry is used from Task 5).
- [ ] **Step 4: Run** `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: chat cost summary; store TL;DR and Fusion usage`

---

### Task 5: Router core — pool, decider chain, request, ranking, judge

**Files:**
- Create: `js/core/router.js` (UMD, `MC.router`)
- Modify: `index.html` (script `js/core/router.js?v=2` after `attach.js`, before `runner.js`), `js/core/storage.js` (`DEFAULT_SETTINGS.router`, `DEFAULT_SETTINGS.starredDeciders`)
- Test: `tests/router.test.js` (new), `tests/storage.test.js`

**Interfaces:**
- Consumes: `MC.models.filter`, `MC.models.sections` (v1/Round A), `Model.router` (Task 2), `Decider` (Task 2).
- Produces (all pure):
  - `MODES = ['auto','free','diverse','best','manual','native']`, `NATIVE_ID = 'openrouter/auto'`, `DEFAULT_DECIDER = 'perplexity/pplx-decider-v1.2'`, `FREE_DECIDER = 'baseten/mammoth-1:free'`, `GOAL` (the five sentences in spec §5.4), `TASKS = { code, math, writing, analysis, research, chat, vision }` (label → one-line guidance).
  - `withDefaults(router) -> RouterSettings` — deep-merges `extras` and clamps `count` to 1–8 (1 in native); unknown `mode` → `'auto'`.
  - `candidates(models, { mode, pool, selection: string[], manualPool: string[], filters, attachments: AttachmentRef[] }) -> { list: Model[], reason: null|'filters'|'images'|'free'|'selection' }` — spec §5.2 steps 1–6. `reason` names the step that emptied (or, when shorter than requested later, last reduced) the pool; `null` when nothing was removed except EXCLUDE/router models.
  - `rulesPick(list, mode, n, now?) -> Model[]` — spec §5.5 rule table (`native` like `auto`; `manual` keeps input order).
  - `chooseDecider(deciders, { mode, decisionModel, starred: string[], allowPaidInFree, hasImages }) -> Decider[]` (length ≤ 2) — spec §5.3.
  - `decisionRequest({ mode, candidates: Model[], decider, text, systemPrompt, contextNote, attachments, images: {id: dataURL} }) -> { state: any[], questions: object, candidateIds: string[] }` — spec §5.4 including `fitToContext`; prices omitted from criteria in `best`.
  - `fitToContext(candidates, decider, stateChars) -> Model[]` (≥ 2 or `[]`).
  - `rank(answers, candidateIds: string[], ruleOrder: Model[], mode, n) -> [{ modelId, p: number|null }]` — spec §5.5.
  - `judgeRequest({ text, answers: [{ modelId, name, content }], decider }) -> { state, questions }` — question key `best`.
  - `judgeResult(answers, laneByModel: {modelId: laneId}) -> { laneId, modelId, p } | null`.
  - `taskOf(answers) -> string|null` (`answers.task.choice` if it is a key of `TASKS`).
- Settings defaults (`storage.js`): `router` exactly as spec §5.1; `starredDeciders` the six ids from Global Constraints.

Ranking/rule specifics the tests pin:
- `rank`: sort valid labels by probability desc (ties: rule order); no probabilities → `[choice, …rule order]`; `diverse` → first pass at most one per `provider`, second pass fills to `n` from the remaining ranking; then fill from `ruleOrder`; dedupe; `p` is the probability or `null` for filled picks.
- `decisionRequest` budget: `budget = floor(decider.context * 0.6)` tokens, tokens ≈ chars/4. The state (message, system prompt, note, text-file excerpts) is cut first so it uses at most 40 % of the budget (message cut last); then `fitToContext` fits candidates in the rest. Image parts: only when `decider.images`, MIME in `image/png|image/jpeg|image/webp` (`typesafe/*`: png/jpeg only), max 4; others become `[n image(s) attached]`.

- [ ] **Step 1: Write the failing tests** (fixture: `MC.models.normalize(require('./fixtures/models.json').data)` plus one `{ id: 'openrouter/auto', pricing: { prompt: '-1' } }`)

```js
test('candidates catalog excludes router, preview and embed models', () => { /* no 'openrouter/auto', no '-preview', no 'embed' ids */ });
test('candidates applies picker filters', () => { /* filters {maxOut: 5} → every priceOut <= 5; reason null if still non-empty */ });
test('candidates with an image keeps only image models', () => {
  const r = Router.candidates(models, { mode: 'auto', pool: 'catalog', filters: {}, attachments: [{ kind: 'image' }] });
  assert.ok(r.list.length && r.list.every((m) => m.images));
});
test('candidates with a PDF does not restrict', () => {});
test('candidates free mode keeps only free models; empty → reason free', () => {});
test('candidates selection pool uses only selection ids', () => {});
test('candidates empty selection reason', () => { /* selection [] → list [] reason 'selection' */ });
test('candidates manual uses manualPool in order', () => {});
test('rulesPick per mode', () => { /* best: highest priceOut first; free: newest; diverse: distinct providers */ });
test('chooseDecider default chain is chosen then starred', () => {});
test('chooseDecider free mode: free chosen → mammoth fallback; no free deciders → []', () => {});
test('chooseDecider free mode with allowPaidInFree appends paid', () => {});
test('chooseDecider puts image deciders first when images are attached', () => {});
test('decisionRequest goal per mode and no prices in best', () => {});
test('decisionRequest sends images only to image deciders with allowed types', () => {});
test('decisionRequest cuts long state to budget', () => {
  const big = 'x'.repeat(200000);
  const d = { id: 'baseten/mammoth-1:free', context: 16384, images: false };
  const r = Router.decisionRequest({ mode: 'auto', candidates: models.slice(0, 30), decider: d, text: big, attachments: [], images: {} });
  const chars = JSON.stringify(r.state).length + JSON.stringify(r.questions).length;
  assert.ok(chars / 4 <= 16384 * 0.6);
  assert.ok(r.candidateIds.length >= 2);
});
test('fitToContext trims to fit a 16k decider and returns [] below 2', () => {});
test('rank orders by probability, ignores unknown labels, fills from rules', () => {});
test('rank without probabilities puts the choice first', () => {});
test('rank diverse takes one per provider then fills', () => {});
test('judgeRequest and judgeResult pick the highest-probability answer', () => {});
test('withDefaults merges extras and clamps count; native forces 1', () => {});
// storage.test.js
test('defaults include router and starred deciders', () => { /* deepEqual to spec values */ });
```

- [ ] **Step 2: Run** `node --test tests/router.test.js tests/storage.test.js` → FAIL.
- [ ] **Step 3: Implement** `js/core/router.js` and the storage defaults; add the script tag.
- [ ] **Step 4: Run** `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: router core (pool, decider chain, decision request, ranking, judge)`

---

### Task 6: Runner — route(), judge, native lanes

**Files:**
- Modify: `js/core/runner.js`
- Test: `tests/runner.test.js`

**Interfaces:**
- Consumes: `MC.api.decide`, `streamChat({extraBody})`/`servedModel` (Task 1); `MC.router.*` (Task 5); `MC.cost.addReplaced` (Task 4).
- Produces:
  - `runner.route({ text, attachments, images, settings: RouterSettings, models, deciders, starred, selection, filters, systemPrompt, contextNote, signal, timeoutMs = 15000 }) -> Promise<RouteResult>`
    - `RouteResult = { ok: true, route, picks: Model[] } | { ok: false, reason: 'empty'|'auth'|'credits'|'aborted', message: string }`
    - `route = { mode, count, method: 'model'|'rules'|'native', decisionModel?, task?, picks: [{modelId, p}], candidates: string[], note?, usage?: { inputTokens, cost }, ms }`
    - Flow = spec §5.9 steps 2–5: empty pool → `{ok:false, reason:'empty', message}` (message names the reason); native → `method:'native'`, `picks:[{modelId: NATIVE_ID, p: null}]`, `candidates` = first 100 rule-ordered ids; no decider (or `chooseDecider` empty) → rules with note (`'no free decision model available'` in free mode, else `'no decision model available'`); decision 401 → `auth`, 402 → `credits`; 400/413/422 with image parts → same decider once without images (note `'decided without the images'`); 429/5xx/network/timeout → next decider, then rules with note `'decision failed: <errorMessage>'`; outer `signal` abort → `aborted`. `usage` sums all decision calls made. Short pool → note `'only k models fit (<reason>)'`.
  - `runner.runJudge(conv, turnId, deciderChain: Decider[]) -> Promise<judge>` — needs ≥ 2 answered lanes; stores `turn.judge` (`status:'streaming'` while running); replaced judge cost → `addReplaced(turn, 'judge', …)`; failure → `{status:'error', error}`.
  - `streamLane`: when `lane.modelId === MC.router.NATIVE_ID`, adds plugin `{ id: 'auto-router', allowed_models: turn.route.candidates }` (alongside any `file-parser` plugin) and `extraBody: { session_id: conv.id }`; stores `r.servedModel = res.servedModel`; a 404 whose message matches `/No models match/i` becomes `'No allowed model fits — loosen filters or remove images'`.

- [ ] **Step 1: Write the failing tests** (fake api gains `decide(opts)`)

```js
test('route picks by probability with the default decider', async () => { /* decide returns probs; result.ok, method 'model', picks length = count, route.decisionModel, route.usage.cost */ });
test('route with no deciders uses rules', async () => { /* deciders [] → method 'rules', note 'no decision model available', api.decide not called */ });
test('route best free without a free decider uses rules and stays free', async () => {});
test('route falls back to the second decider on 429, then to rules', async () => {});
test('route retries without images on 413', async () => { /* second call state has no image_url parts; note 'decided without the images' */ });
test('route returns auth on 401 and credits on 402', async () => {});
test('route times out after timeoutMs', async () => { /* decide never resolves; timeoutMs 20 → rules with note */ });
test('route aborted by signal', async () => {});
test('route native sends no decision and lists candidates', async () => {});
test('route empty pool returns reason empty', async () => {});
test('native lane request carries auto-router plugin and session_id; servedModel stored', async () => {});
test('runJudge stores the winning lane and keeps the replaced cost', async () => {});
```

- [ ] **Step 2: Run** `node --test tests/runner.test.js` → FAIL.
- [ ] **Step 3: Implement** in `js/core/runner.js` (timeout via an inner `AbortController` linked to `signal`).
- [ ] **Step 4: Run** `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: runner routing with fallbacks, judge and native lanes`

---

### Task 7: Browser harness, ⓘ tooltips and the Σ cost counter

**Files:**
- Create: `tests/fixtures/deciders.json` (the 6 starred deciders plus `upstage/solar-decide` (paid, text-only), with real ids, names, `context_length`, `pricing.prompt`, `architecture` from the live list on 2026-10-27), `tests/round-b.pw.js` (same structure as `tests/round-a.pw.js`)
- Modify: `tests/pw-helpers.js`, `js/ui/dom.js`, `js/app.js` (header), `styles.css`, `index.html` (all `?v=2` → `?v=3`), `package.json` (`smoke` adds `node tests/round-b.pw.js`), `scripts/check.js` (adds `['browser Round B', 'node', ['tests/round-b.pw.js']]`)

**Interfaces:**
- Produces:
  - `mockOpenRouter(page, opts)` also handles `…/models?output_modalities=decisions` (fixture; `opts.noDeciders` → `{data: []}`) and `https://openrouter.ai/api/alpha/**`: records bodies in `opts.decisions` (array); `opts.decideStatus: {modelId: status}` returns that error; default answer: `pick` = candidate labels in `criteria` order with probabilities `0.5, 0.25, 0.12, …` (halving), `choice` = first; `task` = `{choice: 'chat'}`; `best` (judge) = last label with probability 0.7; `usage: {input_tokens: 100, output_tokens: 0, cost: 0.000002}`. Chat requests to `openrouter/auto` stream with `"model":"openai/gpt-6"` in each chunk.
  - `MC.dom.info(text) -> HTMLElement` — `<span class="info-wrap"><button type="button" class="info" aria-label="More info" aria-describedby=ID>ⓘ</button><span role="tooltip" id=ID class="tip" hidden>text</span></span>`; shows after 600 ms `mouseenter`, at once on `focus`, toggles on `click`; hides on `mouseleave`, `blur`, `Escape`.
  - Header `#cost` button: text `Σ $x` / `Σ ≥ $x` / `Σ $0.00` (spec §7); `title` and an `MC.dom.info`-style breakdown tooltip listing non-zero parts (`Answers`, `Earlier versions`, `Router decisions`, `TL;DR & Fusion`, `Judge`) and `n request(s) had no price`. `MC.app.updateCost()` re-renders it; `onChange` calls it throttled to 250 ms.

- [ ] **Step 1: Write the failing browser tests** in `tests/round-b.pw.js`

```js
test('cost counter sums the answers and survives reload', async (b) => {
  const page = await open(b);
  assert.equal((await page.textContent('#cost')).trim(), 'Σ $0.00');
  await ask(page); await allDone(page, 1);           // 3 answers × $0.00042
  assert.equal((await page.textContent('#cost')).trim(), 'Σ $0.0013');
  await page.reload(); await page.waitForSelector('.turn');
  assert.equal((await page.textContent('#cost')).trim(), 'Σ $0.0013');
});
test('info tooltip shows after a long hover, on focus, hides on Escape', async (b) => { /* uses the #cost breakdown ⓘ */ });
```

- [ ] **Step 2: Run** `node tests/round-b.pw.js` → FAIL.
- [ ] **Step 3: Implement** the harness, `MC.dom.info`, the header counter and styles (`.info`, `.tip`, `#cost`; under 800 px `#cost` drops the `Σ ` prefix and shows 2 decimals); bump `?v=3`; wire the suite into `package.json` and `scripts/check.js`.
- [ ] **Step 4: Run** `npm run check` → all green, including `browser Round B (2 ok)`.
- [ ] **Step 5: Commit** — `feat: chat cost counter and info tooltips; Round B browser suite`

---

### Task 8: Router panel, decision-model list and composer chip

**Files:**
- Create: `js/ui/router.js` (`MC.ui.router`)
- Modify: `index.html` (`<dialog id="router-dialog" aria-label="Router">`, `<dialog id="route-preview-dialog" aria-label="Router picks">`, script `js/ui/router.js?v=3` before `js/app.js`), `js/app.js` (🧭 header button, `state.deciders`, load deciders at start and on model refresh), `js/ui/composer.js` (router chip + placeholder), `styles.css`
- Test: `tests/round-b.pw.js`

**Interfaces:**
- Consumes: `MC.router.withDefaults`, `MODES` (Task 5); `MC.models.loadDeciders` (Task 2); `MC.dom.info` (Task 7).
- Produces:
  - `MC.ui.router.open()` — the panel of spec §6.3; every row label followed by `MC.dom.info(<Appendix A text>)`; each change saves `settings.router` via `withDefaults` and calls `MC.app.refresh()`.
  - `MC.ui.router.label(settings) -> string` — `'🧭 Off'` or `'🧭 <Short> ×N'` with short names `Auto, Free, Diverse, Best, Manual`, and `'🧭 Native'`.
  - Decider list rows: `.decider-row` with name, `$<priceIn>/M in`, context, badges `🖼`/`📄`/`FREE`, `desc`, star button `.star` (`★`/`☆`, toggles `settings.starredDeciders`), greyed `.unavailable` rows for starred ids not in `state.deciders`. Filters: search box, `🖼 Images`, `📄 Files`, `Free`.
  - Composer: when `settings.router.enabled`, chip `.router-chip` text `🧭 <label> ✕` (✕ sets `enabled:false`); placeholder `Ask — the router picks N model(s)…` (`Ask — OpenRouter picks the model…` in native).
  - `MC.app.state.deciders: Decider[]`.

- [ ] **Step 1: Write the failing browser tests**

```js
test('router panel saves mode, count and pool; toolbar and chip update', async (b) => {
  // open via '#topbar button.router-btn'; pick Diverse, count 3 → '#topbar .router-btn' text '🧭 Diverse ×3'; '.router-chip' visible
});
test('native mode disables the count at 1', async (b) => {});
test('decider list shows the six stars first and filters by images and free', async (b) => {
  // first six .decider-row names = starred order; tick Free → only mammoth, elephant; tick Images → no mammoth/elephant
});
test('starring a decider persists', async (b) => {});
test('every router option has an info button', async (b) => { /* count .info inside #router-dialog >= 9 */ });
```

- [ ] **Step 2: Run** `node tests/round-b.pw.js` → FAIL.
- [ ] **Step 3: Implement** the panel, list, chip and wiring.
- [ ] **Step 4: Run** `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: router panel, decision model list and composer chip`

---

### Task 9: Routed sending, preview, route bar and native answers

**Files:**
- Modify: `js/app.js`, `js/ui/composer.js`, `js/ui/chat.js`, `js/ui/router.js`, `styles.css`
- Test: `tests/round-b.pw.js`

**Interfaces:**
- Consumes: `runner.route` (Task 6), `MC.conv.ensureLanes`, `isRouted` (Task 3), `MC.ui.router` (Task 8).
- Produces:
  - `MC.app.sendRouted(text, files: File[]) -> Promise<boolean>` — `false` keeps composer content. Steps (spec §5.9): validate/read attachments as `sendWithAttachments` does (factor the shared part into `readAttachments(files) -> {refs, read} | null`); `runner.route(…)` with `selection = currentModelIds()`, `filters = settings.pickerFilters`, `contextNote` = last turn's TL;DR content or the last 3 user inputs (≤ 300 chars each); on `ok:false` toast (`aborted` silent) and return `false`; if `preview`, `await MC.ui.router.preview(result)`; `ensureLanes(conv, picks)`; save attachments; `MC.attach.buildInputs` for picked lanes with `incapableIds: []`; `sendTurn('broadcast', inputs, { attachments, delivery, route })`.
  - Composer `submit()`: router enabled and no target → `sendRouted` (same "keep content on false" handling as attachments); Send shows `🧭 routing…` and Stop/Esc aborts the route (`app().abortRoute()`).
  - `MC.ui.router.preview(result) -> Promise<{ action: 'send', picks: Model[] } | { action: 'selection' } | null>` — chips `.pick-chip` (name, `p %`, ✕), `＋ Add from pool` select, buttons `Send`, `Send to my selection instead`, `Cancel`; Send disabled with 0 picks. `'selection'` → normal broadcast (with attachments via `sendWithAttachments`).
  - Chat: route bar `.route-bar` above `.lanes` (spec §6.5 text: mode name, decider short name, `task: x`, `formatCost(usage.cost)`, `ms` as `0.4 s`, picks `Name 62 %`, note, `<details>` "candidates (n)"); non-picked active lanes in routed turns: `— not routed this turn`; native cells: `→ answered by <short name>` (`.served`).

- [ ] **Step 1: Write the failing browser tests**

```js
test('auto mode routes to the top N and shows the route bar', async (b) => {
  // router {enabled, mode:'auto', count:2, pool:'catalog'}; ask → one decisions request to perplexity/pplx-decider-v1.2;
  // 2 answered cells; other active lanes '— not routed this turn'; .route-bar contains 'Decider' and 'task: chat'
});
test('an image is never routed to a model without image input', async (b) => {
  // attach png; pool catalog; every chat request body's model is in the fixture's image-capable ids; decision criteria keys too
});
test('picker filters restrict the decision candidates', async (b) => {});
test('selection pool only offers the toolbar models', async (b) => {});
test('diverse mode picks distinct providers', async (b) => {});
test('best free without free deciders uses rules and makes no decision request', async (b) => { /* opts.noDeciders */ });
test('decision 429 falls back to the next starred decider, then rules with a note', async (b) => {});
test('preview: remove a pick, cancel keeps the text, send uses the edited picks', async (b) => {});
test('native mode sends openrouter/auto with allowed_models and session_id; shows answered by', async (b) => {});
test('targeted reply bypasses the router', async (b) => { /* ↳ Reply → no new decisions request */ });
test('Stop while routing sends nothing and keeps the text', async (b) => { /* opts.decideDelay 2000 */ });
```

(`mockOpenRouter` gains `opts.decideDelay` ms for this test.)

- [ ] **Step 2: Run** `node tests/round-b.pw.js` → FAIL.
- [ ] **Step 3: Implement** the send path, preview, route bar and cell states.
- [ ] **Step 4: Run** `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: routed sending with preview, route bar and native answers`

---

### Task 10: Very best answer extras, docs and final check

**Files:**
- Modify: `js/app.js` (`autoDerive`), `js/ui/chat.js` (🏆 badge, "Judge again"), `README.md`, `styles.css`
- Test: `tests/round-b.pw.js`

**Interfaces:**
- Consumes: `runner.runJudge`, `MC.router.chooseDecider` (Tasks 5–6), `MC.cost.summary` (Task 4).
- Produces:
  - After a routed `best` turn finishes: `extras.fusion` → `runFusion` with `settings.fusionModel` (≥ 2 answers; skipped when the v1 auto-Fusion already ran it for this turn); `extras.judge` → `runJudge(conv, turn.id, chooseDecider(...))` (≥ 2 answers).
  - Winning cell: `.badge.best` `🏆 best (p %)`; route bar button `Judge again` (calls `runJudge`).
  - README: a **Router** section (modes, pool, count, decision models and stars, preview, native, extras, costs of decisions) and the **Σ cost** counter under Features; Development section lists `tests/round-b.pw.js`.

- [ ] **Step 1: Write the failing browser tests**

```js
test('very best with judge marks the best answer and the counter includes the judge', async (b) => {
  // mode best, count 3, extras.judge → .badge.best on one cell; cost breakdown shows 'Judge'
});
test('very best with fuse renders a Fusion', async (b) => {});
```

- [ ] **Step 2: Run** `node tests/round-b.pw.js` → FAIL.
- [ ] **Step 3: Implement** the extras, badge and README.
- [ ] **Step 4: Run** `npm run check` → all green; read the output and confirm every line is `ok`.
- [ ] **Step 5: Commit** — `feat: very best answer extras (fusion, judge); docs: Round B`

After Task 10: whole-branch review, then ask the user before any merge, deploy or pull request.
