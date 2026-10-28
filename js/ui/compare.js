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

  function column(conv, lane, i) {
    const turns = conv.turns.filter((t) => lane.id in t.inputs && t.responses[lane.id]);
    return h('section', { class: 'compare-col', dataset: { lane: lane.id } },
      h('div', { class: 'col-head' },
        h('span', { class: 'lane-num' }, String(i + 1)),
        h('span', { class: 'lane-name', title: lane.modelId }, shortName(lane.modelName)),
        lane.active ? null : h('span', { class: 'muted small' }, 'removed')),
      h('div', { class: 'col-body' }, turns.map((t) => h('div', { class: 'col-turn' },
        h('button', { class: 'msg-mark', dataset: { turn: t.id }, title: 'Line up all columns at this message', onclick: () => MC.ui.compare.alignTo(t.id) }, 'Message ' + (t.index + 1)),
        h('div', { class: 'col-input' },
          (t.attachments || []).length ? h('div', { class: 'att-row' }, t.attachments.map(chat().attachmentEl)) : null,
          chat().displayText(t.inputs[lane.id]) || null),
        answerEl(conv, t, lane)))));
  }

  function columns(conv) { return chat().visibleLanes(conv); }

  function render(conv, root) {
    root.append(h('div', { class: 'compare' }, columns(conv).map((l, i) => column(conv, l, i))));
    root.querySelectorAll('.col-body').forEach((b) => { b.scrollTop = b.scrollHeight; });
  }

  function updateCell(conv, turnId, laneId) {
    const root = document.getElementById('chat');
    const el = root.querySelector(`.col-answer[data-answer="${turnId}:${laneId}"]`);
    const turn = MC.conv.turnById(conv, turnId);
    const lane = MC.conv.laneById(conv, laneId);
    if (!el || !turn || !lane) { chat().render(conv); return; }
    const r = turn.responses[laneId];
    if (r.status === 'streaming' && el.classList.contains('status-streaming')) el.querySelector('.md').innerHTML = answerBody(r);
    else el.replaceWith(answerEl(conv, turn, lane));
  }

  function alignTo() {}

  MC.ui = MC.ui || {};
  MC.ui.compare = { render, updateCell, alignTo };
})(window.MC);
