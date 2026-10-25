# Multaichat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vanilla-JS, client-only web app that sends prompts to several OpenRouter models in parallel, shows per-model lanes, supports targeted/clarify replies, forking, TL;DR and topic-grouped Fusion, and stores everything locally.

**Architecture:** Classic `<script>` files attached to `window.MC` (no ES modules, no build). Pure logic lives in `js/core/*` with a UMD footer so Node tests can `require` it; DOM code lives in `js/ui/*` and `js/app.js`. Conversations in IndexedDB, settings/key in localStorage.

**Tech Stack:** HTML/CSS/vanilla JS (ES2020), Node 22 `node --test` for unit tests, preinstalled Playwright (`require('playwright')`) for one smoke test. Zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-multaichat-design.md`

## Global Constraints

- No ES modules, no bundler, no npm dependencies; must run from `file://` and GitHub Pages.
- Every `js/core/*.js` file ends with the UMD footer (Task 1) and touches no DOM at load time.
- API base: `https://openrouter.ai/api/v1`; headers `Authorization: Bearer <key>`, `X-Title: Multaichat`, `HTTP-Referer: location.origin` (omit when protocol is `file:`).
- Streaming body includes `stream: true, usage: { include: true }`.
- Model cache TTL: 24 h. localStorage keys: `mc.settings`, `mc.apiKey`, `mc.modelsCache`.
- IndexedDB: database `multaichat`, version 1, object store `conversations` keyPath `id`, index `updatedAt`.
- Never put unescaped model/user text into `innerHTML`; only via `MC.md.render` or `textContent`.
- API key never logged and never included in exports.
- Lane grid min column width 280px; mobile breakpoint 800px.
- Commit after every task; messages in `feat:/test:/docs:` style.

## Review Focus

1. **Pasted key with whitespace or a `Bearer ` prefix** → key is trimmed and prefix stripped before saving (Task 2 test `normalizeKey`).
2. **Network drops mid-stream** → the column keeps the partial text, status `error`, Retry offered; other lanes unaffected (Task 3 test `stream error keeps partial`; Task 9 test `one lane failing`).
3. **Page reloaded while answers are streaming** → on load, any response left `streaming` becomes `stopped` with its saved partial content (Task 5 test `recoverInterrupted`).
4. **IndexedDB unavailable** (some private modes / `file://` in Firefox/Safari) → store falls back to localStorage with a visible "history limited" notice instead of crashing (Task 2 test `fallback store`).
5. **A saved model id no longer exists after the model list refreshes** → it is dropped from the selection with a toast, and summary/fusion models fall back to defaults (Task 4 test `reconcileSelection`).

## File Map

```
index.html, styles.css, package.json, README.md
js/core/util.js          MC.util
js/core/storage.js       MC.storage
js/core/openrouter.js    MC.api
js/core/models.js        MC.models
js/core/conversation.js  MC.conv
js/core/clarify.js       MC.clarify
js/core/fusion.js        MC.fusion
js/core/runner.js        MC.runner   (orchestrates streaming into a conversation; DOM-free)
js/ui/markdown.js        MC.md
js/ui/dom.js             MC.dom      (h() element helper, toast, dialog helpers)
js/ui/settings.js, js/ui/sidebar.js, js/ui/picker.js,
js/ui/chat.js, js/ui/composer.js, js/ui/derived.js
js/app.js
tests/*.test.js, tests/fixtures/models.json, tests/smoke.pw.js
```

---

### Task 1: Scaffold, UMD pattern, util

**Files:**
- Create: `package.json`, `index.html` (skeleton), `styles.css` (empty tokens), `js/core/util.js`, `tests/util.test.js`, `tests/load.js`

**Interfaces:**
- Produces: UMD footer used by every core file:
  ```js
  (function (root, factory) {
    const mod = factory(root.MC || {});
    if (typeof module === 'object' && module.exports) module.exports = mod;
    else { root.MC = root.MC || {}; root.MC.util = mod; } // name varies per file
  })(typeof self !== 'undefined' ? self : this, function (MC) { /* ... */ return { ... }; });
  ```
  `tests/load.js` exports `load(name)` that requires `js/core/<name>.js`, and pre-populates a global `MC` with already-loaded deps so cross-module use works in Node.
