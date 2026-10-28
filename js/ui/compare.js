/* Compare view: one column per model, each holding that model's own thread
   and scrolling on its own. Desktop only; chat.js decides when it is shown. */
(function (MC) {
  'use strict';
  const { h, shortName, copyText } = MC.dom;
  const chat = () => MC.ui.chat;

  function answerBody(r) {
    if (r.content) return MC.md.render(r.content);
    return r.status === 'streaming' ? '<p class="muted">…</p>' : '';
  }

  function answerEl(conv, turn, lane) {
    const r = turn.responses[lane.id];
    const actions = [h('button', { class: 'icon small fs-open', 'aria-label': 'Fullscreen ' + shortName(lane.modelName), title: 'Fullscreen', onclick: () => MC.ui.fullscreen.open(conv, turn.id, lane.id) }, '⤢')];
    if (r.content) actions.push(h('button', { class: 'ghost small', onclick: () => copyText(r.content) }, 'Copy'));
    if (lane.active && r.status !== 'streaming') actions.push(h('button', { class: 'ghost small', title: 'Send your next message to this model only', onclick: () => MC.ui.composer.setTarget(lane.id) }, '↳ Reply'));
    return h('div', { class: 'col-answer status-' + r.status, dataset: { answer: turn.id + ':' + lane.id } },
      h('div', { class: 'md', html: answerBody(r) }),
      r.status === 'stopped' ? h('span', { class: 'muted small' }, 'stopped') : null,
      r.servedModel ? h('div', { class: 'served muted small', title: r.servedModel }, '→ answered by ' + r.servedModel.split('/').pop()) : null,
      r.status === 'error' ? h('div', { class: 'cell-error', role: 'alert' }, '⚠ ', r.error || 'Error') : null,
      h('div', { class: 'col-actions' }, actions));
  }

  function column(conv, lane, i, onlyOne) {
    const turns = conv.turns.filter((t) => lane.id in t.inputs && t.responses[lane.id]);
    return h('section', { class: 'compare-col', dataset: { lane: lane.id } },
      h('div', { class: 'col-head' },
        h('span', { class: 'lane-num' }, String(i + 1)),
        h('span', { class: 'lane-name', title: lane.modelId }, shortName(lane.modelName)),
        lane.active ? null : h('span', { class: 'muted small' }, 'removed'),
        h('button', {
          class: 'icon small lane-hide', 'aria-label': 'Hide ' + shortName(lane.modelName),
          title: onlyOne ? 'At least one model stays visible' : 'Hide this model', disabled: onlyOne,
          onclick: () => MC.app.toggleLaneHidden(lane.id),
        }, '👁')),
      h('div', { class: 'col-body' }, turns.map((t) => h('div', { class: 'col-turn' },
        h('button', { class: 'msg-mark', dataset: { turn: t.id }, title: 'Line up all columns at this message', onclick: () => MC.ui.compare.alignTo(t.id) }, 'Message ' + (t.index + 1)),
        h('div', { class: 'col-input' },
          (t.attachments || []).length ? h('div', { class: 'att-row' }, t.attachments.map(chat().attachmentEl)) : null,
          chat().displayText(t.inputs[lane.id]) || null),
        answerEl(conv, t, lane)))));
  }

  // Visible lanes minus the ones hidden in this chat. Ids of lanes that no
  // longer exist are ignored, and hiding never leaves zero columns.
  function visibleColumns(conv) {
    const lanes = chat().visibleLanes(conv);
    const hidden = new Set(conv.hiddenLanes || []);
    const shown = lanes.filter((l) => !hidden.has(l.id));
    return shown.length ? shown : lanes;
  }

  function hiddenList(conv) {
    const shown = new Set(visibleColumns(conv).map((l) => l.id));
    const hidden = chat().visibleLanes(conv).filter((l) => !shown.has(l.id));
    if (!hidden.length) return null;
    return h('div', { class: 'hidden-list' }, h('span', { class: 'muted small' }, 'Hidden:'),
      hidden.map((l) => h('span', { class: 'chip hidden-chip' }, shortName(l.modelName),
        h('button', { class: 'chip-x', 'aria-label': 'Show ' + shortName(l.modelName), title: 'Show again', onclick: () => MC.app.toggleLaneHidden(l.id) }, 'show'))));
  }

  // Scroll position per chat and lane: { top, bottom } where bottom means the
  // column was (near) its end and should follow new text.
  const scrolls = new Map();
  const NEAR = 120;
  const atBottom = (b) => b.scrollHeight - b.scrollTop - b.clientHeight < NEAR;
  const key = (conv, laneId) => conv.id + ':' + laneId;

  function remember(conv, body, laneId) {
    scrolls.set(key(conv, laneId), { top: body.scrollTop, bottom: atBottom(body) });
  }

  function restore(conv, body, laneId) {
    const s = scrolls.get(key(conv, laneId));
    body.scrollTop = !s || s.bottom ? body.scrollHeight : s.top;
  }

  function render(conv, root) {
    const list = hiddenList(conv);
    const bar = root.querySelector('.view-bar');
    if (list && bar) bar.append(list);
    const cols = visibleColumns(conv);
    root.append(h('div', { class: 'compare' }, cols.map((l, i) => column(conv, l, i, cols.length === 1))));
    root.querySelectorAll('.compare-col').forEach((col) => {
      const body = col.querySelector('.col-body');
      const laneId = col.dataset.lane;
      restore(conv, body, laneId);
      body.addEventListener('scroll', () => remember(conv, body, laneId), { passive: true });
    });
  }

  // Scrolls every column so its marker for turnId is at the top; a column
  // without that message goes to its latest earlier one (or the top).
  function alignTo(turnId) {
    const conv = MC.app.state.conv;
    const target = conv && MC.conv.turnById(conv, turnId);
    if (!target) return;
    document.querySelectorAll('#chat .compare-col .col-body').forEach((body) => {
      const marks = [...body.querySelectorAll('.msg-mark')].filter((m) => {
        const t = MC.conv.turnById(conv, m.dataset.turn);
        return t && t.index <= target.index;
      });
      const mark = marks[marks.length - 1];
      body.scrollTop = mark ? body.scrollTop + mark.getBoundingClientRect().top - body.getBoundingClientRect().top : 0;
    });
  }

  function updateCell(conv, turnId, laneId) {
    const root = document.getElementById('chat');
    const el = root.querySelector(`.col-answer[data-answer="${turnId}:${laneId}"]`);
    const turn = MC.conv.turnById(conv, turnId);
    const lane = MC.conv.laneById(conv, laneId);
    if (!turn || !lane) return;
    // Hidden columns have nothing to update; only rebuild when a visible
    // column is missing this answer (e.g. a new turn).
    if (!el) { if (visibleColumns(conv).some((l) => l.id === laneId)) chat().render(conv); return; }
    const r = turn.responses[laneId];
    const body = el.closest('.col-body');
    const follow = body && atBottom(body);
    if (r.status === 'streaming' && el.classList.contains('status-streaming')) el.querySelector('.md').innerHTML = answerBody(r);
    else el.replaceWith(answerEl(conv, turn, lane));
    if (follow) body.scrollTop = body.scrollHeight;
  }

  MC.ui = MC.ui || {};
  MC.ui.compare = { render, updateCell, alignTo, visibleColumns };
})(window.MC);
