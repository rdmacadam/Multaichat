# Multaichat Round B — Decision-Model Router and Chat Cost Counter — Design Spec

Date: 2026-10-27
Status: Draft for review
Builds on: `docs/superpowers/specs/2026-10-25-multaichat-design.md` (v1, on `main`)
and `docs/superpowers/specs/2026-10-27-round-a-presets-attachments-filters-design.md`
(Round A, branch `ccr-b9b47502-ukojr7`, not merged)
Branch: `round-b-router`, created from `ccr-b9b47502-ukojr7`. `main` is never
modified; no merge, deploy or pull request without explicit approval.

## 1. Purpose and scope

Two additions:

1. **Chat cost counter** — a toolbar display of everything the open chat has
   cost so far.
2. **Model router** — before a message is sent to all models, a *decision
   model* chooses which models answer it. Six modes: Full auto, Best free,
   Diverse perspectives, Very best answer, Full manual, OpenRouter native.

### Success criteria

- The toolbar shows `Σ $x` for the open chat. It includes answers, earlier
  (retried) versions, router decisions, TL;DR, Fusion and the judge, updates
  live, and survives reload, fork and export.
- With the router on, a message to all models is routed to N models
  (N set by hand, 1–8) chosen from the whole filtered catalog or from the
  current selection, by a decision model the user picks.
- A message with images is never routed to a model that cannot read images;
  the picker filters (Round A) always apply to the candidate pool.
- Every routed turn shows who decided, the task type, the picks with their
  probabilities, the decision cost and any fallback taken.
- Every router option has an ⓘ explanation that appears on long hover, on
  keyboard focus and on tap.
- Routing works when the decision model fails, is rate-limited, or (Best
  free) when no free decision model exists.
- `npm run check` passes, including a new Round B browser suite.

### Non-goals (YAGNI)

- No panel/vote of several decision models — one decision model per message,
  with fallbacks.
- No per-chat router settings — router settings are global.
- No routing for ↳ Reply, inline reply boxes or "Answer them together"; they
  keep going to the models the user addresses.
- No PDFs, audio or video sent to decision models (PDFs are mentioned as a
  note).
- Chat models are never used as decision models; decision models are never
  offered as chat models.
- No trained/learned routers.

## 2. Research summary (what was borrowed)

| Source | Borrowed |
|---|---|
| RouteLLM (lm-sys/RouteLLM) | Routing decision isolated in one pure function; a cost/quality goal per mode. |
| OpenRouter Auto Router (`openrouter/auto`) | Used directly as the "OpenRouter native" mode: `plugins:[{id:'auto-router', allowed_models}]`, `session_id`, served model read from the response `model` field. |
| Arch-Router (Katanemo) | Decision by a model reading human-written descriptions of each candidate; adding models needs no retraining. |
| LiteLLM complexity router | A deterministic rule-based fallback ranking when the decision fails. |
| vLLM Semantic Router | A task category in the decision output (code, math, …). |
| Mixture-of-Agents (togethercomputer/moa) | Diverse providers give better combined answers; the existing Fusion acts as aggregator in "Very best answer". |
| RouterBench (withmartian) | Always record what was chosen, why, and what it cost. |

## 3. Constraints (unchanged)

Vanilla JS, classic `<script>` tags on `window.MC`, no build step, no npm
dependencies, works from `file://` and GitHub Pages under `/Multaichat/`.
`js/core/*` stays DOM-free and Node-tested. Untrusted text never reaches
`innerHTML` except through `MC.md.render`.

## 4. OpenRouter decision models

### Catalog

- Decision models are listed by `GET /api/v1/models?output_modalities=decisions`
  (the default `/models` list omits them). 32 exist on 2026-10-27.
- Cached in localStorage `mc.decidersCache` for 24 h, like the chat model
  cache; refreshed together with it (🔄 in the picker). Failure → stale cache
  → empty list (the router then uses rule ranking and says so).
- `MC.models.normalizeDeciders(raw)` →
  `Decider { id, name, provider, priceIn, context, inputs, images, files, free, desc }`
  where `desc` is the first sentence of `description` (≤ 160 chars) and
  `free` = id ends `:free` or input price 0.
- Decision models never appear in the chat model picker or quick-add.

### Calling them