- Produces `MC.util`: `uid(prefix?: string): string` (prefix + 10 base36 chars), `escapeHtml(s): string` (escapes `& < > " '`), `debounce(fn, ms)`, `throttle(fn, ms)` (trailing call guaranteed), `formatCost(usd: number): string` (`<$0.0001` → `"<$0.0001"`, else `$` + 4 significant decimals trimmed, e.g. `0.00123` → `"$0.0012"`), `formatTokens(n)` (`1234` → `"1.2k"`), `pricePerM(perTokenString): number|null` (string `"0.000003"` → `3`; `"-1"`/missing → `null`), `isFileProtocol(): boolean`.
- `package.json`: `{"name":"multaichat","private":true,"scripts":{"test":"node --test tests/","smoke":"node tests/smoke.pw.js"}}`.

- [ ] **Step 1:** Write `tests/util.test.js` asserting: `uid('c_')` matches `/^c_[a-z0-9]{10}$/` and two calls differ; `escapeHtml('<a href="x">\'&')` === `'&lt;a href=&quot;x&quot;&gt;&#39;&amp;'`; `formatCost(0.00001)` === `'<$0.0001'`; `formatCost(0.00123)` === `'$0.0012'`; `formatCost(1.5)` === `'$1.50'`; `formatTokens(1234)` === `'1.2k'`; `formatTokens(999)` === `'999'`; `pricePerM('0.000003')` === `3`; `pricePerM('0')` === `0`; `pricePerM('-1')` === `null`; throttle with fake timers (`t.mock.timers.enable()`) calls trailing once.
- [ ] **Step 2:** Run `npm test` → FAIL (module not found).
- [ ] **Step 3:** Implement `js/core/util.js`, `tests/load.js`, `package.json`. `index.html` skeleton: header (title, model chips area, ⚙ button), `<aside id="sidebar">`, `<main id="chat">`, `<footer id="composer">`, script tags in spec §3 order (files created later may be added as they land).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: scaffold project and util helpers`.

### Task 2: Storage (settings, key, conversation store with fallback)

**Files:** Create `js/core/storage.js`, `tests/storage.test.js`

**Interfaces:**
- Consumes: none (pass `localStorage`/`indexedDB` in for testability).
- Produces `MC.storage`:
  - `normalizeKey(raw: string): string` — trim, strip leading `Bearer `, remove internal whitespace/newlines.
  - `createSettings(ls = globalThis.localStorage)` → `{ get(): Settings, set(patch): Settings, getKey(): string, setKey(k, remember: boolean): void, clearAll(): void }`. Key stored under `mc.apiKey` only if `remember`; otherwise kept in memory. `Settings` defaults: `{ selected: [], summaryModel: null, fusionModel: null, autoTldr: false, autoFusion: false, theme: 'system', rememberKey: true }`. Corrupt JSON → defaults.
  - `openStore({ idb = globalThis.indexedDB, ls = globalThis.localStorage } = {}) : Promise<Store>` where `Store = { kind: 'idb'|'local', list(): Promise<ConvMeta[]>, get(id), put(conv), delete(id), all(): Promise<Conversation[]> }`. `ConvMeta = {id,title,updatedAt,parentId,forkedAtTurn}`; `list()` sorted by `updatedAt` desc. If `idb` is missing or `open` errors, returns the localStorage-backed store (key `mc.conversations`, a JSON map) with `kind: 'local'`.
  - `exportJson(convs): string` (`{app:'multaichat',version:1,exportedAt,conversations}`), `importJson(text, existing: Conversation[]): Conversation[]` — merge by id, newer `updatedAt` wins; throws `Error('Not a Multaichat export')` on wrong shape.

- [ ] **Step 1:** Tests with an in-memory `ls` fake (`getItem/setItem/removeItem`): `normalizeKey('  Bearer sk-or-v1-abc\n ')` === `'sk-or-v1-abc'`; settings defaults on empty and on corrupt `mc.settings`; `setKey('k', false)` leaves `mc.apiKey` unset but `getKey()` returns `'k'`; `setKey('k', true)` persists; `clearAll()` removes all `mc.*` keys. **fallback store:** `openStore({ idb: undefined, ls })` → `kind === 'local'`, put/get/list/delete round-trip, list order by `updatedAt`. `importJson` merge (older incoming loses, newer wins, new id added) and wrong shape throws. `exportJson` output contains no `apiKey` field.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. IndexedDB path is promise-wrapped `open('multaichat', 1)` creating store `conversations` + index `updatedAt`; it is verified by the Task 14 smoke test, not unit tests.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: local storage for settings, key and conversations`.

