# Multaichat

Ask several [OpenRouter](https://openrouter.ai) models the same question at once, compare their answers side by side, and condense them with a **TL;DR** or a topic-grouped **Fusion** view.

Plain HTML/CSS/JavaScript with no build step and no dependencies. It runs entirely in your browser.

## Features

- **Parallel answers.** Every selected model streams its answer into its own column, with token count and cost shown.
- **Always-current model picker.** The model list is loaded live from OpenRouter (and cached for 24 h). The picker has:
  - a search box: every word must match, and `free`, `open` and `new` work as filters (e.g. `free llama`, `open coder`)
  - suggestion sections: **Top picks** (newest model from each major provider), **Free**, **Open-weight: new & powerful**, and **All models** with sorting and price filters
  - a **Try with free models** button
- **Reply to everyone or to one model.**
  - The box at the bottom sends to all models.
  - **↳ Reply** on an answer sends your next message to that model only.
  - When a model asks you something, a reply box appears right under its question.
  - If several models ask questions, **Answer them together** lets you give each one its own answer in one step.
- **Model filters:** in the picker, set a max input and output price ($ per million tokens), a minimum context length, and "accepts images" / "accepts files". The filters apply to every section and to search, and are remembered. Models that accept images or PDFs show 🖼 / 📄.
- **Presets:** a preset is a named bundle of a **system prompt**, a **message template** and a **set of models**; each part is optional.
  - Three are built in (Concise expert, Code reviewer, Explain simply).
  - **Save current as preset** captures the chat's system prompt, its models and whatever is in the message box. You can untick or edit any part before saving.
  - The 📝 chip above the chat shows and edits the chat's system prompt. It shows "(edited)" when you've changed a preset's prompt, with **Update preset** or **Save as new preset**.
  - You can choose a default preset for new chats in Settings.
- **Attachments:** 📎, drag-and-drop onto the message box, or paste.
  - **Images** (png, jpg, webp, gif; up to 20 MB, scaled down to 2048 px).
  - **PDFs** (up to 20 MB). Models that read PDFs get the file itself; all others get the text via OpenRouter's free PDF parsing. Settings can switch them to OCR for scanned documents, which is paid.
  - **Text and code files** (up to 200 KB). Their contents go into the message, so every model can read them.
  - If some models can't read images, you're asked whether to **skip them** or **send them the text only**. You can tick "remember for this chat".
  - Up to 10 files per message.
- **Each model keeps its own thread.** A model only sees the messages that were sent to it. Columns that weren't asked in a turn say so.
- **Fork** a chat from any turn, or **continue with just one model**.
- **Retry** a single answer. Earlier versions are kept under "previous".
- **Fullscreen:** ⤢ on an answer (or double-click its header) shows it full-window at reading width. **←/→** flip to the other models' answers to the same message; `Esc` closes.
- **TL;DR:** a short bullet summary written by a summary model you choose.
- **Fusion:** one merged answer organized by topic, showing which models agree, where they disagree, and points only one model made. Under each topic, **Show sources** displays each model's original wording. Quotes that don't appear word-for-word in a model's answer are marked *paraphrased*.
- History is kept in your browser (IndexedDB), with **export/import** to JSON. There's a light and a dark theme, and the layout works on phones: the model columns become swipeable tabs.

## Getting started

1. Get an API key at <https://openrouter.ai/keys>. Free models work on a free account.
2. Open the app, using either of these:
   - **From disk:** double-click `index.html`.
   - **GitHub Pages:** in the repository go to *Settings → Pages → Build and deployment*, choose *Deploy from a branch*, then pick the branch and `/ (root)`. Open the URL that appears.
3. Paste your key, pick models (press `/` or `Ctrl/⌘+K`) and ask away.

## Privacy

- Your API key and conversations are stored **only in this browser** (localStorage and IndexedDB). They are never written to this repository or sent to any server except OpenRouter.
- Untick *Remember on this device* in Settings to keep the key only until you close the tab.
- Browser storage is separate for each place the app is opened from, so the copy opened from disk and the one on GitHub Pages have separate histories. Use **Export** in the sidebar to make backups or move chats between them.
- Attached files are stored in this browser alongside the chat and sent only to OpenRouter. Deleting a chat deletes its files, unless a fork of it still uses them. **Export** includes the files, so exports with images can be large.
- *Clear all local data* in Settings removes the key, settings and all conversations.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Enter` / `Shift+Enter` | Send / new line |
| `/` or `Ctrl/⌘+K` | Open the model picker |
| `↑` `↓` `Enter` | Move and select in the picker |
| `Alt+1…9` | Reply to model N (focuses its question box, or targets the composer) |
| `Esc` | In the message box: clear the "to one model" target, or stop all answers while streaming |
| `Ctrl/⌘+Enter` | Send in the "Answer them together" panel |

## Notes
- **Router.** Instead of picking models yourself, turn on 🧭 in the toolbar and let a decision model choose which models answer each message.
  - **Modes** (each has an ⓘ in the 🧭 panel):
    - *Full auto* — the decision model picks the best models for this message, weighing answer quality against price.
    - *Diverse perspectives* — strong models from different providers, so you see different viewpoints. Pairs well with Fusion.
    - *Best free* — only free models are considered, and a free decision model picks among them. If no free decision model works, the newest free models are picked by simple rules, so this mode stays free.
    - *Very best answer* — the strongest models for this message, ignoring price; optionally fuses their answers or lets a judge mark the best one (see extras below).
    - *Full manual* — you choose the models the router may pick from and the decision model; the decision model still picks among them.
    - *OpenRouter native* — OpenRouter's own Auto Router picks one model per message from your allowed pool; the answer shows which model was used.
  - **Pool:** pick from the whole catalog or only from the models in your toolbar. The picker filters (price, context, images, files) also apply, and a message with images never goes to a model that can't read them.
  - **Count:** how many models answer (1 to 8; OpenRouter native always uses 1, and your saved number comes back when you switch to another mode).
  - **Decision models and stars:** the decision models come live from OpenRouter. Star the ones you like; the router uses your default (or the first starred one) and tries one more starred model if it fails, then falls back to simple rules.
  - **Preview:** optionally see the picks before sending, remove some, or send to your own selection instead.
  - **Very best answer extras:** after the answers finish, *Fuse the answers* runs a Fusion, and *Judge* asks a decision model which answer is best. The winner shows 🏆 best (with its probability when the decision model gives one); **Judge again** in the route bar asks anew.
  - **Costs of decisions:** each decision is a small paid request (free ones cost nothing). Its cost is shown in the route bar ("free" when it cost nothing) and counted in the chat total, even when you cancel the preview or send to your own selection instead.
  - Every turn shows a route bar above the answers: the mode, decision model, task, cost, time and each pick's probability, plus the candidates that were considered.
- **Σ cost counter.** The top bar shows what the current chat has cost so far, including router decisions, TL;DR, Fusion and the judge. Hover over it, or hover/tap the ⓘ next to it, for the breakdown. A leading ≥ means some requests had no price from OpenRouter.

- Free models are rate-limited by OpenRouter. When one hits the limit, its column offers **Use paid variant** if a paid version of that model exists.
- Fusion asks the model for JSON output. Models that can't produce it show their raw reply with a *Regenerate* option.

## Development

```
npm run check    # production check: assets/paths for GitHub Pages, page loads under /Multaichat/ and from file://, all suites
npm test         # unit tests for js/core and the markdown renderer (Node 22+, no deps)
npm run smoke    # Playwright browser tests (flow, regressions, Round A features, `tests/round-b.pw.js` for the cost counter and router, `tests/view.pw.js` for answer views) against a mocked OpenRouter
```

Code layout: `js/core/*` holds the logic and has no page-handling code, so it is unit-tested in Node. `js/ui/*` builds the page. `js/app.js` connects the two. Scripts are loaded as plain `<script>` tags rather than ES modules, so the app also works when opened from disk.
