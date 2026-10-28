# Compare Columns View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop "Compare" view with one independently scrolling column per visible model, per-chat hiding of models, and click-to-align message markers.

**Architecture:** A new `js/ui/compare.js` (`MC.ui.compare`) renders the column view into `#chat`; `MC.ui.chat.render` / `updateCell` hand off to it when `settings.chatView === 'columns'` and the viewport is wider than 800 px. Hidden lanes live on the conversation (`conv.hiddenLanes`); the view choice lives in settings (`chatView`).

**Tech Stack:** Vanilla JS, classic `<script>` tags on `window.MC`, Playwright browser tests with the mocked OpenRouter (`tests/pw-helpers.js`), `node --test` unit tests.

**Spec:** `docs/superpowers/specs/2026-10-28-compare-columns-design.md`

## Global Constraints

- Branch `round-b-router`. Never modify or push `main`. No merge, deploy or pull request without approval.
- `npm run check` green before and after every task (baseline: unit 227, smoke 2, regressions 10, Round A 29, Round B 28, answer views 3).
- No build step, no dependencies; works from `file://` and under `/Multaichat/`. Every `<script>`/`<link>` in `index.html` carries the same `?v=` — bump all to `?v=5` once (Task 1).
- Untrusted text (answers, inputs, model names) reaches `innerHTML` only via `MC.md.render`.
- Phones: at `(max-width: 800px)` the switch is hidden and By message is rendered regardless of `chatView`.
- Column min width 320 px; "at bottom" threshold 120 px; alignment tolerance in tests 2 px.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_019avxUWgqoqc2FL7asfHeDE`.

## Review Focus

1. **A chat whose hidden lane ids no longer exist** (lane removed via fork "Just this model", or imported chat) → ignored, never hides everything. Test in Task 2 (`stale hidden ids are ignored`).
2. **Hiding the only remaining visible model by clicking fast** → the last visible model's hide button is disabled. Test in Task 2.
3. **Switching view while answers stream** → streaming continues into the new view without a page error. Test in Task 3 (`switch view while streaming`).
4. **Resizing across 800 px with Compare saved** → re-renders into the right layout. Test in Task 1 (`phone width renders rows`), resize case.
5. **Very many models (6+)** → columns keep ≥ 320 px and the row scrolls sideways instead of squeezing. Test in Task 1 (`columns keep min width`).

---

### Task 1: View switch and column layout

**Files:**
- Create: `js/ui/compare.js`
- Modify: `js/ui/chat.js` (`render`, `updateCell`, new view bar), `js/app.js` (`setChatView`), `js/core/storage.js` (`DEFAULT_SETTINGS.chatView: 'rows'`), `index.html` (script `js/ui/compare.js` after `js/ui/chat.js`; all `?v=4` → `?v=5`), `styles.css`
- Test: `tests/view.pw.js`, `tests/storage.test.js`

**Interfaces:**
- Produces:
  - `MC.app.setChatView(view: 'rows'|'columns')` — saves `settings.chatView`, calls `MC.ui.chat.render(state.conv)`.
  - `MC.ui.chat.isCompare() -> boolean` — `chatView === 'columns'` and not `(max-width: 800px)`.
  - View bar `.view-bar` rendered at the top of `#chat` (after the system-prompt chip) whenever a chat with turns exists, in both views; contains `.view-switch` with two buttons `[data-view="rows"]` "▤ By message" and `[data-view="columns"]` "▥ Compare", active one `aria-pressed="true"`; `.view-bar` has `display: none` at ≤ 800 px.
  - `MC.ui.compare.render(conv, root)` — appends `.compare` containing one `.compare-col[data-lane=<laneId>]` per lane in `MC.ui.chat.visibleLanes(conv)` (Task 2 filters hidden ones). Column = `.col-head` (lane number, short name, "removed" when inactive) + `.col-body` (the scrolling element) holding, for each turn with `laneId in turn.inputs`: `.msg-mark[data-turn=<turnId>]` button "Message N", `.col-input` (the lane's input via chat.js `displayText`, plus attachment chips via `attachmentEl` — export both on `MC.ui.chat`), `.col-answer[data-answer=<turnId>:<laneId>]` (status class `status-<status>`, `.md` via `MC.md.render`, `…` while streaming, error in `.cell-error`, served line for native) and actions: `button.fs-open` ⤢, Copy, ↳ Reply (active lanes only).
  - `MC.ui.compare.updateCell(conv, turnId, laneId)` — in place: streaming → replace that answer's `.md` innerHTML; else re-render that `.col-answer`; unknown block → full `MC.ui.chat.render(conv)`.
  - In Compare, `#chat` gets class `compare-mode` (no vertical scroll; `.compare` fills height: flex row, `overflow-x: auto`; `.compare-col` `flex: 1 1 0; min-width: 320px; display:flex; flex-direction:column`; `.col-body` `overflow-y: auto; flex: 1; min-height: 0`).

- [ ] **Step 1: Write the failing tests** in `tests/view.pw.js`

```js
'switch to Compare shows one column per model and survives reload':
  ask; allDone(1); click '.view-switch [data-view="columns"]';
  assert count('.compare-col') === count of lanes (3); assert no '.turns';
  assert '.view-switch [data-view="columns"]' aria-pressed 'true';
  reload; waitFor '.compare-col'; count === 3;
  click rows → '.turns' visible, no '.compare'.
'a model not asked in a turn has no marker for it':
  ask; allDone; remove middle model (chip ✕); ask 'Second'; allDone(2); switch to columns;
  middle column '.msg-mark' count === 1; first column count === 2.
'phone width renders rows even with Compare saved':
  open with init mc.settings {chatView:'columns'} at 1400px; ask; allDone; '.compare' visible;
  page.setViewportSize({width:390,height:800}); waitFor '.turns'; assert no '.compare'; '.view-bar' not visible;
  setViewportSize back to 1400 → '.compare' again.
'columns keep min width':
  select 6 models via settings seed (mc.settings selected: 6 fixture ids); ask; allDone; switch;
  every '.compare-col' boundingBox width >= 319; '.compare' scrollWidth > clientWidth.
```
`tests/storage.test.js`: `DEFAULT_SETTINGS.chatView === 'rows'`.

- [ ] **Step 2: Run** `node tests/view.pw.js` and `node --test tests/storage.test.js` → new tests FAIL (no `.view-switch`).
- [ ] **Step 3: Implement** per Interfaces; re-render on `matchMedia('(max-width: 800px)')` change (chat.js).
- [ ] **Step 4: Run** `node tests/view.pw.js` → all pass; `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: compare columns view with a view switch`

---

### Task 2: Hide and show models per chat

**Files:**
- Modify: `js/ui/compare.js`, `js/app.js`, `styles.css`
- Test: `tests/view.pw.js`

**Interfaces:**
- Consumes: Task 1 column structure.
- Produces:
  - `MC.app.toggleLaneHidden(laneId)` — toggles `laneId` in `state.conv.hiddenLanes` (creating the array), refuses (no-op) when it would leave no visible lane, saves the conv (`save`), re-renders.
  - `MC.ui.compare.visibleColumns(conv) -> Lane[]` — `visibleLanes(conv)` minus ids in `conv.hiddenLanes`; ids not matching any lane are ignored; if that leaves none, all lanes.
  - Column head button `.lane-hide` (👁, aria-label `Hide <short name>`, disabled with title `At least one model stays visible` when it is the only visible column).
  - In Compare's `.view-bar`: `.hidden-list` "Hidden:" followed by `.hidden-chip` per hidden lane (short name + button "show", aria-label `Show <short name>`); absent when nothing hidden.

- [ ] **Step 1: Write the failing tests**

```js
'hiding a model removes its column; show brings it back; saved per chat':
  ask; allDone; switch to columns; click first column '.lane-hide';
  count('.compare-col') === 2; '.hidden-chip' text contains first lane name;
  reload → still 2 columns; new chat (+ New chat) then ask; allDone → 3 columns;
  open the first chat from the sidebar → 2 columns; click '.hidden-chip button' → 3.
'the last visible model cannot be hidden':
  hide two of three; remaining '.lane-hide' is disabled; clicking it keeps 1 column.
'stale hidden ids are ignored':
  evaluate: MC.app.state.conv.hiddenLanes = ['l_missing']; MC.ui.chat.render(MC.app.state.conv);
  count('.compare-col') === 3; no '.hidden-chip'.
```

- [ ] **Step 2: Run** `node tests/view.pw.js` → new tests FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `node tests/view.pw.js` and `npm run check` → green.
- [ ] **Step 5: Commit** — `feat: hide and show models in compare view (per chat)`

---

### Task 3: Independent scrolling, alignment and live updates

**Files:**
- Modify: `js/ui/compare.js`, `js/ui/chat.js` (routing `updateCell`), `README.md`, `styles.css`
- Test: `tests/view.pw.js`

**Interfaces:**
- Produces:
  - `MC.ui.compare.alignTo(turnId)` — for each `.compare-col .col-body`: scroll so its `.msg-mark[data-turn=turnId]` top is at the body's top; if absent, use the last marker whose turn index is lower; if none, `scrollTop = 0`. Clicking a `.msg-mark` calls it.
  - Scroll preservation in `render`: before clearing, record each column's `scrollTop` and whether it was within 120 px of its bottom (keyed by lane id); after rendering, restore — bottom-pinned columns go to the bottom; new columns start at the bottom.
  - Streaming updates (`updateCell`) keep a bottom-pinned column at the bottom.
  - README: under Features, a **Compare columns** bullet (switch, hide/show per chat, independent scrolling, "Message N" aligns all columns, desktop only).

- [ ] **Step 1: Write the failing tests**

```js
'columns scroll independently':
  opts { answers long }: seed two turns whose answers are long (ask twice with mock answer text ≥ 3000 chars — add opts.longAnswers to the mock: repeat the answer 60×);
  switch; set first column body scrollTop = 0; read others' scrollTop; they are unchanged (> 0, at bottom).
'clicking Message 2 aligns all columns':
  same seed; click first column '.msg-mark[data-turn=<turn2 id>]';
  for every column: |marker.top - body.top| <= 2.
'streaming text appears in its column':
  opts.delay 1500; switch to columns before asking; ask; wait for a '.col-answer.status-streaming';
  allDone; every column's last '.col-answer .md' text equals that lane's answer in the rows view after switching back.
'switch view while streaming':
  opts.delay 1500; ask; immediately switch to columns, then back to rows; allDone(1); no page errors; 3 answered cells.
```
(`opts.longAnswers` is a new option in `tests/pw-helpers.js` `mockOpenRouter`: when true, each chat answer text is repeated 60 times joined by '\n\n'.)

- [ ] **Step 2: Run** `node tests/view.pw.js` → new tests FAIL.
- [ ] **Step 3: Implement** per Interfaces; README bullet.
- [ ] **Step 4: Run** `node tests/view.pw.js` and `npm run check` → all green.
- [ ] **Step 5: Commit** — `feat: compare view scrolling, message alignment and live updates; docs`