- `MC.api.decide({ key, model, state, questions, signal })` →
  `POST https://openrouter.ai/api/alpha/decisions` (the documented endpoint);
  on HTTP 404 it retries once at `POST https://openrouter.ai/api/v1/systemone`
  (same wire format). Headers
  as for chat (`Authorization`, `X-Title`, `HTTP-Referer` when served over
  http(s)). CORS allows browser calls (verified by preflight).
- Body: `{ model, state, questions }`. `state` is an array of strings and
  `{type:'image_url', image_url:{url:<data URL>}}` parts.
- Returns `{ model, answers, usage: { inputTokens, cost } }`. Error responses
  become `ApiError` like chat errors.
- A `choice` question has `instructions` and `criteria: {label: guidance}`;
  its answer has `choice`, optional `confidence` and optional
  `probabilities: {label: number}`.

### Starred decision models (defaults)

`settings.starredDeciders` defaults to, in this order:

1. `liquid/d1-ultra`
2. `typesafe/jev-1.14`
3. `inception/mercury-decide`
4. `perplexity/pplx-decider-v1.2`
5. `baseten/mammoth-1:free`
6. `baseten/elephant-1:free`

Users can star/unstar any decision model. Starred models that are not in the
current catalog are shown greyed ("not available right now") and skipped.

- **Default decision model:** `perplexity/pplx-decider-v1.2`.
- **Default free decision model (Best free):** `baseten/mammoth-1:free`.

## 5. Routing

### 5.1 Settings

```js
settings.router = {
  enabled: false,
  mode: 'auto',            // 'auto' | 'free' | 'diverse' | 'best' | 'manual' | 'native'
  count: 3,                // 1..8; forced to 1 in 'native'
  pool: 'catalog',         // 'catalog' | 'selection'
  decisionModel: 'perplexity/pplx-decider-v1.2',
  manualPool: [],          // model ids, 'manual' mode only
  extras: { fusion: false, judge: false },   // 'best' mode only
  preview: false,
  allowPaidInFree: false,
}
```

Missing or invalid fields fall back to these defaults (merged like other
settings).

### 5.2 Candidate pool — `MC.router.candidates(models, opts)`

Pure. `opts = { mode, pool, selection, manualPool, filters, attachments }`.
Steps, in order:

1. **Base:** `manual` → `manualPool`; `pool:'selection'` → current selection
   (the chat's active lanes, or `settings.selected` before the chat exists);
   otherwise the whole chat catalog minus ids matching the v1 `EXCLUDE` rule
   (preview, beta, -exp, :extended, audio, image, embed, guard).
2. **Never:** models with `router: true` (OpenRouter router-type models whose
   listed price is negative: `openrouter/auto`, `openrouter/free`,
   `openrouter/fusion`, `typesafe/jev-router`, `nvidia/switchyard`, …).
   `normalize` sets `router: true` when `pricing.prompt` < 0.
3. **Picker filters:** `MC.models.filter(list, settings.pickerFilters)`.
4. **Attachments:** if any image is attached → keep only models with
   `images`. PDFs do not restrict the pool (Round A sends pdf-text to models
   without native PDF support).
5. **Mode rule:** `free` → only `free` models; `diverse` → no change here
   (diversity is applied when ranking); others → no change.
6. **Order** by the mode's rule order (§5.5), which is also the fallback
   ranking.

Returns `{ list, reason }` where `reason` explains an empty or short pool
(`'filters'`, `'images'`, `'free'`, `'selection'`).

### 5.3 Choosing the decision model — `MC.router.chooseDecider(deciders, opts)`

Pure. Returns an ordered list of decision models to try (may be empty):

- `free` mode: the chosen decision model if it is free, then
  `baseten/mammoth-1:free`, then the other starred free ones, then any free
  decider. If `allowPaidInFree`, the chosen (paid) decision model and the
  other starred models follow.
- Other modes: the chosen decision model, then the starred ones in order.
- Only deciders present in the catalog. When images are attached, deciders
  with `images` are moved ahead of text-only ones (text-only ones still work;
  they receive a note instead of the images).
- At most 2 are tried per message (the first, plus one fallback).

### 5.4 The decision request — `MC.router.decisionRequest(...)`

Pure. Inputs: mode, candidates, the decider, the message text, the chat's
system prompt, a short context note, attachment refs and resolved image data.

```js
questions: {
  pick: {
    type: 'choice',
    instructions: GOAL[mode] + ' Answer with the label of one model.',
    criteria: { '<model id>': '<name> · <provider> · $<in>/$<out> per M · <ctx> ctx · reads images · <desc>' /* … */ },
  },
  task: {
    type: 'choice',
    instructions: 'What kind of task is the user message?',
    criteria: { code: '…', math: '…', writing: '…', analysis: '…', research: '…', chat: '…', vision: '…' },
  },
}
```

`GOAL`:

| mode | goal sentence |
|---|---|
| auto | "Which model will give the best answer to the user message, balancing answer quality against price?" |
| free | "Which of these free models will give the best answer to the user message?" |
| diverse | "Which model will give the best answer to the user message? Several different models will be chosen to get different perspectives." |
| best | "Which model will give the highest-quality answer to the user message? Ignore price." (prices omitted from criteria) |
| manual | same as auto |

`state` is `[ 'User message:\n' + text, 'System prompt:\n' + sp (if any),
'Earlier in this chat:\n' + note (if any), ...images-or-note ]`:

- the context note is the last turn's TL;DR if present, else the last 3 user
  inputs, each cut to 300 chars;
- images are added as `image_url` parts only if the decider has `images`,
  the image MIME is PNG/JPEG/WebP (PNG/JPEG only for `typesafe/*`), at most 4;
  otherwise a line `[n image(s) attached]`;
- PDFs and text files: `[PDF attached: <name>]` / the text file's first 2,000
  chars.

**Fitting the context — `fitToContext(candidates, decider, stateChars)`:**
token estimate = chars / 4. Budget = 60 % of the decider's `context` (16k
context → ~9.8k tokens). Start with at most 30 candidates; if over budget,
shorten each `desc` to 60 chars, then drop candidates from the end of the
rule order until it fits (minimum 2; below that, rule ranking is used).
`route.candidates` records the ids actually sent.

