/* Fullscreen answer: one model's answer at reading width, with ←/→ to flip
   through the other models' answers to the same message. */
(function (MC) {
  'use strict';
  const { h, clear, shortName, openDialog, closeDialog, copyText } = MC.dom;
  const U = MC.util;

  const view = { conv: null, turnId: null, laneId: null };
  const dlg = () => document.getElementById('answer-dialog');

  // Lanes that were asked in this turn, in column order.
  function askedLanes(conv, turn) {
    return MC.ui.chat.visibleLanes(conv).filter((l) => l.id in turn.inputs);
  }

  function current() {
    const turn = view.conv && MC.conv.turnById(view.conv, view.turnId);
    if (!turn) return null;
    const lanes = askedLanes(view.conv, turn);
    const i = lanes.findIndex((l) => l.id === view.laneId);
    return i < 0 ? null : { turn, lanes, i, lane: lanes[i], r: turn.responses[view.laneId] };
  }

  function bodyHtml(r) {
    if (r && r.content) return MC.md.render(r.content);
    if (r && r.status === 'streaming') return '<p class="muted">…</p>';
    return MC.md.render((r && r.error) || '');
  }

  function render() {
    const c = current();
    const el = dlg();
    if (!c) { closeDialog(el); return; }
    const { turn, lanes, i, lane, r } = c;
    const usage = r && r.usage;
    const meta = [];
    if (r && r.status === 'streaming') meta.push('answering…');
    if (usage) meta.push(U.formatTokens((usage.promptTokens || 0) + (usage.completionTokens || 0)) + ' tok');
    if (usage && usage.cost != null) meta.push(U.formatCost(usage.cost));
    clear(el);
    el.append(h('div', { class: 'fs' },
      h('header', { class: 'fs-head' },
        h('div', {},
          h('div', { class: 'fs-model' }, shortName(lane.modelName)),
          h('div', { class: 'muted small' }, `Message ${turn.index + 1}`, meta.length ? ' · ' + meta.join(' · ') : '')),
        h('button', { class: 'icon', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => closeDialog(el) }, '✕')),
      h('div', { class: 'fs-body' }, h('div', { class: 'md', html: bodyHtml(r) })),
      h('footer', { class: 'fs-foot' },
        h('button', { class: 'ghost fs-prev', disabled: lanes.length < 2, title: 'Previous model (←)', onclick: () => step(-1) }, '← Previous'),
        h('span', { class: 'fs-pos muted small' }, `${i + 1} / ${lanes.length}`),
        h('button', { class: 'ghost fs-next', disabled: lanes.length < 2, title: 'Next model (→)', onclick: () => step(1) }, 'Next →'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', disabled: !(r && r.content), onclick: () => copyText(r.content) }, 'Copy'))));
  }

  function step(d) {
    const c = current();
    if (!c) return;
    view.laneId = c.lanes[(c.i + d + c.lanes.length) % c.lanes.length].id;
    render();
    const body = dlg().querySelector('.fs-body');
    if (body) body.scrollTop = 0;
  }

  function open(conv, turnId, laneId) {
    Object.assign(view, { conv, turnId, laneId });
    render();
    openDialog(dlg());
  }

  // Called when a cell changes; keeps an open view of that answer live.
  function update(conv, turnId, laneId) {
    if (!dlg() || !dlg().open || view.conv !== conv || view.turnId !== turnId || view.laneId !== laneId) return;
    const c = current();
    const md = dlg().querySelector('.fs-body .md');
    if (c && md && c.r && c.r.status === 'streaming' && c.r.content) md.innerHTML = MC.md.render(c.r.content);
    else render();
  }

  document.addEventListener('keydown', (e) => {
    const el = dlg();
    if (!el || !el.open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });

  MC.ui = MC.ui || {};
  MC.ui.fullscreen = { open, update };
})(window.MC);
