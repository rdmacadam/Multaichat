# Round A — Presets, Attachments, Model Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add picker filters (max in/out price, min context, images, files), presets with per-chat system prompts, and image/PDF/text attachments to the existing Multaichat app.

**Architecture:** New pure modules `js/core/presets.js` and `js/core/attach.js` (UMD, Node-tested) plus browser-only `js/ui/files.js` and `js/ui/presets.js`. Existing core modules gain fields/params without breaking v1 callers. IndexedDB goes to version 2 with an `attachments` store; conversations reference attachments by id.

**Tech Stack:** Vanilla JS (classic scripts on `window.MC`), Node 22 `node --test`, preinstalled Playwright. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-round-a-presets-attachments-filters-design.md` (builds on `docs/superpowers/specs/2026-10-25-multaichat-design.md`)

## Global Constraints

- Work only on branch `ccr-b9b47502-ukojr7`. Never modify, merge into, or push `main`; no PR or deploy without explicit approval.
- No ES modules, no build, no npm dependencies; must run from `file://` and GitHub Pages under `/Multaichat/` (all asset paths relative).
- New `js/core/*.js` files use the same UMD footer as existing ones and are registered in `tests/load.js` (`presets` → `MC.presets`, `attach` → `MC.attach`).
- Untrusted text reaches the DOM only via `textContent` or `MC.md.render`.
- Limits (spec §5): 10 attachments/message; image and PDF ≤ 20 MB (20 * 1024 * 1024 bytes); text ≤ 200 KB (200 * 1024) then truncated with `\n…[truncated at 200 KB]`; images downscaled to longest side ≤ 2048 px.
- Text block format: `\n\n--- file: <name> ---\n<content>\n--- end of <name> ---`.
- Omitted image line: `[image omitted: <name>]`; skipped reason: `can't read images`; missing record: `[attachment unavailable: <name>]`.
- localStorage keys added: `mc.presets`, `mc.attachments` (fallback store only). Settings added: `pickerFilters`, `defaultPresetId`, `pdfMode` (`'auto'|'ocr'`, default `'auto'`).
- IndexedDB `multaichat` version 2: new store `attachments` keyPath `id`; upgrade must not touch `conversations`.
- Export version `2`; v1 exports still import.
- After every task: `npm test`, `node tests/smoke.pw.js`, `node tests/regressions.pw.js` stay green.

## Review Focus

1. **Huge pasted screenshot (e.g. 6000×4000 PNG)** → downscaled to ≤ 2048 px and attached, not rejected (Task 9 test `downscales large image`).
2. **Attachments with an empty message** → sent; the user content array has no empty text part (Task 8 test `empty text with image omits text part`).
3. **Storage write of an attachment fails (quota)** → toast, nothing sent, composer text and chips kept (Task 7 test `putAttachment surfaces quota`; Task 9 test `attachment save failure keeps composer`).
4. **Chat's preset was deleted** → chip shows "Custom", no crash, prompt still sent (Task 3 test `presetLabel missing preset`).
5. **Filters exclude every model** → picker shows "No models match these filters" with Clear filters; quick-add shows nothing (Task 2 test `filters exclude everything`).

## File Map

```
js/core/models.js        (modify) capabilities + filter fields
js/core/presets.js       (new)    MC.presets
js/core/attach.js        (new)    MC.attach
js/core/conversation.js  (modify) system prompt, attachments in turns/buildMessages
js/core/storage.js       (modify) DB v2, attachment records, export/import v2
js/core/openrouter.js    (modify) plugins param
js/core/runner.js        (modify) resolve attachments, plugins, send extra
js/core/fusion.js        (modify) attachment notes
js/ui/files.js           (new)    MC.files: read File → record/ref, downscale
js/ui/presets.js         (new)    presets dialog, editor, save form, system prompt chip/dialog
js/ui/picker.js, js/ui/composer.js, js/ui/chat.js, js/ui/settings.js, js/ui/sidebar.js, js/app.js (modify)
index.html, styles.css, package.json, README.md (modify)
scripts/check.js         (new)    production check
tests/fixtures/models.json (modify) input_modalities
tests/pw-helpers.js      (modify) record request bodies
tests/round-a.pw.js      (new)    browser tests for this round
tests/{models,presets,attach,conversation,storage,openrouter,runner,fusion}.test.js
```

