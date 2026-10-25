/* Bottom composer: sends to every model by default, or to one model when a
   target chip is set. Also hosts the "Answer them together" banner/panel. */
(function (MC) {
  'use strict';
  const { h, clear, shortName, openDialog, closeDialog, autoGrow, toast } = MC.dom;
  const app = () => MC.app;

  const view = { target: null, ta: null, chip: null, send: null, stop: null, banner: null, fit: null };

  function lane(id) { const c = app().state.conv; return c && MC.conv.laneById(c, id); }

  function setTarget(laneId) {
    const l = laneId && lane(laneId);
    view.target = l && l.active ? laneId : null;
    renderChip();
    focus();
  }

  function renderChip() {
    clear(view.chip);
    const l = view.target && lane(view.target);
    if (!l) { view.chip.hidden = true; view.ta.placeholder = 'Ask all models…  (Enter to send, Shift+Enter for a new line)'; return; }
    view.chip.hidden = false;
    view.chip.append(h('span', {}, `↳ to ${shortName(l.modelName)} only`),
      h('button', { class: 'chip-x', 'aria-label': 'Send to all models instead', onclick: () => setTarget(null) }, '✕'));
    view.ta.placeholder = `Message ${shortName(l.modelName)} only…`;
  }

  function busy() { return app().state.runner && app().state.runner.isBusy(); }

  function submit() {
    const text = view.ta.value.trim();
    if (!text || busy()) return;
    if (!app().state.settings.getKey()) { toast('Add your OpenRouter API key first', 'warn'); MC.ui.settings.open(); return; }
    view.ta.value = '';
    view.fit();
    const target = view.target;
    view.target = null;
    renderChip();
    if (target) app().sendTargeted(target, text);
    else app().sendBroadcast(text);
    update();
  }

  function askingLanes() {
    const conv = app().state.conv;
    if (!conv || !conv.turns.length) return [];
    const t = conv.turns[conv.turns.length - 1];
    return conv.lanes.filter((l) => l.active && t.responses[l.id] && t.responses[l.id].status === 'done' && t.responses[l.id].asksQuestion)
      .map((l) => ({ lane: l, question: t.responses[l.id].question }));
  }

  function update() {
    if (!view.ta) return;
    const b = busy();
    view.send.hidden = b;
    view.stop.hidden = !b;
    if (view.target && !(lane(view.target) || {}).active) { view.target = null; renderChip(); }
    const asking = b ? [] : askingLanes();
    clear(view.banner);
    view.banner.hidden = asking.length < 2;
    if (asking.length >= 2) {
      view.banner.append(h('span', {}, `${asking.length} models asked you questions`),
        h('button', { class: 'primary small', onclick: openBatch }, 'Answer them together'));
    }
  }

  function openBatch() {
    const conv = app().state.conv;
    const asking = askingLanes();
    const others = conv.lanes.filter((l) => l.active && !asking.some((a) => a.lane.id === l.id));
    const dlg = document.getElementById('batch-dialog');
    clear(dlg);
    const boxes = asking.map(({ lane: l, question }) => {
      const ta = h('textarea', { rows: 2, 'aria-label': `Answer for ${shortName(l.modelName)}` });
      autoGrow(ta, 200);
      return { lane: l, question, ta };
    });
    const same = h('input', { type: 'checkbox' });
    const alsoOthers = h('input', { type: 'checkbox' });
    const mirror = () => { if (same.checked) boxes.slice(1).forEach((b) => { b.ta.value = boxes[0].ta.value; }); };
    boxes[0].ta.addEventListener('input', mirror);
    same.addEventListener('change', () => { boxes.slice(1).forEach((b) => { b.ta.disabled = same.checked; }); mirror(); });

    let sent = false;
    const send = () => {
      if (sent) return;
      mirror();
      const inputs = {};
      for (const b of boxes) if (b.ta.value.trim()) inputs[b.lane.id] = b.ta.value.trim();
      if (!Object.keys(inputs).length) { boxes[0].ta.focus(); return; }
      if (alsoOthers.checked && others.length) {
        const text = "Answers to other models' questions:\n" + boxes.filter((b) => inputs[b.lane.id]).map((b) => `${shortName(b.lane.modelName)}: ${inputs[b.lane.id]}`).join('\n');
        others.forEach((l) => { inputs[l.id] = text; });
      }
      sent = true;
      closeDialog(dlg);
      app().sendBatch(inputs);
      update();
    };

    dlg.append(h('form', {
      class: 'dialog-body',
      onsubmit: (e) => { e.preventDefault(); send(); },
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } },
    },
      h('header', { class: 'dialog-head' }, h('h2', {}, 'Answer clarifying questions'), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => closeDialog(dlg) }, '✕')),
      boxes.map((b) => h('div', { class: 'batch-item' },
        h('div', { class: 'batch-q' }, h('strong', {}, shortName(b.lane.modelName) + ': '), `“${b.question}”`), b.ta)),
      h('label', { class: 'check' }, same, ' Same answer for all'),
      others.length ? h('label', { class: 'check' }, alsoOthers, ` Also send to models that didn't ask (${others.map((l) => shortName(l.modelName)).join(', ')})`) : null,
      h('footer', { class: 'dialog-foot' }, h('span', { class: 'muted small' }, 'Ctrl/⌘+Enter to send'), h('button', { type: 'submit', class: 'primary' }, 'Send'))));
    openDialog(dlg);
    boxes[0].ta.focus();
  }

  function mount() {
    const root = clear(document.getElementById('composer'));
    view.banner = h('div', { class: 'ask-banner', hidden: true, role: 'status' });
    view.chip = h('div', { class: 'target-chip', hidden: true });
    view.ta = h('textarea', { id: 'prompt', rows: 1, 'aria-label': 'Message' });
    view.fit = autoGrow(view.ta, 240);
    view.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') {
        // First Esc clears the "one model" target; with no target it stops all answers.
        if (view.target) setTarget(null);
        else if (busy()) app().state.runner.stopAll();
      }
    });
    view.send = h('button', { class: 'primary', onclick: submit, 'aria-label': 'Send' }, 'Send');
    view.stop = h('button', { class: 'danger', hidden: true, onclick: () => app().state.runner.stopAll() }, '■ Stop all');
    root.append(view.banner, h('div', { class: 'composer-row' }, h('div', { class: 'composer-input' }, view.chip, view.ta), view.send, view.stop));
    renderChip();
  }

  function focus() { if (view.ta) view.ta.focus(); }

  MC.ui = MC.ui || {};
  MC.ui.composer = { mount, update, setTarget, focus, openBatch };
})(window.MC);
