# Multaichat Round A — Presets, Attachments, Model Filters — Design Spec

Date: 2026-10-27
Status: Draft for review
Builds on: `docs/superpowers/specs/2026-10-25-multaichat-design.md` (v1, in production on `main`)
Branch: `ccr-b9b47502-ukojr7` (feature branch; `main` is never modified without explicit approval)

## 1. Purpose and scope

Three additions to the existing app:

1. **Model filters** in the picker: max input price, max output price, min
   context length, supports images, supports files.
2. **Presets**: named bundles of an optional system prompt, message template
   and model set.
3. **Attachments**: images, PDFs and text/code files on messages.

Round B (decision-model router) is out of scope; Round A must expose model
input modalities so Round B can route around attachments.

### Success criteria

- Picker filters narrow every section and search results, persist across
  visits, and show 🖼/📄 capability badges.
- Applying a preset to a new chat sets models, system prompt and composer
  template; the system prompt reaches every model's request.
- Images, PDFs and text files can be attached by 📎, drag-and-drop or paste;
  they are sent in OpenRouter's formats, survive reload, retry and fork.
- When a selected model cannot read an attached image the user is asked to
  skip it, send text only, or cancel.
- Existing chats from v1 (IndexedDB version 1) load unchanged after upgrade.
- `npm run check` passes: production asset/path check, unit, browser flow and
  regression suites.

### Non-goals (YAGNI)

- No audio/video attachments; no attachments in inline replies or the
  "Answer them together" panel.
- No per-lane system prompts (one per chat).
- No preset sharing beyond Export/Import.
- No changes to TL;DR/Fusion beyond an "[n image(s) attached]" note.

## 2. Constraints (unchanged from v1)

Vanilla JS, classic `<script>` tags on `window.MC`, no build step, no npm
dependencies, must work from `file://` and GitHub Pages under `/Multaichat/`.
Core logic stays DOM-free and Node-tested. Untrusted text never reaches
`innerHTML` except through `MC.md.render`.

## 3. Model capabilities and filters

### Data

`MC.models.normalize` adds to each `Model`:

- `inputs: string[]` — `architecture.input_modalities`, default `['text']`.
- `images: boolean` — `inputs` includes `image`.
- `files: boolean` — `inputs` includes `file`.

### Filtering

`MC.models.filter(models, f)` accepts, in addition to the v1 fields:

| field | meaning |
|---|---|
| `maxIn` | `priceIn <= maxIn` (USD per million; models with unknown price excluded when set) |
| `maxOut` | `priceOut <= maxOut` (replaces v1 `maxPrice`; `maxPrice` kept as an alias) |
| `minContext` | `context >= minContext` |
| `images` | only models with `images` |
| `files` | only models with `files` |

Empty string / null / `false` means "not set".

### Picker UI

- A compact filter bar under the search box: `Max in $/M`, `Max out $/M`
  (number inputs), `Min context` (select: Any, 32k, 128k, 200k, 1M),
  `☐ 🖼 Images`, `☐ 📄 Files`, and "Clear filters". A "Filters (n)" label
  shows how many are active.
- Filters apply to **all** sections (Top picks, Free, Open-weight, All models)
  and to search results. Sections are computed first, then filtered, so
  "Top picks" may shrink rather than pick a different model.
- The v1 "All models" toolbar keeps sort, free-only and open-only; its
  "Max $/M out" input moves to the shared filter bar.
- Persisted in settings as `pickerFilters: {maxIn, maxOut, minContext, images, files}`.
- Model rows show 🖼 when `images`, 📄 when `files`.
- Quick-add ("+ Add model") also respects the saved filters.

## 4. Presets and system prompts

### Data

```js
Preset { id, name, systemPrompt?: string, template?: string, models?: string[], builtIn?: boolean }
```

- Stored in localStorage `mc.presets` (array). Corrupt/missing → built-ins only.
- Built-ins (cannot be deleted; can be duplicated, and duplicates edited):
  - **Concise expert** — system: "You are a concise expert. Answer directly, use short paragraphs or bullets, and state uncertainty briefly."
  - **Code reviewer** — system: "You are a meticulous senior code reviewer. Point out bugs, security issues and unclear code, citing the exact lines. Suggest concrete fixes." template: "Review this code:\n\n"
  - **Explain simply** — system: "Explain like you are talking to a curious 12-year-old. Use plain words and one everyday analogy."
