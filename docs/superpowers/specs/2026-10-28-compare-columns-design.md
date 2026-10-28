# Multaichat — Compare Columns View — Design Spec

Date: 2026-10-28
Status: Draft for review
Builds on: Round B (`docs/superpowers/specs/2026-10-27-round-b-router-design.md`), branch `round-b-router`.
`main` is never modified; no merge, deploy or pull request without explicit approval.

## 1. Purpose

On desktop, let the user compare models' answers side by side with some
models hidden and every visible model's thread scrolling independently.

### Success criteria

- A switch **▤ By message | ▥ Compare** chooses between today's layout and a
  column-per-model layout; the choice is remembered across reloads.
- In Compare, each visible model is one full-height column that scrolls on
  its own; models can be hidden and shown again; hidden models are
  remembered per chat.
- Clicking a "Message N" marker lines up all visible columns at message N.
- Streaming answers appear live in their column.
- Phones keep the existing By-message layout (swipeable tabs).
- `npm run check` passes, with new browser tests.

### Non-goals

- No Retry, fork, inline question replies, TL;DR / Fusion or route bar
  inside Compare (they stay in By message).
- No synchronised scrolling mode (alignment is on click only).
- No Compare view on phones.

## 2. Controls

- In the lane header bar (`.lane-bar`), a two-button segmented switch
  `.view-switch` with buttons **▤ By message** (`data-view="rows"`) and
  **▥ Compare** (`data-view="columns"`); the active one has
  `aria-pressed="true"`. Hidden at ≤ 800 px.
- In Compare, each column header shows the lane number, the model's short
  name and an eye button `.lane-hide` (aria-label "Hide <name>"). The lane bar
  shows a "Hidden:" list of chips `.hidden-chip` (name + "show" button) for
  hidden models. The last visible model's hide button is disabled
  (title "At least one model stays visible").

## 3. Layout (Compare)

- `#chat` contains `.compare` — a horizontal flex row of `.compare-col`
  (one per visible lane, in `visibleLanes()` order), each `flex: 1 1 0`,
  `min-width: 320px`, full height, `overflow-y: auto`; with more columns
  than fit, `.compare` scrolls horizontally. In Compare, `#chat` itself does
  not scroll vertically.
- A column lists, for every turn whose `inputs` include that lane, in order:
  - `.msg-mark` button "Message N" (N = turn.index + 1), `data-turn` = turn id;
  - the user's input for that lane (displayed like the prompt bubble: text
    files shown as chips, not their contents; attachments as thumbnails/file
    chips);
  - the answer: rendered via `MC.md.render`; streaming placeholder `…`;
    "stopped" tag; error text in `.cell-error`; served-model line for native;
  - actions: ⤢ (`MC.ui.fullscreen.open`), Copy, ↳ Reply
    (`MC.ui.composer.setTarget(laneId)`; only for active lanes).
- Turns the lane was not asked (or not routed to, or skipped for images) do
  not appear in that column.
- Inactive (removed) lanes that answered earlier still get a column (same
  rule as `visibleLanes`), header marked "removed".

## 4. Alignment and scrolling

- Clicking `.msg-mark` for turn T scrolls every visible column so that its
  marker for T is at the column's top; a column without T scrolls to its
  latest marker for an earlier turn (or to the top if none).
- On re-render (new turn, view switch, hide/show), a column whose scroll
  position was at the bottom (within 120 px) stays at the bottom; otherwise
  its `scrollTop` is preserved. Initially columns start at the bottom.

## 5. Live updates

`MC.ui.chat.updateCell(conv, turnId, laneId)` routes to the active view.
In Compare, a streaming answer updates only its `.md` element in place;
any other change re-renders that answer block. A new turn re-renders the
view. `MC.ui.fullscreen.update` is still called.

## 6. Data

- `settings.chatView: 'rows' | 'columns'` — global, default `'rows'`
  (added to `DEFAULT_SETTINGS`).
- `conv.hiddenLanes?: string[]` — lane ids hidden in Compare for this chat;
  saved with the chat (`MC.app.save`). Ids of lanes that no longer exist are
  ignored. Fork copies it (deep clone); "Just this model" forks keep only
  ids that still exist. Before a chat exists (empty state) Compare shows the
  empty state as usual.
- No database or export version change.

## 7. Phones

At ≤ 800 px the switch is hidden and the By-message layout is rendered
regardless of `chatView` (setting unchanged). Crossing the breakpoint
re-renders.

## 8. Module changes

| file | change |
|---|---|
| `js/ui/compare.js` (new) | `MC.ui.compare`: `render(conv, root)`, `updateCell(conv, turnId, laneId)`, `alignTo(turnId)` |
| `js/ui/chat.js` | view switch in lane bar; `render` hands off to compare when `chatView === 'columns'` and not mobile; `updateCell` routes; hide/show controls |
| `js/app.js` | `setChatView(view)`, `toggleLaneHidden(laneId)` (saves conv) |
| `js/core/storage.js` | `chatView: 'rows'` default |
| `index.html` | script `js/ui/compare.js` before `js/ui/composer.js`; `?v=` bump |
| `styles.css` | `.view-switch`, `.compare`, `.compare-col`, `.msg-mark`, `.hidden-chip` |
| `README.md` | Compare columns feature |
| `tests/view.pw.js` | new tests (§9) |

## 9. Testing

Browser tests (`tests/view.pw.js`, mocked OpenRouter):
- switching to Compare shows one column per visible model; the choice
  survives reload; switching back shows the By-message rows;
- hiding a model removes its column and lists it under "Hidden:"; showing
  brings it back; the hidden set survives reload and is per chat (a new chat
  shows all models); the last visible model cannot be hidden;
- columns scroll independently: after two long turns, scrolling one
  column's `scrollTop` leaves the others unchanged;
- clicking "Message 2" in one column puts every column's Message 2 marker at
  its top (within 2 px);
- a streaming answer's text appears in the right column and updates;
- a model removed before turn 2 has no Message 2 in its column;
- at 390 px width there is no `.view-switch` and By-message rows render even
  with `chatView: 'columns'` saved.

Unit: `storage` default includes `chatView: 'rows'`.