### Task 3: OpenRouter client and SSE parser

**Files:** Create `js/core/openrouter.js`, `tests/openrouter.test.js`

**Interfaces:**
- Produces `MC.api`:
  - `createSseParser(onEvent: (obj|'[DONE]') => void): { push(chunkText: string): void, end(): void }` — splits on `\n`, keeps partial lines buffered, ignores blank and `:`-prefixed lines, parses `data: ` payloads (JSON or `[DONE]`), ignores unparsable payloads.
  - `headers(key): object` — per Global Constraints.
  - `streamChat({ key, model, messages, signal, onDelta(text), fetchImpl = fetch }) : Promise<{ content, usage|null, finishReason }>` — throws `ApiError` on non-2xx or mid-stream `error` object; `ApiError` has `.status`, `.message`, `.partial` (content so far). Abort → throws `ApiError` with `status: 'aborted'` and `.partial`.
  - `complete({ key, model, messages, responseFormat?, signal, fetchImpl }) : Promise<{ content, usage }>` — non-streaming; if `responseFormat` given and server returns 400, retry once without it.
  - `fetchModels({ fetchImpl }) : Promise<RawModel[]>` (GET `/models`, returns `data`).
  - `testKey({ key, fetchImpl }) : Promise<{ ok: boolean, label?, limitRemaining? }>` (GET `/key`).
  - `errorMessage(err: ApiError, modelId): string` — 401 `"Invalid API key — check Settings"`, 402 `"Out of OpenRouter credits"`, 429 `"Rate limited — retry in a moment"` (if `modelId` ends with `:free`: `"Free model rate-limited — retry or pick the paid variant"`), `'aborted'` `"Stopped"`, network `"Network error — check your connection"`, else server message.
  - `usage` normalized to `{ promptTokens, completionTokens, cost }`.