---

### Task 1: Model capabilities and filter fields

**Files:** Modify `js/core/models.js` (`normalize`, `filter`), `tests/fixtures/models.json`; Test `tests/models.test.js`

**Interfaces:**
- Produces: `Model.inputs: string[]`, `Model.images: boolean`, `Model.files: boolean`; `MC.models.filter(models, { freeOnly, openOnly, maxPrice, maxIn, maxOut, minContext, images, files })`. Unset = `null`/`''`/`undefined`/`false`. `maxPrice` is an alias of `maxOut`. With `maxIn`/`maxOut` set, models with `null` price are excluded. Numbers may arrive as strings.
- Produces: `MC.models.activeFilterCount(f): number` (counts set fields among `maxIn, maxOut, minContext, images, files`).

- [ ] **Step 1:** Update the fixture: add `"input_modalities": ["text","image","file"]` to `anthropic/claude-sonnet-5`, `google/gemini-3-pro`; `["text","image"]` to `openai/gpt-6`, `meta-llama/llama-5-405b`; leave others `["text"]`. Regenerate is not required — edit the JSON directly.
- [ ] **Step 2:** Write failing tests in `tests/models.test.js`: `normalize exposes input capabilities` (sonnet `images && files`, gpt-6 `images && !files`, deepseek-v4 `inputs` deep-equals `['text']`); `filter maxIn/maxOut` (`maxIn: 1` keeps only `priceIn <= 1` and drops `null` prices; `maxOut: '2'` string works; `maxPrice: 2` equals `maxOut: 2` result); `filter minContext` (`200000` keeps only `context >= 200000`); `filter images/files` (`{images:true}` ids = sonnet, gpt-6, gemini-3-pro, llama-5-405b; `{files:true}` = sonnet, gemini-3-pro); `activeFilterCount` (`{maxIn:1, images:true, files:false, minContext:''}` → 2).
- [ ] **Step 3:** Run `npm test` → new tests FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `npm test` → all PASS (existing model tests unchanged).
- [ ] **Step 6:** Commit `feat: model input capabilities and price/context filters`.

### Task 2: Picker filter bar, badges, persistence

**Files:** Modify `js/ui/picker.js`, `styles.css`, `js/core/storage.js` (`DEFAULT_SETTINGS.pickerFilters`), `tests/pw-helpers.js`; Create `tests/round-a.pw.js`

**Interfaces:**
- Consumes: Task 1 `filter`, `activeFilterCount`, `Model.images/files`.
- Produces: settings `pickerFilters: { maxIn: '', maxOut: '', minContext: '', images: false, files: false }` (default). `tests/pw-helpers.js` `mockOpenRouter(page, opts)` gains `opts.requests` (array; each chat request body is pushed). `tests/round-a.pw.js` has the same runner shape as `tests/regressions.pw.js` (named cases, `open(browser, opts, initLocalStorage)` helper, argv filter) and serves over http.

- [ ] **Step 1:** Write failing browser cases in `tests/round-a.pw.js`: `filters narrow every section` (open picker, tick 🖼 Images → every `.model-row` has `.badge.img`; "Filters (1)" visible; Top picks rows ⊆ image models); `filters persist` (set Min context 200k, close, reload, reopen → select value `200000`, row count same as before reload); `filters exclude everything` (Max out `0.01` + Images → `.picker-body` contains text "No models match these filters" and a "Clear filters" button that restores rows; quick-add list stays hidden on focus).
- [ ] **Step 2:** Run `node tests/round-a.pw.js filters` → FAIL.
- [ ] **Step 3:** Implement: filter bar under `.picker-search` (`Max in $/M`, `Max out $/M` number inputs; `Min context` select Any/32k/128k/200k/1M with values `''`,`32000`,`128000`,`200000`,`1000000`; `🖼 Images`, `📄 Files` checkboxes; "Filters (n)" label; "Clear filters" link). Apply `MC.models.filter(list, settings.pickerFilters)` after sections/search, for every section. Remove the old "Max $/M out" control from All models (sort, free-only, open-only stay). Badges `.badge.img` 🖼 and `.badge.file` 📄 in rows. Save filters on change via `MC.app.state.settings.set({ pickerFilters })`. Quick-add filters its pool with the same settings.
- [ ] **Step 4:** Run `node tests/round-a.pw.js filters`, `node tests/smoke.pw.js`, `node tests/regressions.pw.js` → PASS. (Smoke uses the picker; update it only if a selector it relies on moved.)
- [ ] **Step 5:** Commit `feat: picker filter bar with capability badges`.

