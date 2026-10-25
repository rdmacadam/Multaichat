/* MC.app — application state and wiring between storage, runner and UI. */
(function (MC) {
  'use strict';
  const { h, clear, toast, shortName, isTyping } = MC.dom;

  const state = { settings: null, store: null, models: [], modelsInfo: null, metas: [], conv: null, runner: null };

  function modelById(id) { return state.models.find((m) => m.id === id); }
  function cfg() { return state.settings.get(); }

  const refreshMetas = MC.util.throttle(async () => {
    state.metas = await state.store.list();
    MC.ui.sidebar.render(state.metas, state.conv && state.conv.id);
  }, 800);

  async function save(conv) {
    try { await state.store.put(conv); } catch (e) { toast('Could not save: ' + e.message, 'error'); }
    refreshMetas();
  }

  function onChange(conv, info) {
    if (conv !== state.conv) return;
    if (info.laneId) MC.ui.chat.updateCell(conv, info.turnId, info.laneId);
    else if (info.derived) MC.ui.chat.updateDerived(conv, info.turnId);
    else MC.ui.chat.render(conv);
    MC.ui.composer.update();
  }

  // ---------- header ----------
  function renderHeader() {
    const bar = clear(document.getElementById('topbar'));
    const conv = state.conv;
    const chips = conv
      ? conv.lanes.filter((l) => l.active).map((l) => ({ id: l.modelId, name: l.modelName, laneId: l.id }))
      : cfg().selected.map((id) => ({ id, name: (modelById(id) || { name: id }).name }));
    const quick = h('div', { class: 'quick-add' });
    MC.ui.picker.mountQuickAdd(quick, (id) => addModel(id));
    bar.append(
      h('button', { class: 'icon', id: 'toggle-sidebar', 'aria-label': 'Toggle sidebar', onclick: () => document.body.classList.toggle(window.matchMedia('(max-width: 800px)').matches ? 'side-open' : 'side-hidden') }, '☰'),
      h('div', { class: 'brand' }, 'Multaichat'),
      h('div', { class: 'chips', role: 'list' },
        chips.map((c) => h('span', { class: 'chip', role: 'listitem', title: c.id },
          shortName(c.name),
          h('button', { class: 'chip-x', 'aria-label': 'Remove ' + shortName(c.name), onclick: () => removeModel(c.id) }, '×'))),
        quick),
      h('button', { class: 'ghost', title: 'Choose models (/)', onclick: () => openModelPicker() }, 'Models'),
      h('button', { class: 'icon', 'aria-label': 'Settings', title: 'Settings', onclick: () => MC.ui.settings.open() }, '⚙'));
  }

  function refresh() {
    renderHeader();
    MC.ui.chat.render(state.conv);
    MC.ui.composer.update();
    MC.ui.sidebar.render(state.metas, state.conv && state.conv.id);
  }

  // ---------- models ----------
  function currentModelIds() {
    return state.conv ? state.conv.lanes.filter((l) => l.active).map((l) => l.modelId) : cfg().selected;
  }

  function openModelPicker() {
    MC.ui.picker.open({ mode: 'select', selected: currentModelIds(), onDone: (ids) => setSelection(ids) });
  }

  function setSelection(ids) {
    state.settings.set({ selected: ids });
    const conv = state.conv;
    if (conv) {
      for (const l of conv.lanes) if (l.active && !ids.includes(l.modelId)) MC.conv.removeLane(conv, l.id);
      for (const id of ids) {
        const existing = conv.lanes.find((l) => l.modelId === id);
        if (existing) existing.active = true;
        else MC.conv.addLane(conv, { id, name: (modelById(id) || { name: id }).name });
      }
      save(conv);
    }
    refresh();
  }

  function addModel(id) {
    const ids = currentModelIds();
    if (!ids.includes(id)) setSelection(ids.concat(id));
  }

  function removeModel(id) { setSelection(currentModelIds().filter((x) => x !== id)); }

  async function refreshModels(force) {
    const info = await MC.models.loadCached({ fetchModelsFn: () => MC.api.fetchModels(), force });
    state.models = info.models;
    state.modelsInfo = info;
    const r = MC.models.reconcileSelection(cfg(), state.models);
    state.settings.set(r.settings);
    if (r.dropped.length) toast('No longer available: ' + r.dropped.join(', '), 'warn');
    if (info.source === 'fallback') toast('Could not load the model list — showing a small built-in list', 'warn');
    return info;
  }

  // ---------- conversations ----------
  function ensureConv() {
    if (state.conv) return state.conv;
    const ids = cfg().selected;
    state.conv = MC.conv.create(ids.map((id) => ({ id, name: (modelById(id) || { name: id }).name })));
    return state.conv;
  }

  async function sendTurn(kind, inputs) {
    const conv = state.conv;
    const turn = await state.runner.send(conv, kind, inputs);
    autoDerive(conv, turn);
    return turn;
  }

  function sendBroadcast(text) {
    if (!cfg().selected.length && !state.conv) { toast('Pick at least one model first', 'warn'); openModelPicker(); return; }
    const conv = ensureConv();
    const inputs = MC.conv.broadcastInputs(conv, text);
    if (!Object.keys(inputs).length) { toast('All models were removed — add one first', 'warn'); return; }
    const p = sendTurn('broadcast', inputs);
    refresh();
    return p;
  }

  function sendTargeted(laneId, text) { return sendTurn('targeted', { [laneId]: text }); }
  function sendBatch(inputs) { return sendTurn('clarify-batch', inputs); }

  async function autoDerive(conv, turn) {
    const c = cfg();
    const answered = MC.conv.answeredLanes(turn).length;
    if (c.autoTldr && answered >= 1 && c.summaryModel) await state.runner.runTldr(conv, turn.id, c.summaryModel);
    if (c.autoFusion && answered >= 2 && c.fusionModel) await state.runner.runFusion(conv, turn.id, c.fusionModel);
  }

  async function openConversation(id) {
    const conv = await state.store.get(id);
    if (!conv) { toast('Conversation not found', 'error'); return; }
    if (MC.conv.recoverInterrupted(conv)) await state.store.put(conv);
    state.conv = conv;
    document.body.classList.remove('side-open');
    refresh();
  }

  function newChat() {
    state.conv = null;
    document.body.classList.remove('side-open');
    refresh();
    MC.ui.composer.focus();
  }

  async function deleteConversation(id) {
    await state.store.delete(id);
    if (state.conv && state.conv.id === id) state.conv = null;
    state.metas = await state.store.list();
    refresh();
  }

  async function renameConversation(id, title) {
    const conv = state.conv && state.conv.id === id ? state.conv : await state.store.get(id);
    if (!conv) return;
    conv.title = title;
    MC.conv.touch(conv);
    await state.store.put(conv);
    state.metas = await state.store.list();
    refresh();
  }

  async function importConversations(text) {
    const existing = await state.store.all();
    const merged = MC.storage.importJson(text, existing);
    const before = new Map(existing.map((c) => [c.id, c.updatedAt]));
    let n = 0;
    for (const c of merged) {
      if (before.get(c.id) !== c.updatedAt) { await state.store.put(c); n++; }
    }
    state.metas = await state.store.list();
    refresh();
    return n;
  }

  async function forkAt(turnIndex, onlyLaneId) {
    const f = MC.conv.fork(state.conv, turnIndex, { onlyLaneId });
    await state.store.put(f);
    state.conv = f;
    state.metas = await state.store.list();
    refresh();
    toast(onlyLaneId ? 'Continuing with one model in a new chat' : 'Forked into a new chat');
  }

  // ---------- startup ----------
  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const k = e.key;
      if ((k === 'k' || k === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openModelPicker(); return; }
      if (k === '/' && !isTyping(document.activeElement) && !document.querySelector('dialog[open]')) { e.preventDefault(); openModelPicker(); return; }
      if (e.altKey && /^[1-9]$/.test(k) && state.conv) { e.preventDefault(); MC.ui.chat.focusLane(Number(k) - 1); }
      if (k === 'Escape' && state.runner.isBusy() && !document.querySelector('dialog[open]')) state.runner.stopAll();
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) { const code = btn.parentElement.querySelector('code'); if (code) MC.dom.copyText(code.textContent); }
    });
  }

  async function start() {
    state.settings = MC.storage.createSettings();
    MC.ui.settings.applyTheme(cfg().theme);
    state.store = await MC.storage.openStore();
    if (state.store.kind === 'local') toast('Browser database unavailable — history stored in limited local storage', 'warn', 8000);
    state.runner = MC.runner.createRunner({ getKey: () => state.settings.getKey(), save, onChange });
    bindGlobalKeys();
    MC.ui.composer.mount();
    await refreshModels(false);
    state.metas = await state.store.list();
    if (state.metas.length) {
      const conv = await state.store.get(state.metas[0].id);
      if (conv && MC.conv.recoverInterrupted(conv)) await state.store.put(conv);
      state.conv = conv || null;
    }
    refresh();
    document.body.classList.add('ready');
  }

  MC.app = {
    state, start, refresh, modelById, refreshModels, openModelPicker, setSelection, addModel, removeModel,
    sendBroadcast, sendTargeted, sendBatch, openConversation, newChat, deleteConversation, renameConversation,
    importConversations, forkAt, save, ensureConv,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window.MC);
