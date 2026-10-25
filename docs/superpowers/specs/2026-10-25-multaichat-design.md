# Multaichat — Design Spec

Date: 2026-10-25
Status: Draft for review

## 1. Purpose

A personal, vanilla-JavaScript web app that sends one prompt to several
OpenRouter models at once, shows their answers side by side, and helps the user
make sense of them via TL;DR summaries and a topic-grouped "Fusion" view
(similar to OpenRouter Fusion Labs).

### Success criteria

- Paste an OpenRouter API key once; it is remembered on that device.
- Pick 2–5 models from an always-current list with sensible recommendations.
- Ask a question; answers stream in parallel, one column per model.
- Reply to everyone, to one model, or answer several models' clarifying
  questions differently in one step.
- Generate a TL;DR (summary model) and a Fusion view (fusion model) per turn.
- Reload the page: conversations are still there. Nothing is stored in the repo
  or on any server other than OpenRouter.
- Works both from GitHub Pages and by opening `index.html` from disk (`file://`).

### Non-goals (YAGNI)

- No backend, accounts, or cross-device sync (export/import JSON covers backup).
- No in-place message version trees (only per-answer retry history).
- No image/file uploads, tools/function calling, or system-prompt presets in v1.

## 2. Constraints

- **Vanilla JS, no build step.** Classic `<script>` tags (not ES modules,
  because Chrome blocks module scripts on `file://`). All code hangs off one
  global namespace `window.MC`.
- **Client-only.** Browser calls `https://openrouter.ai/api/v1` directly.
- **Local storage only.** IndexedDB for conversations, localStorage for key and
  settings. On `file://`, storage is scoped to that file path; GitHub Pages has
  its own separate storage. This is expected and noted in the UI's About text.

## 3. Architecture

```
index.html
styles.css
js/
  core/util.js        MC.util     — ids, escapeHtml, debounce, formatCost
  core/storage.js     MC.storage  — settings (localStorage), conversations (IndexedDB)
  core/openrouter.js  MC.api      — fetchModels(), streamChat(), complete()
  core/models.js      MC.models   — cache, recommend(), filter/search (pure)
  core/conversation.js MC.conv    — data model ops: lanes, turns, fork, thread building (pure)
  core/clarify.js     MC.clarify  — detect clarifying questions (pure)
  core/fusion.js      MC.fusion   — TL;DR + Fusion prompt building and JSON parsing (pure)
  ui/markdown.js      MC.md       — small safe Markdown renderer (escape first, then format)
  ui/picker.js        model picker dialog
  ui/sidebar.js       conversation list, fork nesting, rename/delete/export/import
  ui/chat.js          turn/column rendering, per-column reply boxes, badges
  ui/composer.js      bottom composer, target chip, "Answer together" panel
  ui/settings.js      API key, summary/fusion model, auto-run toggles
  app.js              wiring + startup
tests/                node --test unit tests for core/*
```

Each `core/*` file is pure or I/O-isolated, written so it works both in the
browser (attaches to `window.MC`) and in Node (`module.exports`) for tests via a
tiny UMD-style footer. UI files depend on `core`, never the other way around.