- Export includes user presets (`presets` field); Import merges by id
  (incoming wins on same id). Built-ins are never exported.

`Conversation` gains:

- `systemPrompt?: string` — current instructions for this chat.
- `presetId?: string` — for display only.
- `systemPromptFromTurn?: number` — index of the first turn the current
  prompt applies to (0 when set before any turn).
- `systemPromptHistory?: {fromTurn, text}[]` — earlier prompts, so rebuilt
  history for earlier turns uses the prompt that was in force then.

### Message building

`MC.conv.buildMessages(conv, laneId, n)` emits, in order:

1. `system`: the system prompt in force at turn `n` (if any).
2. `system`: the lane's late-joiner `seedContext` (v1 behaviour).
3. the lane's history and turn `n` input (v1 behaviour, plus attachments, §5).

Only one system prompt is sent per request: the one in force at turn `n`.
Fork copies `systemPrompt`, `presetId` and history.

### UI

- Header button **Presets** opens a dialog listing presets with Apply,
  Edit, Duplicate, Delete, "＋ New preset" and **Save current as preset**.
- **Save current as preset** captures the current customizations into a
  pre-filled save form: name (empty, required), ☑ system prompt (the chat's
  current `systemPrompt`, preset-derived or typed), ☑ models (the chat's
  active lanes, or the current selection when no chat exists), ☑ template
  (the composer's current text, if non-empty). Each part can be unticked or
  edited before saving; at least one part must be kept.
- The system-prompt dialog (opened from the 📝 chip) also has
  **Save as preset**, opening the same form.
- **Edited presets:** when the chat's `systemPrompt` differs from its
  `presetId` preset's prompt, the chip reads "📝 <name> (edited)" and its
  dialog offers **Update preset** (user presets only: overwrite that preset's
  system prompt) and **Save as new**. Built-ins only offer Save as new.
- `MC.presets.fromCurrent({systemPrompt, models, template})` (pure) builds the
  form's initial values; `isEdited(conv, preset)` (pure) drives the chip.
- Preset editor: name, system prompt (textarea), template (textarea), models
  (opens the existing picker in select mode).
- **Apply to a new/empty chat:** sets selected models (if the preset has
  any), sets `systemPrompt`/`presetId`, inserts `template` into the composer
  (replacing an empty composer, otherwise appended on a new line), focuses it.
- **Apply mid-chat:** sets the system prompt from the next turn on; if the
  preset has models that differ from the active lanes, confirm
  "Also switch models to …?" (yes → same diff as the picker).
- A chip above the lanes / empty state: "📝 <preset name or 'Custom'>"; click
  to edit this chat's system prompt (textarea dialog; "Clear" removes it).
  No chip when there is no system prompt; instead a subtle "＋ System prompt" link.
- Settings gains **Default preset for new chats** (none by default).

## 5. Attachments

### Kinds and limits

| kind | detected by | limit | sent as |
|---|---|---|---|
| image | `image/png, image/jpeg, image/webp, image/gif` | 20 MB input; downscaled to max 2048 px longest side (JPEG q0.85, PNG kept for PNG input ≤ 2048 px or with transparency; GIF sent as first frame PNG) | `{type:'image_url', image_url:{url:<data URL>}}` |
| pdf | `application/pdf` | 20 MB | `{type:'file', file:{filename, file_data:<data URL>}}` |
| text | `text/*`, or extension in `txt md csv tsv json xml yaml yml html css js ts jsx tsx py java c cpp h cs go rs rb php sh sql toml ini log` | 200 KB; longer is truncated with "\n…[truncated at 200 KB]" | appended to the user text as `\n\n--- file: <name> ---\n<content>\n--- end of <name> ---` |

Max 10 attachments per message. Other types are rejected with a toast.

### PDF engine

Request body gains `plugins: [{ id: 'file-parser', pdf: { engine } }]` when a
message in the request contains a PDF:

- Setting `pdfMode`: `'auto'` (default) or `'ocr'`.
- `auto`: engine `native` if the lane's model has `files`, else `pdf-text`.
- `ocr`: engine `native` if the lane's model has `files`, else `mistral-ocr`.

### Capability check (images only)

Before sending a message with images, the app computes
`MC.attach.incapable(lanes, models)` = active target lanes whose model is
unknown or lacks `images`. If non-empty and the chat has no remembered
choice, a dialog lists them with **Skip them**, **Send text only**,
**Cancel**, and "☐ Remember for this chat" (stored as
`conv.attachPolicy: 'skip'|'text'`).

- **Skip** — those lanes are left out of the turn's `inputs`; the turn
  records `skipped: {[laneId]: "can't read images"}`; the cell shows
  "— not sent: can't read images".
- **Send text only** — those lanes receive the text (with text-file
  contents) and, in place of each image, the line `[image omitted: <name>]`;
  recorded in `turn.delivery[laneId] = 'text'`.
- **Cancel** — nothing is sent; composer text and attachments stay.

### Data model

New IndexedDB object store `attachments` (keyPath `id`) — DB version 2;
upgrade from v1 only adds the store (existing `conversations` untouched).
The localStorage fallback keeps attachments in `mc.attachments` (subject to
quota; failure toasts "Could not save attachment").

```js
AttachmentRecord { id, kind: 'image'|'pdf'|'text', name, mime, size, data /* data URL, or text for kind text */, width?, height?, createdAt }
AttachmentRef    { id, kind, name, mime, size, width?, height? }
```

`Turn` gains:

- `attachments?: AttachmentRef[]`
- `delivery?: {[laneId]: 'full'|'text'}` (absent lane = not asked or skipped)
- `skipped?: {[laneId]: string}`

Text attachments are also stored as records (for display/download) but their
content is already part of `inputs[laneId]`, so `buildMessages` needs no blob
for them.

### Sending

- `MC.conv.buildMessages` stays pure. It takes an optional
  `resolve(id) -> dataURL|null` callback; for each turn the lane received in
  `full`, the user message becomes a content array:
  `[{type:'text', text}, ...image parts, ...pdf parts]`. Turns delivered as
  `text` (or without attachments) remain plain strings. Earlier images in
  the lane's history are re-sent (so models keep seeing them). A missing
  record resolves to the text `[attachment unavailable: <name>]`.
- `MC.runner` loads the records needed for a lane's request from the store
  before calling `streamChat`, and passes `plugins` when a PDF part is
  present (engine per §5 PDF engine). `MC.api.streamChat` accepts
  `plugins` and forwards it in the body.
- TL;DR and Fusion prompts use the text input plus "[n image(s) attached]"
  / "[n PDF(s) attached]".

### Lifecycle

- Attachments are written to the store when the turn is created (before the
  first request). Retry reuses refs. Fork copies refs (no copy of data).
- Deleting a conversation deletes each referenced attachment unless another
  stored conversation references it (`MC.storage` scans refs).
- Export: `exportJson(convs, {attachments, presets})` adds an
  `attachments` array of records referenced by the exported chats and the
  user `presets`. Import writes both. Version field becomes `2`; v1 exports
  still import.

### UI

- Composer: 📎 button (hidden file input, `multiple`), drag-and-drop onto the
  composer (highlight while dragging), paste of image clipboard items. Chips
  above the textarea: thumbnail (images) or 📄 name · size, ✕ to remove.
  Sending with attachments and empty text is allowed.
- Turn bubble: thumbnails (max 160 px) open the full image in a new tab via a
  blob URL; file chips download the file. Per-lane delivery is visible:
  skipped cells say "— not sent: can't read images"; text-only cells show
  a small "text only" tag.
- Settings: **PDFs for models without native support**: "Free text
  extraction (pdf-text)" / "OCR for scanned PDFs (mistral-ocr, paid)".

### Errors

- Read/downscale failure, over-limit size, unsupported type, >10 files →
  toast; nothing sent; composer content kept.
- Storage failure when writing attachments → toast "Could not save
  attachment"; nothing sent.
- Provider rejects an attachment → that lane errors as in v1 (Retry offered).

## 6. Module changes

| file | change |
|---|---|
| `js/core/models.js` | `inputs/images/files` in `normalize`; `filter` new fields |
| `js/core/presets.js` (new) | `MC.presets`: built-ins, `createPresetStore(ls)` → `{list, get, save, remove, duplicate}`, `applyPlan(preset, conv)`, `fromCurrent(...)`, `isEdited(conv, preset)` (pure) |
| `js/core/attach.js` (new) | `MC.attach`: `classify(file)`, `limits`, `textBlock(name, text)`, `toParts(refs, resolve)`, `incapable(lanes, modelsById)`, `pdfEngine(model, pdfMode)`, `summaryNote(refs)` (pure) |
| `js/ui/files.js` (new) | browser-only: read `File` → data URL/text, image downscale via canvas |
| `js/core/conversation.js` | system prompt fields + history; `buildMessages` system prompt + attachments; `addTurn` accepts `{attachments, delivery, skipped}`; fork copies new fields |
| `js/core/storage.js` | DB v2 with `attachments` store; `store.putAttachment/getAttachment/deleteAttachment/attachmentsFor(ids)`; ref-aware conversation delete; export/import v2 |
| `js/core/openrouter.js` | `streamChat`/`complete` accept `plugins` |
| `js/core/runner.js` | resolve attachments before each lane request; plugins; `send(conv, kind, inputs, extra)` |
| `js/core/fusion.js` | attachment note in TL;DR/Fusion prompts |
| `js/ui/picker.js` | filter bar, badges, quick-add respects filters |
| `js/ui/presets.js` (new) | presets dialog + editor, system-prompt chip/dialog |
| `js/ui/composer.js` | 📎, drop, paste, chips, capability dialog, template insert |
| `js/ui/chat.js` | bubble thumbnails/files, skipped / text-only cell states, system prompt chip |
| `js/ui/settings.js` | default preset, PDF mode |
| `js/app.js` | wiring: presets, attachments on send, export/import v2 |
| `index.html` | new script tags, `presets-dialog`, `attach-dialog` |
| `styles.css` | filter bar, chips, thumbnails, dialogs |
| `scripts/check.js` (new) | production asset/path check |
| `package.json` | `check` script |
| `README.md` | features, privacy note about attachments |

## 7. Testing and production check

- Existing: 102 unit tests, `tests/smoke.pw.js` (file:// + http), 9 browser
  regressions — must stay green after every task.
- New unit tests: filters (each field, combined with search tokens, unknown
  price), presets (store CRUD, corrupt storage, built-ins undeletable,
  apply plan new vs mid-chat, `fromCurrent` with/without composer text and chat, `isEdited`), system prompt in `buildMessages` (ordering
  with seed context, history per turn, fork), attachments (classify,
  limits, text block & truncation, parts per kind, delivery full/text/skip,
  re-send in history, missing record, pdf engine per mode/model, incapable
  lanes incl. unknown model), storage (v2 store, ref-aware delete, export /
  import v2 round-trip, v1 export import), `streamChat` forwards `plugins`.
- New browser tests (mocked OpenRouter records request bodies): "Save current as preset" round-trip (customize → save → new chat → apply → same prompt, models, template); preset apply
  sets chip/models/template and the system message reaches requests; image
  + PDF attach via 📎 and paste; capability dialog Skip and Text-only produce
  the right cells and request bodies; attachments survive reload; filters
  narrow the picker and persist; **v1 → v2 upgrade**: a page seeded with a
  version-1 IndexedDB containing chats loads them all after upgrade.
- `npm run check` (new): verifies every `src`/`href` in `index.html` is
  relative and exists, loads the page from `file://` and from an http server
  mounted under `/Multaichat/` with zero console errors, then runs
  `npm test`, `tests/smoke.pw.js` and `tests/regressions.pw.js`.

## 8. Process

All commits go to `ccr-b9b47502-ukojr7`. No changes to `main`, no merge,
deploy or pull request without explicit approval.
