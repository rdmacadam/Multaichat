/* Chat area: one column per lane, one row per turn. Handles the per-answer
   actions (reply, retry, stop, copy, fork), inline replies to clarifying
   questions, and mobile lane tabs. */
(function (MC) {
  'use strict';
  const { h, clear, shortName, copyText, autoGrow } = MC.dom;
  const U = MC.util;

  const view = { activeCol: 0, pending: new Map(), raf: 0, unread: new Set() };
  const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
  const app = () => MC.app;

  function visibleLanes(conv) {
    return conv.lanes.filter((l) => l.active || conv.turns.some((t) => l.id in t.inputs));
  }

  // ---------- empty / first-run ----------
  function firstRun(root) {
    const key = h('input', { type: 'password', id: 'first-key', placeholder: 'Paste your OpenRouter API key (sk-or-v1-…)', autocomplete: 'off', spellcheck: 'false' });
    const remember = h('input', { type: 'checkbox', checked: true });
    const saveKey = () => {
      if (!key.value.trim()) { key.focus(); return; }
      app().state.settings.setKey(key.value, remember.checked);
      app().state.settings.set({ rememberKey: remember.checked });
      MC.dom.toast('Key saved');
      app().refresh();
      MC.ui.composer.focus();
    };
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
    root.append(h('div', { class: 'card first-run' },
      h('h2', {}, 'Ask several AI models at once'),
      h('p', {}, 'Multaichat sends your question to multiple OpenRouter models in parallel, shows the answers side by side, and can summarize (TL;DR) or fuse them into one topic-grouped answer.'),
      h('label', { for: 'first-key' }, 'Your OpenRouter API key'),
      h('div', { class: 'row' }, key, h('button', { class: 'primary', onclick: saveKey }, 'Save key')),
      h('label', { class: 'check' }, remember, ' Remember on this device'),
      h('p', { class: 'muted small' }, 'Get a key at ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener noreferrer' }, 'openrouter.ai/keys'),
        '. The key is stored only in this browser and is sent only to OpenRouter. Free models work with a free account.')));
  }

  function emptyState(root) {
    const sel = app().state.settings.get().selected;
    root.append(h('div', { class: 'card empty-state' },
      h('h2', {}, 'What do you want to ask?'),
      h('p', {}, sel.length
        ? `Your question will go to ${sel.length} model${sel.length === 1 ? '' : 's'}: ` + sel.map((id) => shortName((app().modelById(id) || { name: id }).name)).join(', ') + '.'
        : 'Pick some models first.'),
      h('div', { class: 'row' },
        h('button', { class: 'ghost', onclick: () => app().openModelPicker() }, 'Choose models'),
        h('span', { class: 'muted small' }, 'Tip: press / to search models, Alt+1…9 to reply to one model.'))));
  }

  // ---------- lane bar ----------
  function laneBar(conv, lanes) {
    const mobile = isMobile();
    const latest = conv.turns[conv.turns.length - 1];
    return h('div', { class: 'lane-bar grid', role: mobile ? 'tablist' : null, style: `--cols:${lanes.length}` },
      lanes.map((l, i) => {
        const asks = latest && latest.responses[l.id] && latest.responses[l.id].asksQuestion;
        return h('div', {
          class: 'lane-head' + (l.active ? '' : ' inactive') + (i === view.activeCol ? ' active' : '') + (view.unread.has(l.id) ? ' unread' : ''),
          role: mobile ? 'tab' : null, 'aria-selected': mobile ? String(i === view.activeCol) : null, tabindex: mobile ? '0' : null,
          dataset: { col: i, lane: l.id }, title: l.modelId,
          onclick: () => setActiveCol(i),
        },
          h('span', { class: 'lane-num' }, String(i + 1)),
          h('span', { class: 'lane-name' }, shortName(l.modelName)),
          asks ? h('span', { class: 'badge ask', title: 'Asked you something' }, '❓') : null,
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          !l.active ? h('span', { class: 'muted small' }, 'removed') : null,
          l.joinedAtTurn > 0 ? h('span', { class: 'muted small joined' }, `joined at turn ${l.joinedAtTurn + 1}${l.seedContext ? ' with summary context' : ''}`) : null);
      }));
  }

  function setActiveCol(i) {
    view.activeCol = i;
    const conv = app().state.conv;
    if (!conv) return;
    const lane = visibleLanes(conv)[i];
    if (lane) view.unread.delete(lane.id);
    document.querySelectorAll('#chat [data-col]').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.col) === i);
      if (el.classList.contains('lane-head')) {
        el.setAttribute('aria-selected', String(Number(el.dataset.col) === i));
        if (Number(el.dataset.col) === i) el.classList.remove('unread');
      }
    });
  }

  // ---------- cells ----------
  function laterTurnAsks(conv, turn, laneId) {
    return conv.turns.some((t) => t.index > turn.index && laneId in t.inputs);
  }

  function paidVariant(lane) {
    if (!/:free$/.test(lane.modelId)) return null;
    return app().modelById(lane.modelId.replace(/:free$/, ''));
  }

  function inlineReply(conv, turn, lane) {
    const ta = h('textarea', { class: 'inline-reply', rows: 1, placeholder: `Reply to ${shortName(lane.modelName)} only…`, 'aria-label': `Reply to ${shortName(lane.modelName)}` });
    autoGrow(ta, 160);
    const send = () => {
      const text = ta.value.trim();
      if (!text) return;
      if (app().state.runner.isBusy()) { MC.dom.toast('Wait for the current answers to finish (or Stop all)', 'warn'); return; }
      ta.value = '';
      app().sendTargeted(lane.id, text);
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    return h('div', { class: 'ask-box' },
      h('div', { class: 'ask-label' }, '❓ asked you something'),
      h('div', { class: 'row' }, ta, h('button', { class: 'primary small', onclick: send, 'aria-label': 'Send reply' }, '↵')));
  }

  function statusLine(r) {
    const bits = [];
    if (r.status === 'streaming') bits.push(h('span', { class: 'spinner', 'aria-label': 'Answering' }));
    if (r.status === 'stopped') bits.push(h('span', { class: 'muted small' }, 'stopped'));
    if (r.usage) {
      const tok = (r.usage.promptTokens || 0) + (r.usage.completionTokens || 0);
      bits.push(h('span', { class: 'muted small', title: `${r.usage.promptTokens} in / ${r.usage.completionTokens} out tokens` }, U.formatTokens(tok) + ' tok'));
      if (r.usage.cost != null) bits.push(h('span', { class: 'muted small' }, U.formatCost(r.usage.cost)));
    }
    return h('div', { class: 'cell-status' }, bits);
  }

  function cell(conv, turn, lane, col) {
    const key = turn.id + ':' + lane.id;
    const base = { class: 'cell' + (col === view.activeCol ? ' active' : ''), dataset: { cell: key, col } };
    if (!(lane.id in turn.inputs)) {
      base.class += ' not-asked';
      const reason = turn.skipped && turn.skipped[lane.id];
      if (!reason && turn.route) base.class += ' not-routed';
      return h('div', base, h('span', { class: 'muted small' }, reason ? '— not sent: ' + reason : turn.route ? '— not routed this turn' : '— not asked this turn'));
    }
    const r = turn.responses[lane.id];
    base.class += ' status-' + r.status;
    const runner = app().state.runner;
    const uniqueInputs = new Set(mainInputs(turn)).size;
    const textOnly = turn.delivery && turn.delivery[lane.id] === 'text';
    const best = !!(turn.judge && turn.judge.status === 'done' && turn.judge.laneId === lane.id);
    const actions = [];
    if (r.status === 'streaming') actions.push(h('button', { class: 'ghost small', onclick: () => runner.stop(turn.id, lane.id) }, '■ Stop'));
    else {
      if (lane.active) actions.push(h('button', { class: 'ghost small', title: 'Send your next message to this model only', onclick: () => MC.ui.composer.setTarget(lane.id) }, '↳ Reply'));
      actions.push(h('button', { class: 'ghost small', title: 'Regenerate this answer', onclick: () => runner.retry(conv, turn.id, lane.id) }, '↻ Retry'));
      if (r.content) actions.push(h('button', { class: 'ghost small', onclick: () => copyText(r.content) }, 'Copy'));
      actions.push(h('button', { class: 'ghost small', title: 'Start a new chat with only this model, up to here', onclick: () => app().forkAt(turn.index, lane.id) }, 'Just this model'));
    }
    const paid = r.status === 'error' && r.errorStatus === 429 ? paidVariant(lane) : null;
    return h('div', base,
      h('div', { class: 'cell-head', title: 'Double-click for fullscreen', ondblclick: (e) => { if (!e.target.closest('button')) MC.ui.fullscreen.open(conv, turn.id, lane.id); } },
        h('span', { class: 'cell-model' }, shortName(lane.modelName),
        textOnly ? h('span', { class: 'badge tag-text-only', title: 'Attachments were left out for this model' }, 'text only') : null,
        best ? h('span', { class: 'badge best', title: 'Picked by the judge as the best answer' }, '🏆 best' + (typeof turn.judge.p === 'number' ? ' (' + Math.round(turn.judge.p * 100) + ' %)' : '')) : null), statusLine(r),
        h('button', { class: 'icon small fs-open', 'aria-label': 'Fullscreen ' + shortName(lane.modelName), title: 'Fullscreen (←/→ to flip models)', onclick: () => MC.ui.fullscreen.open(conv, turn.id, lane.id) }, '⤢')),
      uniqueInputs > 1 && !textOnly ? h('div', { class: 'cell-input' }, h('span', { class: 'muted small' }, 'You: '), displayText(turn.inputs[lane.id])) : null,
      h('div', { class: 'md', html: r.content ? MC.md.render(r.content) : r.status === 'streaming' ? '<p class="muted">…</p>' : '' }),
      r.servedModel ? h('div', { class: 'served muted small', title: r.servedModel }, '→ answered by ' + modelShort(r.servedModel)) : null,
      r.status === 'error' ? h('div', { class: 'cell-error', role: 'alert' }, '⚠ ', r.error || 'Error',
        paid ? h('button', { class: 'ghost small', onclick: () => { lane.modelId = paid.id; lane.modelName = paid.name; runner.retry(conv, turn.id, lane.id); app().refresh(); } }, 'Use paid variant') : null) : null,
      r.previous && r.previous.length ? h('details', { class: 'previous' }, h('summary', {}, `previous (${r.previous.length})`),
        r.previous.map((p, i) => h('div', { class: 'prev' }, h('div', { class: 'muted small' }, `Version ${i + 1}`), h('div', { class: 'md', html: MC.md.render(p.content || p.error || '') })))) : null,
      r.status !== 'streaming' && r.asksQuestion && lane.active && !laterTurnAsks(conv, turn, lane.id) ? inlineReply(conv, turn, lane) : null,
      h('div', { class: 'cell-actions' }, actions));
  }

  // Inputs of lanes that got the full message (text-only lanes carry extra notes).
  function mainInputs(turn) {
    return Object.keys(turn.inputs).filter((id) => !(turn.delivery && turn.delivery[id] === 'text')).map((id) => turn.inputs[id]);
  }

  // Inlined text files are shown as file chips, not as their full contents.
  function displayText(input) {
    return String(input || '').replace(/\n*--- file: (.+?) ---\n[\s\S]*?\n--- end of \1 ---/g, '').trim();
  }

  function attachmentEl(ref) {
    const el = ref.kind === 'image'
      ? h('a', { class: 'att-thumb', target: '_blank', rel: 'noopener', title: ref.name }, h('img', { alt: ref.name }))
      : h('a', { class: 'att-file', download: ref.name, title: 'Download ' + ref.name }, (ref.kind === 'pdf' ? '📄 ' : '📝 ') + ref.name);
    app().state.store.getAttachment(ref.id).then(async (rec) => {
      if (!rec) { el.classList.add('missing'); el.title = ref.name + ' (unavailable)'; return; }
      const url = await MC.files.objectUrl(rec);
      el.href = url;
      const img = el.querySelector('img');
      if (img) img.src = url;
    }).catch(() => el.classList.add('missing'));
    return el;
  }

  function promptRow(conv, turn) {
    let main = mainInputs(turn);
    // Every lane got the text-only version: show it without the omitted-image notes.
    if (!main.length) main = Object.values(turn.inputs).map((t) => t.replace(/\n*\[image omitted: [^\]\n]*\]/g, ''));
    const unique = [...new Set(main)];
    const ids = Object.keys(turn.inputs);
    const addressed = ids.length + Object.keys(turn.skipped || {}).length;
    const allActive = conv.lanes.filter((l) => l.active).length;
    let label;
    if (turn.kind === 'clarify-batch' || unique.length > 1) label = 'You answered each model';
    else if (turn.kind === 'targeted' || addressed < allActive) label = 'You → ' + ids.map((id) => shortName((MC.conv.laneById(conv, id) || {}).modelName)).join(', ') + ' only';
    else label = 'You → all';
    const text = unique.length === 1 ? displayText(unique[0]) : '';
    const atts = turn.attachments || [];
    return h('div', { class: 'prompt' },
      h('div', { class: 'prompt-label muted small' }, label),
      text || atts.length ? h('div', { class: 'bubble' },
        atts.length ? h('div', { class: 'att-row' }, atts.map(attachmentEl)) : null,
        text || null) : null);
  }

  // ---------- route bar (spec §6.5) ----------
  const MODE_NAMES = { auto: 'Full auto', free: 'Best free', diverse: 'Diverse perspectives', best: 'Very best answer', manual: 'Full manual', native: 'OpenRouter native' };
  const NATIVE_NAME = 'OpenRouter Auto';

  function modelShort(id, conv) {
    const m = app().modelById(id);
    if (m) return shortName(m.name);
    const lane = conv && conv.lanes.find((l) => l.modelId === id);
    return lane ? shortName(lane.modelName) : id;
  }

  function deciderShort(id) {
    const d = (app().state.deciders || []).find((x) => x.id === id);
    return d ? shortName(d.name) : String(id).split('/').pop();
  }

  const seconds = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1) + ' s';

  // The model OpenRouter's Auto Router chose for a native turn, if known.
  function servedOf(conv, turn) {
    for (const laneId of Object.keys(turn.inputs)) {
      const lane = MC.conv.laneById(conv, laneId);
      const r = turn.responses[laneId];
      if (lane && lane.modelId === MC.router.NATIVE_ID && r && r.servedModel) return r.servedModel;
    }
    return null;
  }

  function routeSummary(conv, turn) {
    const route = turn.route;
    if (route.method === 'native') {
      const served = servedOf(conv, turn);
      return '🧭 ' + NATIVE_NAME + (served ? ' · answered by ' + modelShort(served, conv) : '');
    }
    const bits = ['🧭 ' + (MODE_NAMES[route.mode] || route.mode)];
    if (route.method === 'rules') bits.push('picked by rules');
    else if (route.decisionModel) bits.push(deciderShort(route.decisionModel));
    if (route.task) bits.push('task: ' + route.task);
    if (route.usage && route.usage.cost != null) bits.push(route.usage.cost === 0 ? 'free' : U.formatCost(route.usage.cost));
    if (route.ms != null) bits.push(seconds(route.ms));
    const picks = (route.picks || []).map((x) => modelShort(x.modelId, conv) + (x.p == null ? '' : ' ' + Math.round(x.p * 100) + ' %'));
    return bits.join(' · ') + (picks.length ? ' — ' + picks.join(' · ') : '');
  }

  function routeBar(conv, turn) {
    const route = turn.route;
    if (!route) return null;
    const summary = routeSummary(conv, turn);
    const ids = route.candidates || [];
    const judge = turn.judge;
    const runner = app().state.runner;
    const judgeBusy = runner.isBusy(turn.id) || (judge && judge.status === 'streaming');
    return h('div', { class: 'route-bar', dataset: { route: turn.id } },
      h('div', { class: 'route-line', title: summary + (route.note ? ' · ' + route.note : '') },
        h('span', { class: 'route-summary' }, summary),
        route.note ? h('span', { class: 'route-note muted' }, ' · ' + route.note) : null,
        judge && judge.status === 'streaming' ? h('span', { class: 'route-judge muted small' }, ' · 🏆 judging…') : null,
        judge && judge.status === 'error' ? h('span', { class: 'route-judge-error', role: 'alert' }, ' · ⚠ Judge failed: ' + (judge.error || 'error')) : null,
        judge && judge.status !== 'streaming' ? h('button', {
          class: 'ghost small judge-again', disabled: judgeBusy, title: 'Ask the judge again which answer is best',
          onclick: () => app().judgeTurn(conv, turn),
        }, 'Judge again') : null),
      ids.length ? h('details', { class: 'route-candidates' }, h('summary', { class: 'muted small' }, `candidates (${ids.length})`),
        h('ul', { class: 'small' }, ids.map((id) => h('li', {}, h('code', {}, id))))) : null);
  }

  function turnActions(conv, turn) {
    const runner = app().state.runner;
    const answered = MC.conv.answeredLanes(turn).length;
    const busy = runner.isBusy(turn.id);
    const cfg = app().state.settings.get();
    return h('div', { class: 'turn-actions', dataset: { actions: turn.id } },
      h('button', {
        class: 'ghost small', disabled: busy || answered < 1, title: answered < 1 ? 'Needs at least one finished answer' : 'Summarize the answers',
        onclick: () => runner.runTldr(conv, turn.id, cfg.summaryModel),
      }, 'TL;DR'),
      h('button', {
        class: 'ghost small', disabled: busy || answered < 2, title: answered < 2 ? 'Needs at least two finished answers' : 'Merge the answers by topic',
        onclick: () => runner.runFusion(conv, turn.id, cfg.fusionModel),
      }, 'Fusion'),
      h('button', { class: 'ghost small', title: 'Copy this chat up to here into a new chat', onclick: () => app().forkAt(turn.index) }, '⑂ Fork from here'));
  }

  function turnEl(conv, turn, lanes) {
    return h('section', { class: 'turn', dataset: { turn: turn.id } },
      promptRow(conv, turn),
      routeBar(conv, turn),
      h('div', { class: 'lanes grid', style: `--cols:${lanes.length}` }, lanes.map((l, i) => cell(conv, turn, l, i))),
      turnActions(conv, turn),
      h('div', { class: 'derived', dataset: { derived: turn.id } }, MC.ui.derived ? MC.ui.derived.render(conv, turn) : null));
  }

  // ---------- public ----------
  function nearBottom(root) { return root.scrollHeight - root.scrollTop - root.clientHeight < 120; }

  // Text typed into inline reply boxes, keyed by cell, survives full re-renders.
  function saveDrafts(root) {
    const drafts = {};
    let focused = null;
    root.querySelectorAll('.inline-reply').forEach((ta) => {
      const key = ta.closest('[data-cell]').dataset.cell;
      if (ta.value) drafts[key] = ta.value;
      if (ta === document.activeElement) focused = key;
    });
    return { drafts, focused };
  }

  function restoreDrafts(root, { drafts, focused }) {
    root.querySelectorAll('.inline-reply').forEach((ta) => {
      const key = ta.closest('[data-cell]').dataset.cell;
      if (drafts[key]) { ta.value = drafts[key]; ta.dispatchEvent(new Event('input')); }
      if (key === focused) ta.focus();
    });
  }

  function render(conv) {
    const root = document.getElementById('chat');
    const stick = nearBottom(root);
    const kept = saveDrafts(root);
    clear(root);
    view.pending.clear();
    if (!app().state.settings.getKey()) { firstRun(root); return; }
    root.append(MC.ui.presets.chip());
    if (!conv || !conv.turns.length) { emptyState(root); return; }
    const lanes = visibleLanes(conv);
    if (view.activeCol >= lanes.length) view.activeCol = 0;
    root.append(laneBar(conv, lanes), h('div', { class: 'turns' }, conv.turns.map((t) => turnEl(conv, t, lanes))));
    restoreDrafts(root, kept);
    if (stick) root.scrollTop = root.scrollHeight;
  }

  function flush() {
    view.raf = 0;
    const root = document.getElementById('chat');
    const stick = nearBottom(root);
    for (const [key, { conv, turnId, laneId }] of view.pending) {
      const el = root.querySelector(`[data-cell="${key}"]`);
      const turn = MC.conv.turnById(conv, turnId);
      const lanes = visibleLanes(conv);
      const col = lanes.findIndex((l) => l.id === laneId);
      if (!el || !turn || col < 0) { render(conv); return; }
      const r = turn.responses[laneId];
      if (r.status === 'streaming' && el.classList.contains('status-streaming')) {
        el.querySelector('.md').innerHTML = MC.md.render(r.content);
      } else {
        el.replaceWith(cell(conv, turn, lanes[col], col));
        const actions = root.querySelector(`[data-actions="${turnId}"]`);
        if (actions) actions.replaceWith(turnActions(conv, turn));
        const bar = root.querySelector('.lane-bar');
        if (bar) bar.replaceWith(laneBar(conv, lanes));
        const routeEl = root.querySelector(`[data-route="${turnId}"]`);
        if (routeEl) {
          const next = routeBar(conv, turn);
          const open = routeEl.querySelector('details[open]');
          if (open && next.querySelector('details')) next.querySelector('details').open = true;
          routeEl.replaceWith(next);
        }
      }
      MC.ui.fullscreen.update(conv, turnId, laneId);
      if (isMobile() && col !== view.activeCol) {
        view.unread.add(laneId);
        const head = root.querySelector(`.lane-head[data-lane="${laneId}"]`);
        if (head) head.classList.add('unread');
      }
    }
    view.pending.clear();
    if (stick) root.scrollTop = root.scrollHeight;
  }

  function updateCell(conv, turnId, laneId) {
    view.pending.set(turnId + ':' + laneId, { conv, turnId, laneId });
    if (!view.raf) view.raf = requestAnimationFrame(flush);
  }

  function updateDerived(conv, turnId) {
    const el = document.querySelector(`#chat [data-derived="${turnId}"]`);
    const turn = MC.conv.turnById(conv, turnId);
    if (!el || !turn) { render(conv); return; }
    MC.dom.append(clear(el), [MC.ui.derived.render(conv, turn)]);
    const actions = document.querySelector(`#chat [data-actions="${turnId}"]`);
    if (actions) actions.replaceWith(turnActions(conv, turn));
    const routeEl = document.querySelector(`#chat [data-route="${turnId}"]`);
    if (routeEl) {
      const next = routeBar(conv, turn);
      const open = routeEl.querySelector('details[open]');
      if (open && next.querySelector('details')) next.querySelector('details').open = true;
      routeEl.replaceWith(next);
    }
    if (turn.judge && turn.judge.status !== 'streaming') {
      const lanes = visibleLanes(conv);
      lanes.forEach((l, i) => {
        const cellEl = document.querySelector(`#chat [data-cell="${turnId}:${l.id}"]`);
        if (cellEl && !cellEl.classList.contains('status-streaming') && !cellEl.querySelector('.inline-reply textarea')) cellEl.replaceWith(cell(conv, turn, l, i));
      });
    }
  }

  function focusLane(i) {
    const conv = app().state.conv;
    const lane = conv && visibleLanes(conv)[i];
    if (!lane) return;
    if (isMobile()) setActiveCol(i);
    const boxes = [...document.querySelectorAll(`#chat [data-cell$=":${lane.id}"] .inline-reply`)];
    const box = boxes[boxes.length - 1];
    if (box) { box.focus(); box.scrollIntoView({ block: 'nearest' }); }
    else MC.ui.composer.setTarget(lane.id);
  }

  function bindSwipe() {
    const root = document.getElementById('chat');
    let start = null;
    root.addEventListener('pointerdown', (e) => { if (isMobile()) start = { x: e.clientX, y: e.clientY }; });
    root.addEventListener('pointerup', (e) => {
      if (!start || !app().state.conv) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
        const n = visibleLanes(app().state.conv).length;
        setActiveCol(Math.max(0, Math.min(n - 1, view.activeCol + (dx < 0 ? 1 : -1))));
      }
    });
  }
  document.addEventListener('DOMContentLoaded', bindSwipe);
  // Re-render only when crossing the mobile breakpoint (mobile keyboards fire resize too).
  let wasMobile = null;
  window.addEventListener('resize', U.debounce(() => {
    const m = isMobile();
    if (wasMobile !== null && m !== wasMobile && app() && app().state.conv) render(app().state.conv);
    wasMobile = m;
  }, 200));

  MC.ui = MC.ui || {};
  MC.ui.chat = { render, updateCell, updateDerived, focusLane, setActiveCol, visibleLanes };
})(window.MC);