### Task 3: Presets core

**Files:** Create `js/core/presets.js`, `tests/presets.test.js`; Modify `tests/load.js`

**Interfaces:**
- Produces `MC.presets`:
  - `BUILT_INS: Preset[]` — ids `builtin-concise`, `builtin-code-review`, `builtin-simple`; names and texts verbatim from spec §4; `builtIn: true`.
  - `createPresetStore(ls) → { list(): Preset[] (built-ins first, then user presets by name), get(id), save(p): Preset (new id `p_…` when missing or when `p.id` is a built-in id; strips empty parts; throws Error('Name required') on blank name), remove(id): boolean (false for built-ins), duplicate(id): Preset (name "<name> (copy)", not builtIn), userPresets(): Preset[], importMany(presets): number }`. Storage key `mc.presets`; corrupt → `[]` user presets.
  - `applyPlan(preset, conv | null) → { models: string[] | null, systemPrompt: string | null, presetId, template: string | null, confirmModels: boolean }` — `confirmModels` true only when `conv` has turns and `preset.models` differs (as a set) from active lane model ids.
  - `fromCurrent({ systemPrompt, models, template }) → { name: '', systemPrompt, models, template, include: { systemPrompt: !!systemPrompt, models: models.length > 0, template: !!template.trim() } }`.
  - `isEdited(conv, preset) → boolean` — `!!preset && (conv.systemPrompt || '') !== (preset.systemPrompt || '')`.
  - `presetLabel(conv, store) → string | null` — null when no `conv.systemPrompt`; preset name (+ ` (edited)` when edited); `'Custom'` when no or missing preset.

- [ ] **Step 1:** Write failing tests: built-ins present and undeletable; save assigns id, trims, rejects blank name; save with built-in id creates a new preset; duplicate; corrupt storage; `applyPlan` for null conv, empty conv, mid-chat same models (`confirmModels:false`) and different models (`true`); `fromCurrent` include flags with/without template; `isEdited`; **`presetLabel missing preset`** (`conv.presetId: 'p_gone'`, `systemPrompt: 'x'` → `'Custom'`).
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: presets store and planning helpers`.

### Task 4: System prompt in conversations

**Files:** Modify `js/core/conversation.js`; Test `tests/conversation.test.js`

**Interfaces:**
- Produces `MC.conv.setSystemPrompt(conv, text: string, presetId?: string)` — empty conv: overwrite (`systemPromptFromTurn = 0`); otherwise push the previous `{ fromTurn, text }` (only if a previous non-empty prompt existed) to `systemPromptHistory` and set `systemPromptFromTurn = conv.turns.length`. Empty `text` clears `systemPrompt`/`presetId` (history still recorded).
- Produces `MC.conv.promptAt(conv, turnIndex): string | null`.
- `buildMessages(conv, laneId, n, resolve?)` now emits the `promptAt(conv, n)` system message first, then `seedContext`. (`resolve` used from Task 8.)
- `fork` copies `systemPrompt`, `presetId`, `systemPromptFromTurn`, `systemPromptHistory` (structuredClone already does; add test).

- [ ] **Step 1:** Write failing tests: `system prompt first, then seed context`; `mid-chat change applies from next turn` (set "A" before turn 0, send 2 turns, set "B" → `promptAt(0..1)='A'`, `promptAt(2)='B'`; `buildMessages(...,1)[0].content === 'A'`); `clearing removes prompt for later turns only`; `fork keeps system prompt`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` PASS.
- [ ] **Step 5:** Commit `feat: per-chat system prompt with history`.

