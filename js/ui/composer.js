/* Bottom composer: sends to every model by default, or to one model when a
   target chip is set. Also hosts the "Answer them together" banner/panel. */
(function (MC) {
  'use strict';
  const { h, clear, shortName, openDialog, closeDialog, autoGrow, toast } = MC.dom;
  const app = () => MC.app;

  const view = { target: null, ta: null, chip: null, send: null, stop: null, banner: null, fit: null, files: [], tray: null };

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

  // ---------- attachments ----------
  function addFiles(list) {
    const files = [...list].filter(Boolean);
    if (!files.length) return;
    const check = MC.attach.validate(view.files.concat(files));
    if (!check.ok) { toast(check.error, 'warn'); return; }
    view.files = view.files.concat(files);
    renderTray();
  }

  function renderTray() {
    clear(view.tray);
    view.tray.hidden = !view.files.length;
    view.files.forEach((f, i) => {
      const kind = MC.attach.classify(f);
      const remove = h('button', { class: 'chip-x', 'aria-label': 'Remove ' + f.name, onclick: () => { view.files.splice(i, 1); renderTray(); } }, '✕');
      const label = h('span', { class: 'att-name' }, f.name, h('span', { class: 'muted small' }, ' · ' + formatSize(f.size)));
      const thumb = kind === 'image' ? h('img', { class: 'att-mini', alt: '', src: URL.createObjectURL(f) }) : h('span', { 'aria-hidden': 'true' }, '📄');
      view.tray.append(h('span', { class: 'att-chip', title: f.name }, thumb, label, remove));
    });
  }

  function formatSize(n) {
    return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  // Resolves to {choice: 'skip'|'text', remember} or null when cancelled.
  function askCapability(modelNames) {
    const dlg = document.getElementById('attach-dialog');
    clear(dlg);
    return new Promise((resolve) => {
      const remember = h('input', { type: 'checkbox' });
      let done = false;
      const finish = (choice) => {
        if (done) return;
        done = true;
        closeDialog(dlg);
        resolve(choice ? { choice, remember: remember.checked } : null);
      };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }, { once: true });
      dlg.append(h('div', { class: 'dialog-body' },
        h('header', { class: 'dialog-head' }, h('h2', {}, "Some models can't read images")),
        h('p', {}, modelNames.join(', ') + " can't read images. Skip them for this message, or send them the text only?"),
        h('label', { class: 'check' }, remember, ' Remember for this chat'),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'ghost', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'ghost', onclick: () => finish('text') }, 'Send text only'),
          h('button', { class: 'primary', onclick: () => finish('skip') }, 'Skip them'))));
      openDialog(dlg);
    });
  }

  async function submit() {
    const text = view.ta.value.trim();
    if ((!text && !view.files.length) || busy()) return;
    if (!app().state.settings.getKey()) { toast('Add your OpenRouter API key first', 'warn'); MC.ui.settings.open(); return; }
    if (view.files.length) {
      const target = view.target;
      const ok = await app().sendWithAttachments(text, view.files.slice(), target);
      if (!ok) return; // keep text and chips
      view.files = [];
      renderTray();
      view.ta.value = '';
      view.fit();
      view.target = null;
      renderChip();
      update();
      return;
    }
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
    view.tray = h('div', { class: 'att-tray', hidden: true });
    const input = h('input', { type: 'file', class: 'attach-input', multiple: true, hidden: true,
      accept: 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,' + MC.attach.TEXT_EXT.map((x) => '.' + x).join(',') });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    const clip = h('button', { class: 'icon attach-btn', title: 'Attach images, PDFs or text files', 'aria-label': 'Attach files', onclick: () => input.click() }, '📎');
    root.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); root.classList.add('dragging'); } });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('dragging'); });
    root.addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('dragging'); addFiles(e.dataTransfer.files); });
    root.addEventListener('paste', (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    root.append(view.banner, h('div', { class: 'composer-row' }, clip, input,
      h('div', { class: 'composer-input' }, view.chip, view.tray, view.ta), view.send, view.stop));
    renderChip();
  }

  function focus() { if (view.ta) view.ta.focus(); }

  function insertTemplate(text) {
    if (!view.ta || !text) return;
    view.ta.value = view.ta.value.trim() ? view.ta.value.replace(/\s*$/, '') + '\n' + text : text;
    view.fit();
    focus();
  }

  function getText() { return view.ta ? view.ta.value : ''; }

  MC.ui = MC.ui || {};
  MC.ui.composer = { mount, update, setTarget, focus, openBatch, insertTemplate, getText, askCapability };
})(window.MC);