Load order in `index.html`: util → storage → openrouter → models →
conversation → clarify → fusion → markdown → ui/* → app.

## 4. Data model

```js
Conversation {
  id, title, createdAt, updatedAt,
  parentId?: string, forkedAtTurn?: number,   // fork lineage for sidebar nesting
  lanes: Lane[],
  turns: Turn[]
}
Lane {
  id, modelId, modelName,
  active: boolean,             // removed models stop receiving messages
  joinedAtTurn: number,        // lanes added mid-chat
  seedContext?: string         // condensed context given to late joiners
}
Turn {
  id, index, createdAt,
  kind: 'broadcast' | 'targeted' | 'clarify-batch',
  inputs: { [laneId]: string },        // what each lane was sent this turn
  responses: { [laneId]: Response },   // absent lane => "not asked this turn"
  tldr?: Derived, fusion?: Derived
}
Response {
  status: 'streaming'|'done'|'error'|'stopped',
  content: string, error?: string,
  usage?: { promptTokens, completionTokens, cost },
  asksQuestion: boolean, question?: string,
  previous: { content, usage, createdAt }[]   // retry history
}
Derived { modelId, status, content | data, error?, createdAt }
```

A broadcast turn simply has the same input string for every active lane; a
clarify batch has different inputs per lane. This uniform `inputs` map is what
makes "answer each model differently" a normal turn, not a special case.

**Thread building** (`MC.conv.buildMessages(conv, laneId, uptoTurnIndex)`):
for each turn where `inputs[laneId]` exists, emit `{role:'user', content:input}`
and, if a `done`/`stopped` response exists, `{role:'assistant', content}`.
Lanes that joined late get `seedContext` as a leading `system` message.
Turns where the lane wasn't asked are skipped entirely.

## 5. Model picker

- `GET /api/v1/models` (no key required). Cache `{fetchedAt, models}` in
  localStorage; refresh if older than 24 h or on 🔄 click. Offline/failure falls
  back to the cached copy, then to a tiny built-in fallback list.
- Only text-output models are listed
  (`architecture.output_modalities` includes `text`).
- **Recommended** (`MC.models.recommend(models)`), rule-based, no hardcoded IDs:
  for each provider prefix in
  `anthropic, openai, google, x-ai, deepseek, meta-llama, mistralai, qwen`
  pick the newest model by `created`, excluding ids containing `:free`,
  `preview`, `beta`, `-exp`, `:extended`, `audio`, `image`, `embed`, and models
  with `context_length < 32000`. Result is ordered by provider list.
- Full list: search by name/id, filters "free only", "max $/M tokens",
  sort by newest / price / context. Each row shows provider, context length,
  input/output price per million tokens.
- Selection (ordered list of model ids), summary model, and fusion model persist
  in settings. First-run defaults: first 3 recommended models; summary model =
  cheapest recommended; fusion model = first recommended.

## 6. Sending and streaming

- `MC.api.streamChat({key, model, messages, signal, onDelta, onDone, onError})`
  → `POST /api/v1/chat/completions` with `stream: true`,
  `usage: {include: true}`, headers `Authorization: Bearer <key>`,
  `HTTP-Referer: location.origin` (omitted on `file://`), `X-Title: Multaichat`.
- SSE parser: buffer by line; ignore comment lines (`: OPENROUTER PROCESSING`);
  `data: [DONE]` ends; each `data:` JSON yields `choices[0].delta.content`;
  final chunk's `usage` (tokens, `cost`) is stored.
  Mid-stream `error` objects become a column error.
- All targeted lanes stream in parallel, each with its own `AbortController`
  (per-column ■ Stop, plus global Stop all).
- Errors are isolated per column (401 → "check API key" with link to settings;
  402 → "out of credits"; 429 → "rate limited, retry"; network → retry button).
- Conversation is saved to IndexedDB on turn creation, on each response
  completion, and throttled (≤1/s) during streaming.

## 7. Interaction model (answering and branching)

**Default: the bottom composer sends to all active lanes.** Enter sends,
Shift+Enter newline.

**Reply to one model:**
- Each answer has **↳ Reply**. Clicking it sets the composer target chip
  "↳ to <Model> only ✕". The chip clears after sending (never sticky).
- When an answer asks a question (see below), the column shows a
  **❓ asked you something** badge and an inline reply box directly under the
  answer. Enter there sends a targeted turn to that lane only.
- Alt+1…9 focuses lane N's reply box.

**Clarification detection** (`MC.clarify.detect(text)` → `{asks, question}`):
look at the last non-empty paragraph (or last 3 lines if list-like). `asks` is
true if it contains `?` outside code blocks, or matches phrases like
"could you clarify", "let me know", "do you want", "would you like",
"can you tell me", "please specify". `question` = the sentence(s) containing it.
Heuristic only; it drives badges, never blocks anything.

**Answer together:** when ≥2 lanes in the latest turn ask questions, a banner
"N models asked you questions — Answer them together" appears. The panel lists
each asking lane with its extracted question and its own textarea, a
"same answer for all" checkbox (mirrors first box into all), and
"☐ also send to models that didn't ask" (sends a combined
"Answers to other models' questions: …" text to those lanes). Send creates one
`clarify-batch` turn. Tab moves between boxes; Ctrl/Cmd+Enter sends.

**Not asked this turn:** columns absent from a turn render a faint
"— not asked this turn" row so alignment and "who saw what" stay clear.

**Retry:** ↻ on one answer regenerates that lane's response with the same
thread; old content moves to `previous[]`, viewable via "previous (n)".

**Fork:** ⑂ on a turn creates a new conversation copying all lanes and turns
up to and including that turn (`parentId`, `forkedAtTurn` set; derived TL;DR
and Fusion copied). Sidebar nests forks under their parent.
**Continue with just this model:** same, but keeps only that lane.

**Add/remove models mid-chat:** removing sets `active=false` (history stays).
Adding creates a lane with `joinedAtTurn` = next turn and `seedContext` =
concatenated per-turn TL;DRs, or if none, the prior user inputs; the column
header shows "joined at turn N with summary context".

**Mobile (<800px):** lanes become swipeable tabs with unread dot and ❓ badge;
inline reply box and Answer-together panel work the same.

## 8. TL;DR and Fusion

Both run per turn via buttons under the turn ("TL;DR", "Fusion"), with optional
"auto-run after all answers finish" toggles in settings. TL;DR streams via
`MC.api.streamChat()`; Fusion uses non-streaming `MC.api.complete()` (it must
be parsed as a whole). Results are saved into
`turn.tldr` / `turn.fusion`. Regenerate replaces. Only `done`/`stopped`
responses are used; TL;DR needs ≥1, Fusion needs ≥2.

**TL;DR prompt:** system: "Summarize these answers to the user's question in
3–6 bullet points. Note where models disagree. Be terse." User content: the
question(s) for this turn and each answer labelled with its model name.

**Fusion prompt:** asks the fusion model to return **only** JSON:

```json
{
  "overview": "1–3 sentence synthesis",
  "topics": [
    {
      "title": "Topic heading",
      "merged": "Markdown synthesis of what models said on this topic",
      "models": ["<model id>", "..."],
      "excerpts": [{ "model": "<model id>", "quote": "verbatim text" }]
    }
  ],
  "disagreements": [
    { "point": "...", "positions": [{ "model": "<model id>", "position": "..." }] }
  ],
  "unique": [{ "model": "<model id>", "point": "only this model mentioned..." }]
}
```

- Request with `response_format: {type: "json_object"}`; if the provider rejects
  it (400), retry once without it.
- `MC.fusion.parse(text, laneModelIds)`: strip code fences, take the outermost
  `{…}`, `JSON.parse`, validate shape, drop unknown model ids, and mark each
  excerpt `verified` if its quote (whitespace-normalised) is a substring of
  that model's answer. Parse failure → show raw text with "couldn't structure
  this — Regenerate".
- **Rendering:** overview, then each topic as a card: title, merged Markdown,
  model chips (who agrees), and a collapsed "Show sources (n)" that expands to
  side-by-side excerpts per model (unverified ones marked "paraphrased").
  Then Disagreements and Unique points sections.

## 9. Settings and API key

- Settings dialog: API key (password field, show/hide, "Test key" calls
  `GET /api/v1/key`), "Remember on this device" (default on; off = memory only
  for the session), summary model, fusion model, auto-run toggles, theme
  (system/light/dark), "Clear all local data".
- First run with no key shows a friendly inline card with a link to
  openrouter.ai/keys and a note that the key is stored only in this browser.
- Key is stored in localStorage in plain text (documented); never logged,
  never included in exports.

## 10. Conversations (sidebar)

- List sorted by `updatedAt`, forks nested. Title auto-set from the first
  prompt (first 60 chars); double-click to rename. Delete with confirm.
- Search by title. New chat button keeps the current model selection.
- Export current / all as JSON; import merges by id (newer `updatedAt` wins).

## 11. Rendering and safety

- Markdown renderer escapes HTML first, then applies headings, bold/italic,
  inline code, fenced code blocks (with copy button), lists, links
  (`http(s)` only, `rel="noopener noreferrer" target="_blank"`), tables.
  No raw HTML ever reaches `innerHTML` unescaped.
- Copy buttons per answer, per TL;DR and Fusion.
- CSS uses custom properties with light/dark themes; layout is a CSS grid of
  lanes (min 280px each, horizontal scroll if many).

## 12. Testing

- `node --test tests/` covering pure core modules:
  - `models.recommend` / filter / sort with fixture model lists
  - `conversation.buildMessages` for broadcast, targeted, clarify-batch,
    late-joining lanes, fork and continue-with-one
  - `clarify.detect` positive/negative cases (code blocks with `?`, rhetorical
    mid-text questions, trailing "Let me know if…")
  - `fusion.parse` with fenced JSON, extra prose, invalid JSON, unknown model ids,
    excerpt verification
  - SSE line parser with comment lines, split chunks, `[DONE]`, error chunks
  - `md.render` escaping (XSS cases)
- Manual browser smoke test checklist (in README): file:// and served over HTTP,
  streaming, stop, error columns, fork, answer-together, reload persistence.
- A Playwright smoke script with a mocked OpenRouter (route interception) to
  verify the page loads, renders columns, and persists across reload.

## 13. Deliverables

- App files listed in §3, `README.md` (usage, GitHub Pages setup, privacy
  notes), `package.json` with only a `test` script (no dependencies).
