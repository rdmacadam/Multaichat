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
- **Each model keeps its own thread.** A model only sees the messages that were sent to it. Columns that weren't asked in a turn say so.
- **Fork** a chat from any turn, or **continue with just one model**.
- **Retry** a single answer. Earlier versions are kept under "previous".
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

- Free models are rate-limited by OpenRouter. When one hits the limit, its column offers **Use paid variant** if a paid version of that model exists.
- Fusion asks the model for JSON output. Models that can't produce it show their raw reply with a *Regenerate* option.

## Development

```
npm test         # unit tests for js/core and the markdown renderer (Node 22+, no deps)
npm run smoke    # Playwright browser tests (flow + regressions) against a mocked OpenRouter
```

Code layout: `js/core/*` holds the logic and has no page-handling code, so it is unit-tested in Node. `js/ui/*` builds the page. `js/app.js` connects the two. Scripts are loaded as plain `<script>` tags rather than ES modules, so the app also works when opened from disk.