### 5.5 Ranking — `MC.router.rank(answer, candidates, mode, n)` and rule order

- From `answers.pick.probabilities` (labels not in `candidates` ignored),
  sort by probability descending; if probabilities are missing, the chosen
  label first, then rule order.
- `diverse`: walk the ranking and take at most one model per provider; if
  fewer than N providers exist, fill with the next best of any provider.
- Fill to N with the rule order when the answer yields fewer valid picks.
- Result: `[{ modelId, p }]` (p = probability or null).

**Rule order** (`MC.router.rulesPick(candidates, mode, n)`), used for pool
ordering and as fallback:

| mode | order |
|---|---|
| auto, native | Top-pick models first (v1 `sections().top`), then newest |
| manual | the manual pool in the user's order |
| free | newest first, larger context breaks ties |
| diverse | newest per provider (one per provider), providers in Top-pick order first |
| best | highest output price first (proxy for flagship), then newest |

### 5.6 Modes

| Mode | Pool rule | Decision |
|---|---|---|
| Full auto | §5.2 | decider + GOAL.auto |
| Best free | free only | free decider chain (§5.3); if none → rule order, method `rules`, note "no free decision model available"; cost $0 unless `allowPaidInFree` |
| Diverse perspectives | §5.2 | decider + GOAL.diverse; one per provider |
| Very best answer | §5.2 | decider + GOAL.best; optional extras: auto-Fusion of the answers, and Judge (§5.8) |
| Full manual | `manualPool` + filters + attachments | user-chosen decider + GOAL.manual |
| OpenRouter native | §5.2 → `allowed_models` | no decision call (§5.7) |

When the pool has fewer than N models, all are used and the route note says
"only k models fit (reason)". An empty pool blocks sending (toast with the
reason; composer keeps text and attachments).

### 5.7 OpenRouter native mode

- One lane with `modelId: 'openrouter/auto'`, `modelName: 'OpenRouter Auto'`
  (added if missing; other lanes are "not routed" this turn).