- [ ] **Step 1:** Tests: parser handles a `data:` line split across two `push` calls; ignores `: OPENROUTER PROCESSING`; emits `'[DONE]'`. `streamChat` with a fake `fetchImpl` returning `new Response(ReadableStream)` of chunks `data: {"choices":[{"delta":{"content":"He"}}]}\n\n`, `...llo...`, `data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.0001}}\n\n`, `data: [DONE]\n\n` → resolves `content === 'Hello'`, usage `{promptTokens:3,completionTokens:2,cost:0.0001}`, `onDelta` called with `'He'` then `'llo'`. **stream error keeps partial:** stream emits `He` then `data: {"error":{"message":"boom"}}` → rejects with `ApiError` `.partial === 'He'`, message `boom`. Non-2xx 401 JSON body → `status 401`. `complete` retries without `response_format` after 400 (assert two fetch calls, second body lacks `response_format`). `headers` omits `HTTP-Referer` when `globalThis.location` is undefined or `file:`. `errorMessage` cases above.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement with `response.body.getReader()` + `TextDecoder`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: OpenRouter client with streaming`.

### Task 4: Models — normalize, sections, search, cache

**Files:** Create `js/core/models.js`, `tests/models.test.js`, `tests/fixtures/models.json` (≈30 hand-written RawModels covering: each flagship provider with 2 versions of differing `created`, `:free` variants, zero-price models, open-weight with `hugging_face_id`, open-weight without it from an open provider, preview/beta/image/embed/guard ids, a 4k-context model, an image-only output model).

**Interfaces:**
- Produces `MC.models`:
  - `normalize(raw: RawModel[]): Model[]` — keeps text-output only; `Model = { id, name, provider (id before '/'), created (sec), context, priceIn, priceOut (per M, number|null), free: boolean, open: boolean, isNew(now): boolean }` where `free` = id ends `:free` or both prices `0`; `open` = truthy `hugging_face_id` **or** provider in `OPEN_PROVIDERS = ['meta-llama','mistralai','qwen','deepseek','google/gemma*','microsoft','nvidia','nousresearch','moonshotai','z-ai','thudm','minimax','allenai','openai/gpt-oss*','cohere/command-r7b*','ibm-granite','baidu','tencent','liquid']` (entries with `*` are id prefixes, others provider names). (Field not verifiable from this sandbox; the OR keeps detection working either way.)
  - `FLAGSHIP = ['anthropic','openai','google','x-ai','deepseek','meta-llama','mistralai','qwen']`.
  - `sections(models, now = Date.now()) : { top: Model[], free: Model[], open: Model[], all: Model[] }` per spec §5 (exclusion regex `/preview|beta|-exp|:extended|audio|image|embed|guard/i`; context min 32000, free section 8000; open: `created` within 180 days, ≤2 per provider, newest first, tie → larger context, cap 12; free: newest first, full list returned — UI shows first 12; top: one per FLAGSHIP in that order; `isNew` = within 30 days).
  - `search(models, query, now) : Model[]` — tokens `free|open|new` become filters; remaining words all must appear in `name + id + provider` (lowercase); ranking: id/name startsWith first word → first, then newest.
  - `sortBy(models, 'newest'|'price'|'context')`, `filter(models, { freeOnly, openOnly, maxPrice })`.
  - `loadCached({ ls, fetchModelsFn, now, force }) : Promise<{ models: Model[], stale: boolean, source: 'network'|'cache'|'fallback' }>` — uses `mc.modelsCache` `{fetchedAt, raw}` if `< 24h` and not `force`; on fetch failure use cache (any age, `stale: true`), else `FALLBACK_RAW` (5 entries: one each anthropic, openai, google, deepseek, a `:free` model).
  - `reconcileSelection(settings, models) : { settings, dropped: string[] }` — drops unknown ids from `selected`; if summary/fusion model unknown, reset to defaults (`summary` = cheapest of `top` by `priceOut`, `fusion` = `top[0]`); if `selected` empty → first 3 of `top`.

- [ ] **Step 1:** Tests against fixture with fixed `now`: `normalize` drops image-only; `free` true for `:free` and zero-price; `open` true for HF id and for `qwen/x` without HF id, false for `anthropic/*`. `sections.top` ids exactly the newest non-excluded per FLAGSHIP in order; excludes preview/4k; `sections.free` includes the 8k free model, newest first; `sections.open` ≤2 per provider and none older than 180 days. `search('qwen coder')` only returns models containing both words; `search('free llama')` only free llamas; `search('claude')` ranks `anthropic/claude-*` whose name starts with "Claude" first. `loadCached`: fresh cache → no fetch; stale cache + fetch throws → cache with `stale:true`; no cache + fetch throws → `source:'fallback'`. **reconcileSelection:** selected `['gone/model','anthropic/x']` → dropped `['gone/model']`; unknown fusion model reset to `top[0].id`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: model catalog with search and suggestion sections`.

### Task 5: Conversation model

**Files:** Create `js/core/conversation.js`, `tests/conversation.test.js`

**Interfaces:**
- Consumes: `MC.util.uid`.
- Produces `MC.conv` (all pure; mutate-and-return the given conv object for simplicity, setting `updatedAt`):
  - `create(models: {id,name}[], now) : Conversation` — data shape exactly as spec §4.
  - `addTurn(conv, kind, inputs: {[laneId]: string}) : Turn` — creates `responses[laneId] = {status:'streaming', content:'', previous:[], asksQuestion:false}` for each input lane; sets title from first input (first 60 chars, trimmed, single line) if title is `'New chat'`.
  - `broadcastInputs(conv, text)`: `{[laneId]: text}` for active lanes.
  - `buildMessages(conv, laneId, uptoTurnIndex) : {role, content}[]` — per spec §4, including `seedContext` system message.
  - `addLane(conv, model) : Lane` — `joinedAtTurn = turns.length`, `seedContext` = `"Context from the conversation so far (you joined late):\n"` + per-turn `tldr.content` lines, or prior user inputs (`"User: …"`) when no TL;DRs.
  - `removeLane(conv, laneId)` — `active=false`.
  - `beginRetry(conv, turnId, laneId)` — pushes current `{content, usage, createdAt}` into `previous`, resets response to streaming.
  - `fork(conv, turnIndex, { onlyLaneId } = {}) : Conversation` — deep copy of lanes and turns `0..turnIndex`, new ids for conversation only (lane/turn ids kept), `parentId`, `forkedAtTurn`, title `"↳ " + title`; with `onlyLaneId` keep that lane only and strip other lanes from each turn's `inputs/responses`, drop `fusion`.
  - `recoverInterrupted(conv) : boolean` — any `streaming` response → `stopped`; derived `streaming` → `error` with `"Interrupted"`; returns whether anything changed.
  - `answeredLanes(turn) : laneId[]` — responses with status `done`/`stopped` and non-empty content.

- [ ] **Step 1:** Tests: broadcast then targeted-to-lane-B turn → `buildMessages(A)` has 2 messages (turn 2 skipped), `buildMessages(B)` has 4; clarify-batch with different inputs per lane → each lane's last user message is its own input; error responses produce a user message without an assistant one; late lane gets leading system seed with TL;DR text; `fork(conv,0)` has 1 turn, `parentId` set, original untouched (deep copy); `fork(conv,1,{onlyLaneId})` has one lane and turns contain only that lane; `beginRetry` moves content into `previous`; **recoverInterrupted** turns `streaming` into `stopped` keeping content and returns true; title derived from first input truncated to 60.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement (deep copy via `structuredClone`).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: conversation lanes, turns and forks`.

### Task 6: Clarification detection

**Files:** Create `js/core/clarify.js`, `tests/clarify.test.js`

**Interfaces:**
- Produces `MC.clarify.detect(text: string) : { asks: boolean, question: string }` per spec §7 (strip fenced code first; phrase list exactly: `could you clarify`, `let me know`, `do you want`, `would you like`, `can you tell me`, `please specify`, case-insensitive). `question` = sentences of the last paragraph containing `?` or a phrase, joined by space, max 300 chars.

- [ ] **Step 1:** Tests: `"Plan…\n\nWhat month are you going?"` → asks, question `"What month are you going?"`; `"Is it hard? Not really. Here's how:\n\n1. Do X"` → false (question not in last paragraph); answer ending with code block containing `a ? b : c` → false; `"…\n\nLet me know if you want more detail."` → true; list-like ending `"- Budget?\n- First visit?"` → true with both; empty string → false.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: clarifying-question detection`.

### Task 7: TL;DR and Fusion prompts and parser

**Files:** Create `js/core/fusion.js`, `tests/fusion.test.js`

**Interfaces:**
- Consumes: `MC.conv.answeredLanes`.
- Produces `MC.fusion`:
  - `tldrMessages(conv, turn) : messages` — system text verbatim from spec §8; user content: `Question(s):` (unique inputs of the turn) then `### <modelName>\n<content>` per answered lane.
  - `fusionMessages(conv, turn) : messages` — system describes the exact JSON schema from spec §8, instructs to use given model ids, `quote` must be copied verbatim (≤300 chars), return JSON only.
  - `parse(text, answersByModel: {[modelId]: string}) : { ok: true, data } | { ok: false, raw }` — strip ```` ```json ```` fences, slice from first `{` to last `}`, JSON.parse, require `topics` array; default missing `overview`/`disagreements`/`unique` to `''`/`[]`; drop entries whose model id not in `answersByModel`; each excerpt gets `verified` = whitespace-collapsed, lowercased quote is a substring of the same-normalized answer.

- [ ] **Step 1:** Tests: `tldrMessages` includes each model name heading and question; `parse` handles fenced JSON with leading prose; invalid JSON → `{ok:false, raw}`; missing `topics` → not ok; unknown model ids removed from `models`, `excerpts`, `positions`, `unique`; quote with different spacing/case marked `verified:true`, invented quote `verified:false`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: tldr and fusion prompting and parsing`.

### Task 8: Safe Markdown renderer

**Files:** Create `js/ui/markdown.js` (UMD like core), `tests/markdown.test.js`

**Interfaces:**
- Consumes: `MC.util.escapeHtml`.
- Produces `MC.md.render(src: string): string` (HTML string) supporting spec §11 list; fenced code → `<pre><code class="lang-x">…</code><button class="copy" data-copy>Copy</button></pre>`; links only `http(s)` with `target="_blank" rel="noopener noreferrer"`; tables with `|` header + `---` row. Tolerates unterminated fences (streaming).

- [ ] **Step 1:** Tests: `render('<img src=x onerror=alert(1)>')` contains no `<img`; `render('[x](javascript:alert(1))')` has no `href="javascript`; `**b**` → `<strong>b</strong>`; fenced code keeps `<` escaped inside; unterminated fence renders as code; `- a\n- b` → `<ul>` with 2 `<li>`; a 2-column table renders `<table>` with `<th>`; `# H` → `<h1>`... headings capped at `<h4>`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (escape whole source first, then block parse line by line, inline regexes on escaped text). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: safe markdown renderer`.

### Task 9: Runner (streaming orchestration, DOM-free)

**Files:** Create `js/core/runner.js`, `tests/runner.test.js`

**Interfaces:**
- Consumes: `MC.api.streamChat/complete/errorMessage`, `MC.conv.*`, `MC.clarify.detect`, `MC.fusion.*`.
- Produces `MC.runner.createRunner({ api, getKey, save: (conv) => Promise, onChange: (conv, info) => void })` → 
  - `send(conv, kind, inputs) : Promise<Turn>` — `addTurn`, `save`, then streams every input lane in parallel with its own `AbortController`; on delta appends to `response.content` and calls `onChange(conv, {turnId, laneId})` and a throttled (1000 ms) `save`; on finish sets `done`, usage, `asksQuestion/question` from `detect`; on error sets `error`, `error` message from `errorMessage`, keeps partial; on abort `stopped`. Final `save` after all settle. Resolves when all lanes settle (never rejects for a lane error).
  - `retry(conv, turnId, laneId)`, `stop(turnId, laneId?)` (no laneId = all), `runTldr(conv, turnId, modelId)` (streams into `turn.tldr`), `runFusion(conv, turnId, modelId)` (complete with `responseFormat:{type:'json_object'}`, then `MC.fusion.parse` into `turn.fusion = {modelId,status:'done',data}` or `{status:'error', raw}`).
  - Missing key → each lane gets `error: "Add your OpenRouter API key in Settings"` without fetching.

- [ ] **Step 1:** Tests with a fake `api` (`streamChat` resolving/rejecting per model id after calling `onDelta`): **one lane failing:** lanes A ok, B rejects ApiError(500, partial 'x') → A `done`, B `error` with content `'x'`, `send` resolves; `save` called at least twice; stop aborts the signal passed to `streamChat` and status becomes `stopped`; asking answer sets `asksQuestion`; `runFusion` stores parsed data; `runFusion` with junk stores `{status:'error', raw}`; no key → no `streamChat` calls.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: parallel streaming runner`.

### Task 10: App shell, DOM helpers, settings dialog, sidebar

**Files:** Create `js/ui/dom.js`, `js/ui/settings.js`, `js/ui/sidebar.js`, `js/app.js`; fill `index.html`, `styles.css`.

**Interfaces:**
- Produces `MC.dom`: `h(tag, attrs, ...children)` (attrs: `class`, `on*` handlers, `dataset`, others via `setAttribute`; string children as text nodes), `toast(msg, kind='info')`, `openDialog(el)/closeDialog(el)` on `<dialog>`.
- `MC.ui.settings.open()`; fields per spec §9; "Test key" uses `MC.api.testKey`; "Clear all local data" confirms then `settings.clearAll()` + deletes all conversations + reload.
- `MC.ui.sidebar.render(metas, currentId)`; forks nested under parent (indent, `↳`); actions: new, select, rename (dblclick → inline input, Enter saves), delete (confirm), search title filter, export current/all, import (file input).
- `app.js`: `MC.app = { state: { settings, store, models, conv }, start() }`. `start()`: create settings, `openStore` (if `kind==='local'` toast `"Browser database unavailable — history stored in limited local storage"`), `loadCached` models (+ `reconcileSelection`, toast for dropped), load most recent conv (run `recoverInterrupted`, save if changed) or show empty state; no key → first-run card (spec §9 text with link `https://openrouter.ai/keys`). Theme via `data-theme` on `<html>`.
- CSS: custom properties light/dark, `prefers-color-scheme`, layout grid (sidebar 260px collapsible, main lanes grid `repeat(auto-fit, minmax(280px,1fr))` with horizontal scroll fallback).

- [ ] **Step 1:** Implement the files above.
- [ ] **Step 2:** Manual check: run `python3 -m http.server 8000` and load `http://localhost:8000` with a short Playwright snippet; also load `file://…/index.html`. Expected both: page title "Multaichat", first-run key card visible, no `pageerror`.
- [ ] **Step 3:** `npm test` still PASS.
- [ ] **Step 4:** Commit `feat: app shell, settings and sidebar`.

### Task 11: Model picker UI

**Files:** Create `js/ui/picker.js`; modify `index.html`, `styles.css`, `js/app.js`.

**Interfaces:**
- Consumes: `MC.models.sections/search/sortBy/filter`, settings.
- Produces `MC.ui.picker.open({ mode: 'select'|'single', selected: string[], onDone(ids) })` and `MC.ui.picker.mountQuickAdd(container, onPick(modelId))`.
- Behaviour per spec §5: pinned autofocus search (debounce 100 ms), sections Top picks / Free (12 + "Show all free (n)") / Open-weight (12 + show all) / All models (sort select + free/open toggles + max $/M number input); rows show name, provider, context (`formatTokens`), prices or `FREE`, badges 🆕/OPEN/FREE; ↑/↓/Enter/Space/Esc; 🔄 refresh (`force:true`), stale indicator when `stale`; "Try with free models" selects top 3 free. Global shortcut `/` (when focus not in a text field) and Ctrl/Cmd+K open it. `single` mode used by settings for summary/fusion model choice.
- Header shows selected model chips (click × to remove lane via `MC.conv.removeLane` when a conversation exists).

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify in browser (Task 14 harness or manual) with fixture models injected via `mc.modelsCache`: typing `free` shows only FREE rows; Enter toggles the highlighted row.
- [ ] **Step 3:** Commit `feat: model picker with search and suggestions`.

### Task 12: Chat lanes and composer (broadcast, targeted, inline reply, answer together)

**Files:** Create `js/ui/chat.js`, `js/ui/composer.js`; modify `js/app.js`, `styles.css`.

**Interfaces:**
- Consumes: `MC.runner`, `MC.conv`, `MC.md.render`.
- `MC.ui.chat.render(conv)` full render; `MC.ui.chat.updateCell(conv, turnId, laneId)` incremental (only re-render that cell's markdown, at most once per animation frame).
- Each turn row: the user input(s) (one bubble if broadcast; per-lane label if different), then a lane cell per lane: header (model name, status, tokens/cost), body markdown, footer actions ↳ Reply, ↻ Retry, ■ Stop (while streaming), Copy, "previous (n)" toggle; error cell shows message + Retry; absent lane → `— not asked this turn`; ❓ badge + inline textarea when `asksQuestion` (Enter sends targeted turn to that lane, Shift+Enter newline). Turn actions bar: TL;DR, Fusion, ⑂ Fork, and per-cell "Continue with just this model".
- `MC.ui.composer`: textarea (Enter send, Shift+Enter newline), target chip `↳ to <Model> only ✕` set by `setTarget(laneId|null)`, cleared after send; Stop all button while streaming; Alt+1…9 focuses lane N's latest inline reply box (or sets composer target if none).
- **Answer together:** banner when ≥2 lanes in the latest turn have `asksQuestion`; panel per spec §7 (per-lane textarea with question text, "same answer for all", "also send to models that didn't ask", Ctrl/Cmd+Enter send, Tab order) → `runner.send(conv,'clarify-batch',inputs)`. For non-asking lanes the text is `"Answers to other models' questions:\n" + each "<Model>: <answer>"`.
- Mobile (<800px): lanes as tabs (`role=tablist`), swipe via pointer events (horizontal delta > 60px), unread dot when a lane changes while not visible, ❓ badge on tab.
- Fork actions call `MC.conv.fork`, `store.put`, switch to the new conversation, re-render sidebar.
- "+ Add model" quick-add in lane header bar → `MC.conv.addLane`, save, re-render. Late lanes show `joined at turn N with summary context` under the header.
- A 429 on a `:free` model shows a "Use paid variant" button when the id without `:free` exists in the catalog; clicking swaps the lane's model and retries.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Browser check with the mocked API from Task 14 harness: broadcast to 3 lanes renders 3 cells; reply via inline box creates a turn where other lanes show "not asked this turn".
- [ ] **Step 3:** `npm test` PASS.
- [ ] **Step 4:** Commit `feat: lanes, targeted replies and answer-together panel`.

### Task 13: TL;DR and Fusion UI

**Files:** Create `js/ui/derived.js`; modify `js/ui/chat.js`, `js/app.js`, `styles.css`.

**Interfaces:**
- Consumes: `MC.runner.runTldr/runFusion`, settings `summaryModel`, `fusionModel`, `autoTldr`, `autoFusion`.
- `MC.ui.derived.renderTldr(turn)`, `renderFusion(turn, conv)`: per spec §8 rendering — overview, topic cards (title, merged markdown, model chips, collapsed `Show sources (n)` → side-by-side excerpts, unverified labelled "paraphrased"), Disagreements, Unique points; parse failure shows raw text (escaped via `md.render`) + "couldn't structure this — Regenerate". Buttons disabled with tooltip when answered lanes < 1 (TL;DR) or < 2 (Fusion). Regenerate replaces. Copy button copies TL;DR text / Fusion as Markdown.
- Auto-run: after `runner.send` resolves, if enabled and thresholds met, run TL;DR then Fusion.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Browser check with mocked fusion JSON: topic cards render, "Show sources" expands, fake quote shows "paraphrased".
- [ ] **Step 3:** Commit `feat: tldr and fusion views`.

### Task 14: Playwright smoke test and README

**Files:** Create `tests/smoke.pw.js`, `README.md`.

**Interfaces:**
- Consumes the whole app. Smoke script: `chromium.launch()`, `page.route('https://openrouter.ai/api/v1/**', …)` serving `tests/fixtures/models.json` for `/models`, `{data:{label:'test'}}` for `/key`, and SSE bodies for `/chat/completions` (answer text depends on `model` in request; one model's answer ends with a question; a fusion request (has `response_format`) returns fixed JSON).
- Runs twice: once against `file://<repo>/index.html`, once against `python3 -m http.server` (spawned on a free port, killed at end).

- [ ] **Step 1:** Write the smoke script asserting, for each origin: no `pageerror`; set key via settings; pick 3 models; send "hello" → 3 lane cells reach `done`; one shows ❓; inline reply → new turn with 2 "not asked this turn"; Fusion renders ≥1 topic card; reload → conversation still listed and content present (proves IndexedDB on that origin); fork → sidebar shows nested `↳` item.
- [ ] **Step 2:** Run `npm run smoke` → expect PASS for both `file://` and `http://`; fix any app bugs found (via superpowers:systematic-debugging).
- [ ] **Step 3:** README: what it is, privacy (key + history only in this browser, per origin; `file://` and Pages histories separate), how to run (open `index.html` or GitHub Pages: Settings → Pages → Deploy from branch → `/root`), keyboard shortcuts, free-model rate-limit note, `npm test` / `npm run smoke`.
- [ ] **Step 4:** `npm test && npm run smoke` → PASS.
- [ ] **Step 5:** Commit `test: browser smoke test; docs: README`.