### Task 5: Presets UI, system prompt chip, default preset

**Files:** Create `js/ui/presets.js`; Modify `js/app.js`, `js/ui/chat.js`, `js/ui/composer.js` (`insertTemplate(text)`), `js/ui/settings.js`, `index.html` (script `js/core/presets.js` after `js/core/fusion.js`; `js/ui/presets.js` after `js/ui/derived.js`; `<dialog id="presets-dialog">`), `styles.css`, `tests/round-a.pw.js`

**Interfaces:**
- Consumes: Task 3 store/helpers, Task 4 `setSystemPrompt`.
- Produces: `MC.app.state.presets` (store); `MC.app.applyPreset(id)`; `MC.ui.presets.open()`, `MC.ui.presets.openSystemPrompt()`, `MC.ui.presets.openSaveForm(initial)`; `MC.ui.composer.insertTemplate(text)` (replace if composer empty else append on new line; focus); settings `defaultPresetId` (null).
- Pending system prompt before the first send: app keeps `state.draft = { systemPrompt, presetId }` applied to the conversation created by `ensureConv()`.
- Chip: rendered by chat at the top of the lane bar / empty state: `📝 <presetLabel>` button or `＋ System prompt` link.

- [ ] **Step 1:** Write failing browser cases: `apply preset to new chat` (apply "Code reviewer" → chip "📝 Code reviewer", composer starts with "Review this code:"; send → every recorded request's `messages[0]` is `{role:'system', content: <code reviewer text>}`); `save current as preset round-trip` (type custom system prompt via chip, pick 2 models, type "Summarize:" in composer → Presets → Save current → name "Mine" → New chat → apply "Mine" → chip "📝 Mine", 2 header chips with same ids, composer "Summarize:"); `edited preset offers update` (apply user preset, edit prompt via chip → chip text ends "(edited)", dialog has "Update preset"; for a built-in only "Save as new"); `default preset applies to new chats`; `presets in export` (Export all JSON contains `"presets"` with "Mine", no built-ins).
- [ ] **Step 2:** `node tests/round-a.pw.js preset` → FAIL.
- [ ] **Step 3:** Implement UI per spec §4 (dialog list: Apply, Edit, Duplicate, Delete; New; Save current as preset; editor fields name/system prompt/template/models via `MC.ui.picker.open({mode:'select'})`; save form with three include checkboxes, requires a name and ≥1 part; mid-chat model confirm via `confirm("Also switch models to …?")`). Header gets a "Presets" button. Settings gets "Default preset for new chats" select (None + all presets). `newChat()` applies the default preset's plan to `state.draft`.
- [ ] **Step 4:** `node tests/round-a.pw.js`, smoke, regressions, `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: presets dialog, save-from-current and system prompt chip`.

### Task 6: Attachment core

**Files:** Create `js/core/attach.js`, `tests/attach.test.js`; Modify `tests/load.js`, `index.html` (script `js/core/attach.js` after `js/core/presets.js`)

**Interfaces:**
- Produces `MC.attach`:
  - `LIMITS = { maxFiles: 10, maxImageBytes: 20971520, maxPdfBytes: 20971520, maxTextBytes: 204800, maxImageSide: 2048 }`.
  - `TEXT_EXT` (spec §5 list). `classify({ name, type }) → 'image'|'pdf'|'text'|null` (images: png/jpeg/webp/gif MIME).
  - `validate(files: {name,type,size}[]) → { ok: true } | { ok: false, error: string }` — messages: `"Up to 10 attachments per message"`, `"<name> is larger than 20 MB"`, `"<name>: unsupported file type"`. Text over 200 KB is valid (truncated later).
  - `textBlock(name, text) → string` (format + truncation from Global Constraints; truncation by UTF-16 length 204800).
  - `toParts(refs, resolve) → part[]` — image → `{type:'image_url', image_url:{url}}`; pdf → `{type:'file', file:{filename:name, file_data:url}}`; text refs skipped; unresolved → `{type:'text', text:'[attachment unavailable: <name>]'}`.
  - `omittedLines(refs) → string` (one `[image omitted: name]` per image, newline-joined).
  - `incapable(lanes, modelsById) → laneId[]` — lanes whose model is missing or `!images`.
  - `pdfEngine(model, pdfMode) → 'native'|'pdf-text'|'mistral-ocr'`.
  - `summaryNote(refs) → string` — e.g. `"[1 image attached] [2 PDFs attached]"`, `''` when none.
  - `buildInputs({ text, refs, textContents: {name: string}, laneIds, incapableIds, choice: 'skip'|'text'|null }) → { inputs: {laneId: string}, delivery: {laneId: 'full'|'text'}, skipped: {laneId: string} }` — body = `text` + `textBlock` per text ref; `skip` removes incapable lanes into `skipped` with `"can't read images"`; `text` gives incapable lanes body + `"\n\n" + omittedLines(refs)` and `delivery 'text'`; others `'full'`. With no image refs, `choice` is ignored and every lane is `'full'`.

- [ ] **Step 1:** Write failing tests covering every function above with the exact strings, including `validate` over 10 files, 21 MB PDF, `.exe`; truncation at 204800 chars; unknown model counted as incapable; `pdfEngine` table (files model → native in both modes; non-files → pdf-text in auto, mistral-ocr in ocr); `buildInputs` skip, text, no-images cases.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: attachment classification, limits and per-lane inputs`.

### Task 7: Storage v2 — attachment records, ref-aware delete, export/import v2

**Files:** Modify `js/core/storage.js`; Test `tests/storage.test.js`

**Interfaces:**
- Produces on every store (`idb`, `local`, `memory`): `putAttachment(record): Promise` (throws on quota), `getAttachment(id)`, `deleteAttachment(id)`, `attachmentsFor(ids): Promise<record[]>` (missing ids skipped), `deleteConversation(id): Promise` (deletes the conversation, then each attachment id referenced by it that no other stored conversation references).
- Produces `MC.storage.refsOf(conv): string[]` (unique attachment ids across turns).
- `exportJson(convs, { attachments = [], presets = [] } = {})` → `{ app, version: 2, exportedAt, conversations, attachments, presets }`.
- `parseImport(text) → { conversations, attachments, presets }` (accepts v1 and v2; throws `Error('Not a Multaichat export')`). `importJson(text, existing)` keeps working (uses `parseImport`).
- IDB `open('multaichat', 2)`; `onupgradeneeded` creates `attachments` only if missing and creates `conversations` only if missing.

- [ ] **Step 1:** Write failing tests (local/memory stores): attachment put/get/attachmentsFor; **`putAttachment surfaces quota`**; `deleteConversation keeps attachments shared with a fork` (conv A and fork B both ref `a1`; delete A → `a1` remains; delete B → gone); `refsOf`; export v2 shape; `parseImport` of v1 export (no attachments/presets → empty arrays) and v2 round-trip.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` PASS.
- [ ] **Step 5:** Add browser case to `tests/round-a.pw.js`: `v1 database upgrades with chats intact` — before loading the app, a page `addInitScript` opens `indexedDB.open('multaichat', 1)`, creates `conversations` + `updatedAt` index and puts two stored v1 conversations (shape from `MC.conv.create` + one finished turn); then load the app → sidebar lists 2 chats; opening one shows its turn; `indexedDB` version is 2 with stores `conversations` and `attachments`. Run → PASS (if it fails, fix the upgrade).
- [ ] **Step 6:** Commit `feat: attachment storage, ref-aware delete, export v2`.

### Task 8: Sending attachments — conversation, API, runner, fusion

**Files:** Modify `js/core/conversation.js`, `js/core/openrouter.js`, `js/core/runner.js`, `js/core/fusion.js`; Tests `tests/conversation.test.js`, `tests/openrouter.test.js`, `tests/runner.test.js`, `tests/fusion.test.js`

**Interfaces:**
- `MC.conv.addTurn(conv, kind, inputs, extra = {})` — `extra = { attachments?: AttachmentRef[], delivery?, skipped? }` stored on the turn when non-empty.
- `MC.conv.attachmentIdsFor(conv, laneId, n): string[]` — image/pdf ref ids in turns `0..n` that the lane received with delivery `'full'`.
- `buildMessages(conv, laneId, n, resolve?)` — for a `'full'` turn with image/pdf refs: `content = [ {type:'text', text: input} (omitted when input is ''), ...MC.attach.toParts(refs, resolve) ]`; otherwise a string. Without `resolve`, parts resolve as unavailable.
- `MC.api.streamChat({ ..., plugins })` / `complete({ ..., plugins })` — include `plugins` in the body only when a non-empty array.
- `createRunner({ ..., loadAttachments: (ids) => Promise<{[id]: dataURL}> = async () => ({}), getModel: (id) => Model|undefined = () => undefined, getPdfMode: () => 'auto'|'ocr' = () => 'auto' })`; `runner.send(conv, kind, inputs, extra)` passes `extra` to `addTurn`. Per lane: load `attachmentIdsFor`, build with resolver, and if any PDF ref is among them pass `plugins: [{ id: 'file-parser', pdf: { engine: MC.attach.pdfEngine(getModel(modelId), getPdfMode()) } }]`.
- `MC.fusion.tldrMessages/fusionMessages` append `MC.attach.summaryNote(turn.attachments || [])` to the question block when non-empty.

- [ ] **Step 1:** Write failing tests: `full turn builds content parts` (image + pdf refs, resolver map → parts in order text, image_url, file); **`empty text with image omits text part`**; `text-delivered turn stays a string`; `history re-sends earlier images` (turn 0 image full, turn 1 text → request for turn 1 has the image part in message 0); `missing record becomes unavailable text`; `attachmentIdsFor ignores text delivery and skipped lanes`; `streamChat forwards plugins` and omits when empty; runner: `pdf adds file-parser plugin with engine per model` (two lanes: one `files` model → native, one not → pdf-text; with `getPdfMode` 'ocr' → mistral-ocr), `skipped lanes get no request`; fusion: `tldr mentions attachments`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` PASS.
- [ ] **Step 5:** Commit `feat: send images, PDFs and text files to models`.

### Task 9: Attachment UI — composer, capability dialog, chat display, settings

**Files:** Create `js/ui/files.js`; Modify `js/ui/composer.js`, `js/ui/chat.js`, `js/ui/settings.js`, `js/ui/sidebar.js` (export with attachments/presets, import via `parseImport`), `js/app.js` (`sendWithAttachments`, runner deps, `deleteConversation` → `store.deleteConversation`), `index.html` (script `js/ui/files.js` before `js/ui/composer.js`; `<dialog id="attach-dialog">`), `styles.css`; Tests `tests/round-a.pw.js`, test files are generated inside `tests/round-a.pw.js` as in-memory buffers passed to `setInputFiles` / clipboard: `tiny.png` (1×1), a 6000×4000 PNG drawn on a canvas, a minimal valid one-page `doc.pdf`, `notes.md`

**Interfaces:**
- `MC.files.read(file: File, limits = MC.attach.LIMITS) → Promise<{ ref: AttachmentRef, record: AttachmentRecord, text?: string }>` — images decoded via `createImageBitmap`/`<img>`, drawn to canvas when longest side > 2048 (or GIF), exported as `image/png` for PNG and GIF input (GIF: first frame), otherwise `image/jpeg` quality 0.85; PDFs/text read with `FileReader`.
- Composer: `MC.ui.composer` gains pending attachments (chips with ✕), 📎 button + hidden `<input type=file multiple>`, drop zone on `#composer` (class `dragging`), paste handler for `image/*` items. `submit()` allows empty text when attachments exist; calls `MC.app.sendWithAttachments(text, pending)` and clears chips only on success.
- `MC.app.sendWithAttachments(text, pending) → Promise<boolean>`: `validate` → read all via `MC.files.read` → if images and `MC.attach.incapable(...)` non-empty and no `conv.attachPolicy` → `MC.ui.composer.askCapability(names) → Promise<'skip'|'text'|null>` (+ remember flag) → `putAttachment` each record (failure → toast "Could not save attachment", return false) → `MC.attach.buildInputs` → `runner.send(conv, 'broadcast'|'targeted', inputs, { attachments, delivery, skipped })`.
- Chat: bubble shows thumbnails (`<img>` from blob URL created from the stored record; max 160 px; click opens full image in new tab) and file chips (click downloads); skipped cell text `— not sent: can't read images`; text-only cells show tag "text only".
- Settings: "PDFs for models without native support" select → `pdfMode`.

- [ ] **Step 1:** Write failing browser cases (mock records request bodies; Claude/GPT/Gemini selected; add `meta-llama/llama-3.3-70b-instruct:free` (text-only) as fourth model where needed): `attach image via button and pdf via paste` → bubble has 1 thumbnail + 1 file chip; Claude request has `image_url` and `file` parts and `plugins[0].pdf.engine === 'native'`; GPT (images, no files) request has `engine 'pdf-text'`; `capability dialog skip` → llama cell shows "not sent: can't read images" and no llama request; `capability dialog text only` → llama request content is a string containing `[image omitted: tiny.png]`, cell tagged "text only"; `remember for this chat` → second send asks nothing; `cancel keeps composer`; `text file inlined` (notes.md → every request text contains `--- file: notes.md ---`); `attachments survive reload` (thumbnail visible after reload; Retry on Claude re-sends the image part); **`downscales large image`** (6000×4000 canvas PNG blob → request image data URL decodes to width ≤ 2048); **`attachment save failure keeps composer`** (stub `MC.app.state.store.putAttachment` to reject → toast, no request, chip and text remain); `ocr setting` (pdfMode ocr → GPT engine `mistral-ocr`); `export includes attachments and import restores them`.
- [ ] **Step 2:** `node tests/round-a.pw.js attach` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** All suites PASS: `npm test`, `node tests/smoke.pw.js`, `node tests/regressions.pw.js`, `node tests/round-a.pw.js`.
- [ ] **Step 5:** Commit `feat: attach images, PDFs and files from the composer`.

### Task 10: Production check, README

**Files:** Create `scripts/check.js`; Modify `package.json` (`"check": "node scripts/check.js"`, `"smoke"` adds `&& node tests/round-a.pw.js`), `README.md`

**Interfaces:**
- `scripts/check.js`: (1) parse `index.html` `src`/`href` attributes (skip `data:` and `https://openrouter.ai`/`https://` external links in `<a>`): each must be relative (no leading `/`, no protocol) and the file must exist; (2) start the shared static server mounted at `/Multaichat/` and load `/Multaichat/` and `file://…/index.html` in Chromium with the OpenRouter mock: zero `pageerror`/console errors and `window.MC.app.state` defined; (3) assert every `js/**/*.js` file is referenced by exactly one `<script>` tag and `js/app.js` is last; (4) run `npm test`, `node tests/smoke.pw.js`, `node tests/regressions.pw.js`, `node tests/round-a.pw.js` and exit non-zero on any failure. Prints one `ok - …` / `not ok - …` line per check.
- `serve()` in `tests/pw-helpers.js` gains an optional `mount` prefix (default `''`).

- [ ] **Step 1:** Write `scripts/check.js`; temporarily break a script path in a scratch copy check (run with an env `CHECK_ROOT` pointing at a temp copy whose `index.html` references `js/missing.js`) → expect `not ok - assets`. Then run on the real repo.
- [ ] **Step 2:** Run `npm run check` → every line `ok`, exit 0.
- [ ] **Step 3:** README: Presets (incl. save from current), system prompt chip, attachments (types, limits, ask-each-time, PDF modes, privacy: files stay in this browser and are sent only to OpenRouter), picker filters, `npm run check`.
- [ ] **Step 4:** Commit `chore: production check script; docs: Round A features`.