- Its requests add `plugins: [{ id: 'auto-router', allowed_models: [...pool ids] }]`
  (merged with Round A's `file-parser` plugin when a PDF is present) and
  `session_id: conv.id`. Pool ids are capped at 100 (rule order).
- `MC.api.streamChat` records the `model` field from stream chunks and
  returns it as `servedModel`; the response stores `servedModel` and the cell
  shows "→ answered by <name>".
- A 404 "No models match…" becomes the cell error
  "No allowed model fits — loosen filters or remove images".
- `count` is fixed to 1 (control disabled, ⓘ explains why: OpenRouter picks
  one model per request).

### 5.8 Very best answer extras

- **Fuse the answers:** after all routed answers finish, run Fusion with the
  configured fusion model (as the v1 auto-Fusion setting does), only if ≥ 2
  answers.
- **Judge:** after all routed answers finish (≥ 2 answers), one decision call
  with the same decider chain:
  `state = ['Question:\n' + text, 'Answer from <label>:\n' + content, …]`
  (each answer cut so the total fits §5.4's budget),
  `questions.best = { type: 'choice', instructions: 'Which answer best and most correctly answers the question?', criteria: { '<model id>': '<model name>' } }`.
  Stored as `turn.judge = { modelId, laneId, p, usage, status: 'done'|'error', error? }`;
  the winning cell shows **🏆 best (p %)**. A "Judge again" button replaces it
  (the old cost moves to `turn.spentReplaced`).

### 5.9 Send flow — `runner.route()` + app

1. User sends from the composer to all models with the router on.
2. Validate attachments (Round A), compute candidates. Empty → toast, stop.
3. Native → skip to 6. Rules-only (Best free without decider) → skip to 5.
4. Call `decide` with the first decider (15 s timeout via `AbortController`):
   - 401 / 402 → toast with the usual message; nothing sent.
   - 400/413/422 while images were in `state` → retry the same decider once
     without images (note "decided without the images").
   - 429, 5xx, network, timeout → try the next decider once; then rules.
   - Stop / Esc while routing → abort; nothing sent; composer keeps content.
5. Rank (§5.5). Build `route`.
6. If `preview` is on, show the preview dialog (§6.4); Cancel stops here.
7. Ensure a lane for each pick (new lanes join as late joiners with v1
   `seedContext`); reactivate inactive lanes. Image capability was already
   enforced, so no capability dialog appears.
8. Inputs go to picked lanes only; `MC.conv.addTurn(conv, 'broadcast', inputs,
   { attachments, delivery, route })`. Unpicked active lanes show
   "— not routed this turn".
9. Stream as usual; then Very best extras; then the usual auto TL;DR/Fusion
   settings (Fusion runs once even if both ask for it).

The composer's Send button reads "🧭 routing…" during step 4.

## 6. User interface

### 6.1 Toolbar

Order: ☰ · Multaichat · model chips · Models · Presets · **🧭 Router** ·
**Σ cost** · ⚙

- **🧭 Router** button: "🧭 Off" or "🧭 <Mode short name> ×N" (e.g.
  "🧭 Diverse ×3", "🧭 Native"). Opens the router panel.
- **Σ cost** — see §7.

### 6.2 ⓘ tooltips — `MC.dom.info(text)`

A small `button.info` "ⓘ" placed after a label, with a tooltip element
linked via `aria-describedby`. Shown after ~600 ms of mouse hover, at once on
keyboard focus, toggled by tap/click; hidden on mouse leave, blur, second tap
or `Esc`. Positioned above the button and kept inside the viewport. Reusable
for other features.

### 6.3 Router panel (`<dialog id="router-dialog">`)

Each row has an ⓘ (texts in Appendix A).

| Row | Control |
|---|---|
| Router | on/off switch |
| Mode | 6 radio cards: name + one-line summary |
| How many models | stepper 1–8 (disabled at 1 in native) |
| Pick from | Whole catalog (after model filters) / Only my current selection. Hidden in manual mode (the manual pool replaces it); used by all other modes including native |
| Decision model | current choice + list: search box, ☐ 🖼 accepts images, ☐ 📄 accepts files, ☐ Free; ★ group first, then all. Rows: name, price per M input, context, 🖼/📄/FREE badges, `desc`, ☆/★ toggle. Hidden in native |
| Very best extras | ☐ Fuse the answers · ☐ Judge marks the best answer (best mode only) |
| Manual pool | "Choose pool models…" (opens the model picker in select mode) + count of chosen (manual only) |
| Preview before sending | ☐ |
| Best free | ☐ Allow a paid decision model when no free one works (free mode only) |

Changes are saved immediately; the toolbar button and composer chip update.

### 6.4 Composer and preview

- Router on → chip `🧭 Diverse ×3 ✕` next to the target chip (✕ turns the
  router off); placeholder "Ask — the router picks 3 models…". A targeted
  composer message (↳ chip set) bypasses the router.
- **Preview dialog** (`<dialog id="route-preview-dialog">`): the picks as
  removable chips with "p %" and the task; "＋ Add from pool" (a select of the
  remaining candidates); buttons **Send**, **Send to my selection instead**
  (normal broadcast without routing) and **Cancel**. At least one pick is
  needed to Send.

### 6.5 Turns and columns

- **Route bar** on routed turns, above the answers, collapsed to one line:
  `🧭 Diverse · Decider v1.2 · task: code · 0.03¢ · 0.4 s — Claude 62 % · Gemini 21 % · Qwen 9 %`
  plus the note (fallback reason / short pool) and "▾ candidates (n)" listing
  the ids sent. Rules-only: `🧭 Best free · picked by rules — <reason>`.
  Native: `🧭 OpenRouter Auto · answered by <model>`.
- Cells of active lanes not picked: "— not routed this turn".
- Native cells: "→ answered by <name>" under the answer.
- Judge: 🏆 badge on the winning cell; "Judge again" in the route bar.

## 7. Chat cost counter

`MC.cost.summary(conv)` (pure) returns
`{ total, unknown, parts: { answers, earlier, router, derived, judge } }`:

- `answers` — `usage.cost` of each turn's current responses;
- `earlier` — `usage.cost` in each response's `previous[]`;
- `router` — `turn.route.usage.cost`;
- `derived` — `turn.tldr.usage.cost` + `turn.fusion.usage.cost` +
  `turn.spentReplaced` (TL;DR/Fusion part);
- `judge` — `turn.judge.usage.cost` (+ its replaced part);
- `unknown` — finished requests whose cost is `null`/missing (free models
  report 0, which counts as known).

`turn.spentReplaced = { derived: number, judge: number }`; regenerating TL;DR,
Fusion or the judge adds the replaced item's cost first. `runTldr` and
`runFusion` now store `usage` on the derived object.

**Display:** `Σ $0.0123` (`MC.util.formatCost`), `Σ ≥ $0.0123` when
`unknown > 0`, `Σ $0.00` without a chat. Hover/focus/tap shows the
breakdown (one line per non-zero part, plus "n requests had no price").
Updates whenever the chat changes (throttled to 4×/s while streaming). Under
800 px the label shortens to `$0.01`.

## 8. Data model changes

| Where | Field |
|---|---|
| `Model` | `router: boolean`, `desc: string` |
| `Decider` (new, not stored per chat) | §4 |
| settings | `router` (§5.1), `starredDeciders` (§4) |
| `Turn` | `route?: { mode, count, method: 'model'\|'rules'\|'native', decisionModel?, task?, picks: [{modelId, p}], candidates: string[], note?, usage?: {inputTokens, cost}, ms }` |
| `Turn` | `judge?` (§5.8), `spentReplaced?` (§7) |
| `Response` | `servedModel?` |
| `Derived` (tldr/fusion) | `usage?` |

No IndexedDB version change, no export version change: all new fields are
optional, absent in older chats (which show no route bar and count only the
costs they stored). Fork copies `route`, `judge`, `spentReplaced` with the
turns (deep clone, as today).

## 9. Module changes

| file | change |
|---|---|
| `js/core/router.js` (new) | `MODES`, `GOAL`, `candidates`, `chooseDecider`, `decisionRequest`, `fitToContext`, `rank`, `rulesPick`, `judgeRequest`, `judgeResult` (pure) |
| `js/core/cost.js` (new) | `summary(conv)` (pure) |
| `js/core/models.js` | `router`, `desc` in `normalize`; `normalizeDeciders`; `loadDeciders` (cache) |
| `js/core/openrouter.js` | `decide`, `fetchDeciders`; `streamChat` returns `servedModel`, accepts `extraBody` (`session_id`) |
| `js/core/runner.js` | `route()` (decider chain, timeout, image retry), `runJudge()`, usage on TL;DR/Fusion, `spentReplaced`, native plugins/session |
| `js/core/conversation.js` | `addTurn` stores `route`; helpers `isRouted(turn, laneId)` |
| `js/core/storage.js` | defaults for `router`, `starredDeciders` |
| `js/ui/dom.js` | `info(text)` tooltip |
| `js/ui/router.js` (new) | router panel, decider list, preview dialog |
| `js/ui/chat.js` | route bar, "not routed" cells, "answered by", 🏆 |
| `js/ui/composer.js` | router chip, placeholder, "routing…" state |
| `js/app.js` | routed send path, toolbar 🧭 and Σ, deciders loading |
| `index.html` | new scripts, `router-dialog`, `route-preview-dialog` |
| `styles.css` | tooltip, router panel, route bar, cost counter |
| `README.md` | Router and cost counter sections |
| `tests/round-b.pw.js` (new), `package.json`, `scripts/check.js` | Round B browser suite in `smoke` and `check` |

## 10. Testing

- `npm run check` before starting and after every task (baseline on
  2026-10-27: 158 unit, smoke 2, regressions 9, Round A 29 — all green).
- **Unit (node --test):**
  - `router.candidates`: each mode; catalog vs selection; manual pool;
    picker filters; image attachment excludes non-image models; PDF does not;
    router-type models excluded; empty-pool reasons.
  - `chooseDecider`: default chain; free mode with free / without free /
    `allowPaidInFree`; image-capable ordering; missing starred models skipped.
  - `decisionRequest`: goal per mode; prices omitted in best; images only for
    image deciders and allowed MIME types; notes for PDFs/text; context note.
  - `fitToContext`: 16k decider trims; minimum 2.
  - `rank`: probabilities order; unknown labels ignored; missing
    probabilities; diverse one-per-provider and fill; fill from rules.
  - `rulesPick` per mode; `judgeRequest` / `judgeResult`.
  - `cost.summary`: all parts, previous versions, replaced, unknown, free = 0,
    old chats without new fields.
  - `normalizeDeciders`, `loadDeciders` cache/fallback, `router` flag.
  - `api.decide`: body, alpha → systemone fallback on 404, errors;
    `streamChat` `servedModel` and `extraBody`.
- **Browser (`tests/round-b.pw.js`, mocked OpenRouter including the
  decisions endpoint and the decisions model list):**
  - each mode routes to the expected columns; unpicked columns show "not
    routed"; route bar text;
  - an image attachment never reaches a model without image input;
  - picker filters restrict the pool;
  - Best free with no free decider → rule ranking, no decisions request;
  - decision 429 → second decider; both fail → rules with note;
  - preview: remove a pick, add one, Cancel keeps composer content, Send;
  - native: request body has `model: 'openrouter/auto'`, `allowed_models`,
    `session_id`; cell shows "answered by";
  - Very best + judge → 🏆 badge; + fuse → Fusion rendered;
  - Σ counter sums answers + router + TL;DR, shows breakdown, survives reload;
  - ⓘ shows after long hover and on focus, hides on Esc;
  - targeted replies bypass the router.
- Existing suites stay green after every task.

## 11. Process

All commits go to `round-b-router`. No changes to `main`, no merge, deploy or
pull request without explicit approval.

## Appendix A — ⓘ texts

- **Router:** "When on, a decision model chooses which of your models answer
  each message you send to everyone. Replies to one model are never routed."
- **Full auto:** "The decision model picks the best models for this message,
  weighing answer quality against price."
- **Best free:** "Only free models are considered, and a free decision model
  picks among them. If no free decision model works, the newest free models
  are picked by simple rules, so this mode stays free."
- **Diverse perspectives:** "Picks strong models from different providers so
  you see different viewpoints. Pairs well with Fusion."
- **Very best answer:** "Picks the strongest models for this message and
  ignores price. Optionally fuses their answers or lets a judge mark the
  best one."
- **Full manual:** "You choose the models the router may pick from and the
  decision model."
- **OpenRouter native:** "OpenRouter's own Auto Router picks one model per
  message from your allowed pool. The answer shows which model was used."
- **How many models:** "How many models answer each routed message. 1 means
  a single model. OpenRouter native always uses 1."
- **Pick from:** "Whole catalog: any model that passes your model filters.
  Only my current selection: just the models in the toolbar."
- **Decision model:** "The model that makes the routing decision. Decision
  models don't chat; they choose quickly and cost a fraction of a cent. ★
  marks your favourites; they are tried in order if the first one fails."
- **Fuse the answers:** "After the answers arrive, Fusion merges them into one
  answer grouped by topic (uses your Fusion model)."
- **Judge:** "After the answers arrive, the decision model reads them and
  marks the best one with 🏆. Costs one more small decision."
- **Preview before sending:** "Shows the router's picks first so you can
  change them or cancel before anything is sent."
- **Allow a paid decision model:** "If no free decision model works, use your
  paid one instead of simple rules. The answers themselves stay free."
- **Σ cost:** "What this chat has cost so far: answers, earlier versions,
  router decisions, TL;DR, Fusion and judge."
