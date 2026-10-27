/* MC.app — application state and wiring between storage, runner and UI. */
(function (MC) {
  'use strict';
  const { h, clear, toast, shortName, isTyping } = MC.dom;

  const state = { settings: null, store: null, models: [], modelsInfo: null, deciders: [], metas: [], conv: null, runner: null, presets: null, routing: null,
    draft: {} }; // draft: system prompt chosen before the chat's first message
  const deleted = new Set(); // ids deleted while a request for them may still be in flight

  function modelById(id) { return state.models.find((m) => m.id === id); }
  function cfg() { return state.settings.get(); }

  const refreshMetas = MC.util.throttle(async () => {
    state.metas = await state.store.list();
    MC.ui.sidebar.update(state.metas, state.conv && state.conv.id);
  }, 800);

  async function save(conv) {
    if (deleted.has(conv.id)) return;
    try { await state.store.put(conv); } catch (e) { toast('Could not save: ' + e.message, 'error'); }
    refreshMetas();
  }

  function onChange(conv, info) {
    if (conv !== state.conv) return;
    if (info.laneId) MC.ui.chat.updateCell(conv, info.turnId, info.laneId);
    else if (info.derived) MC.ui.chat.updateDerived(conv, info.turnId);
    else MC.ui.chat.render(conv);
    MC.ui.composer.update();
    updateCostThrottled();
  }

  // ---------- chat cost counter ----------
  const COST_INFO = 'What this chat has cost so far: answers, earlier versions, router decisions, TL;DR, Fusion and judge.';
  const COST_LINES = [['answers', 'Answers'], ['earlier', 'Earlier versions'], ['router', 'Router decisions'], ['derived', 'TL;DR & Fusion'], ['judge', 'Judge']];

  function costView(conv) {
    const sum = MC.cost.summary(conv);
    const narrow = window.matchMedia('(max-width: 800px)').matches;
    let amount = sum.total === 0 ? '$0.00' : narrow ? '$' + sum.total.toFixed(2) : MC.util.formatCost(sum.total);
    if (sum.unknown > 0) amount = '≥ ' + amount;
    const lines = COST_LINES.filter(([k]) => sum.parts[k] > 0).map(([k, label]) => label + ': ' + MC.util.formatCost(sum.parts[k]));
    if (sum.unknown > 0) lines.push(sum.unknown + (sum.unknown === 1 ? ' request had no price' : ' requests had no price'));
    return { label: (narrow ? '' : 'Σ ') + amount, lines };
  }

  function updateCost() {
    const btn = document.getElementById('cost');
    if (!btn) return;
    const { label, lines } = costView(state.conv);
    const text = lines.length ? lines.join('\n') : 'No cost yet.';
    if (btn.textContent !== label) btn.textContent = label;
    btn.title = text.replace(/\n/g, ' · ');
    const tip = btn.parentElement.querySelector('.tip');
    if (tip && tip.dataset.lines !== text) {
      tip.dataset.lines = text;
      tip.textContent = COST_INFO + '\n\n' + text;
    }
  }
  const updateCostThrottled = MC.util.throttle(updateCost, 250);
  window.matchMedia('(max-width: 800px)').addEventListener('change', updateCost);

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
      h('button', { class: 'ghost', title: 'Presets: system prompt, template and models', onclick: () => MC.ui.presets.open() }, 'Presets'),
      h('button', { class: 'ghost router-btn', title: 'Router: let a decision model pick which models answer', onclick: () => MC.ui.router.open() }, MC.ui.router.label(cfg())),
      h('span', { class: 'cost-wrap' }, h('button', { class: 'ghost', id: 'cost', 'aria-label': 'Chat cost' }, 'Σ $0.00'), MC.dom.info(COST_INFO)),
      h('button', { class: 'icon', 'aria-label': 'Settings', title: 'Settings', onclick: () => MC.ui.settings.open() }, '⚙'));
  }

  function refresh() {
    renderHeader();
    updateCost();
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

  async function refreshDeciders(force) {
    const r = await MC.models.loadDeciders({ fetchDecidersFn: () => MC.api.fetchDeciders(), force });
    state.deciders = r.deciders;
    MC.ui.router.update();
    return r;
  }

  // Loads the chat models and, alongside, the decision models.
  async function refreshModels(force) {
    const [info] = await Promise.all([
      MC.models.loadCached({ fetchModelsFn: () => MC.api.fetchModels(), force }),
      refreshDeciders(force),
    ]);
    state.models = info.models;
    state.modelsInfo = info;
    if (info.source === 'fallback') {
      toast('Could not load the model list — showing a small built-in list', 'warn');
      // The tiny built-in list is no reason to drop the user's saved choices.
      if (cfg().selected.length) return info;
    }
    const r = MC.models.reconcileSelection(cfg(), state.models);
    state.settings.set(r.settings);
    if (r.dropped.length) toast('No longer available: ' + r.dropped.join(', '), 'warn');
    return info;
  }

  // ---------- conversations ----------
  function ensureConv() {
    if (state.conv) return state.conv;
    const ids = cfg().selected;
    state.conv = MC.conv.create(ids.map((id) => ({ id, name: (modelById(id) || { name: id }).name })));
    if (state.draft.systemPrompt) MC.conv.setSystemPrompt(state.conv, state.draft.systemPrompt, state.draft.presetId);
    state.draft = {};
    return state.conv;
  }

  // ---------- presets & system prompt ----------
  // The chat's prompt state: the conversation, or the draft before it exists.
  function promptHolder() { return state.conv || state.draft; }

  function setChatSystemPrompt(text, presetId) {
    if (state.conv) { MC.conv.setSystemPrompt(state.conv, text, presetId); save(state.conv); }
    else state.draft = text && text.trim() ? { systemPrompt: text, presetId } : {};
    refresh();
  }

  function applyPreset(id) {
    const preset = state.presets.get(id);
    if (!preset) return;
    const plan = MC.presets.applyPlan(preset, state.conv);
    if (plan.models) {
      const midChat = state.conv && state.conv.turns.length;
      if (!midChat) setSelection(plan.models);
      else if (plan.confirmModels && confirm('Also switch models to ' + plan.models.map((m) => shortName((modelById(m) || { name: m }).name)).join(', ') + '?')) setSelection(plan.models);
    }
    if (plan.systemPrompt) setChatSystemPrompt(plan.systemPrompt, plan.presetId);
    if (plan.template) MC.ui.composer.insertTemplate(plan.template);
    refresh();
    if (plan.template) MC.ui.composer.focus();
  }

  function blockedByBusy() {
    if (!state.runner.isBusy()) return false;
    toast('Wait for the current answers to finish (or Stop all)', 'warn');
    return true;
  }

  async function sendTurn(kind, inputs, extra) {
    if (blockedByBusy()) return null;
    const conv = state.conv;
    const turn = await state.runner.send(conv, kind, inputs, extra);
    if (deleted.has(conv.id)) return turn;
    autoDerive(conv, turn);
    return turn;
  }

  function sendBroadcast(text) {
    if (blockedByBusy()) return;
    if (!cfg().selected.length && !state.conv) { toast('Pick at least one model first', 'warn'); openModelPicker(); return; }
    const conv = ensureConv();
    const inputs = MC.conv.broadcastInputs(conv, text);
    if (!Object.keys(inputs).length) { toast('All models were removed — add one first', 'warn'); return; }
    const p = sendTurn('broadcast', inputs);
    refresh();
    return p;
  }

  // Validates and reads files; null (after a toast) when they can't be sent.
  async function readAttachments(files) {
    const check = MC.attach.validate(files);
    if (!check.ok) { toast(check.error, 'warn'); return null; }
    let read;
    try { read = await Promise.all(files.map((f) => MC.files.read(f))); } catch (e) { toast(e.message, 'error'); return null; }
    return { refs: read.map((r) => r.ref), read };
  }

  async function storeAttachments(read) {
    try {
      for (const r of read) await state.store.putAttachment(r.record);
      return true;
    } catch (e) {
      toast('Could not save attachment: ' + e.message, 'error');
      return false;
    }
  }

  const textContentsOf = (read) => Object.fromEntries(read.filter((r) => r.ref.kind === 'text').map((r) => [r.ref.id, r.text]));

  // Sends a message with attachments to every active lane (or one target lane).
  // Resolves false (composer keeps its content) when cancelled or on errors.
  async function sendWithAttachments(text, files, targetLaneId) {
    if (blockedByBusy()) return false;
    if (!cfg().selected.length && !state.conv) { toast('Pick at least one model first', 'warn'); openModelPicker(); return false; }
    const att = await readAttachments(files);
    if (!att) return false;
    const { refs, read } = att;
    const conv = ensureConv();
    const lanes = conv.lanes.filter((l) => l.active && (!targetLaneId || l.id === targetLaneId));
    if (!lanes.length) { toast('All models were removed — add one first', 'warn'); return false; }
    const byId = Object.fromEntries(state.models.map((m) => [m.id, m]));
    const incapableIds = refs.some((r) => r.kind === 'image') ? MC.attach.incapable(lanes, byId) : [];
    let choice = null;
    if (incapableIds.length) {
      choice = conv.attachPolicy || null;
      if (!choice) {
        const names = lanes.filter((l) => incapableIds.includes(l.id)).map((l) => shortName(l.modelName));
        const answer = await MC.ui.composer.askCapability(names);
        if (!answer) return false;
        choice = answer.choice;
        if (answer.remember) conv.attachPolicy = choice;
      }
    }
    if (!await storeAttachments(read)) return false;
    const textContents = textContentsOf(read);
    const { inputs, delivery, skipped } = MC.attach.buildInputs({ text, refs, textContents, laneIds: lanes.map((l) => l.id), incapableIds, choice });
    if (!Object.keys(inputs).length) { toast('None of the selected models can read images', 'warn'); return false; }
    const p = sendTurn(targetLaneId ? 'targeted' : 'broadcast', inputs, { attachments: refs, delivery, skipped });
    refresh();
    p.catch(() => {});
    return true;
  }

  // ---------- routed sending (spec §5.9) ----------
  const CONTEXT_INPUTS = 3;
  const CONTEXT_CHARS = 300;

  // What the decision model learns about the chat so far: the last turn's
  // TL;DR, or else the last few user messages (each cut short).
  function contextNote(conv) {
    if (!conv || !conv.turns.length) return undefined;
    const last = conv.turns[conv.turns.length - 1];
    if (last.tldr && last.tldr.status === 'done' && last.tldr.content) return last.tldr.content;
    const lines = conv.turns.slice(-CONTEXT_INPUTS)
      .map((t) => String(Object.values(t.inputs)[0] || '').trim()).filter(Boolean)
      .map((s) => 'User: ' + (s.length > CONTEXT_CHARS ? s.slice(0, CONTEXT_CHARS) + '…' : s));
    return lines.length ? lines.join('\n') : undefined;
  }

  function isRouting() { return !!state.routing; }

  function abortRoute() { if (state.routing) state.routing.abort(); }

  // Lets the router pick the models for this message, then sends it to them.
  // Resolves false (composer keeps its content) when stopped, cancelled or on errors.
  async function sendRouted(text, files = []) {
    if (blockedByBusy() || state.routing) return false;
    let att = { refs: [], read: [] };
    if (files.length) { att = await readAttachments(files); if (!att) return false; }
    const { refs, read } = att;
    const images = Object.fromEntries(read.filter((r) => r.ref.kind === 'image').map((r) => [r.ref.id, r.record.data]));
    const textContents = textContentsOf(read);
    const c = cfg();
    const ctrl = new AbortController();
    state.routing = ctrl;
    MC.ui.composer.update();
    let result;
    try {
      result = await state.runner.route({
        text, attachments: refs, images, textContents,
        settings: MC.router.withDefaults(c.router),
        models: state.models, deciders: state.deciders, starred: c.starredDeciders,
        selection: currentModelIds().filter((id) => id !== MC.router.NATIVE_ID),
        filters: c.pickerFilters,
        systemPrompt: promptHolder().systemPrompt,
        contextNote: contextNote(state.conv),
        signal: ctrl.signal,
      });
    } catch (e) {
      result = { ok: false, reason: 'error', message: e.message || 'Routing failed' };
    } finally {
      state.routing = null;
      MC.ui.composer.update();
    }
    if (!result.ok) {
      if (result.reason !== 'aborted') toast(result.message, result.reason === 'empty' ? 'warn' : 'error');
      return false;
    }
    let { route, picks } = result;
    if (MC.router.withDefaults(c.router).preview) {
      const choice = await MC.ui.router.preview(result);
      if (!choice) return false;
      if (choice.action === 'selection') {
        if (files.length) return sendWithAttachments(text, files);
        sendBroadcast(text);
        return true;
      }
      picks = choice.picks;
      const pOf = new Map(route.picks.map((x) => [x.modelId, x.p]));
      route = Object.assign({}, route, { picks: picks.map((m) => ({ modelId: m.id, p: pOf.has(m.id) ? pOf.get(m.id) : null })) });
    }
    if (blockedByBusy()) return false;
    const conv = ensureConv();
    const laneIds = MC.conv.ensureLanes(conv, picks.map((m) => ({ id: m.id, name: m.name })));
    if (!await storeAttachments(read)) return false;
    // Image capability was enforced by the pool: no lane is "incapable".
    const { inputs, delivery } = MC.attach.buildInputs({ text, refs, textContents, laneIds, incapableIds: [], choice: null });
    const p = sendTurn('broadcast', inputs, { attachments: refs, delivery, route });
    refresh();
    if (p) p.catch(() => {});
    return true;
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
    // A chat with answers still streaming must keep using the object the runner writes into.
    const live = state.runner.liveConversation(id);
    const conv = live || await state.store.get(id);
    if (!conv) { toast('Conversation not found', 'error'); return; }
    if (!live && MC.conv.recoverInterrupted(conv)) await state.store.put(conv);
    state.conv = conv;
    document.body.classList.remove('side-open');
    refresh();
  }

  function newChat() {
    state.conv = null;
    state.draft = {};
    const def = cfg().defaultPresetId;
    if (def && state.presets.get(def)) {
      const p = state.presets.get(def);
      if (p.systemPrompt) state.draft = { systemPrompt: p.systemPrompt, presetId: p.id };
    }
    document.body.classList.remove('side-open');
    refresh();
    MC.ui.composer.focus();
  }

  async function deleteConversation(id) {
    deleted.add(id);
    state.runner.stopConversation(id);
    await state.store.deleteConversation(id);
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
    const data = MC.storage.parseImport(text);
    for (const a of data.attachments) await state.store.putAttachment(a);
    state.presets.importMany(data.presets);
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
      if (k === 'Escape' && !isTyping(e.target) && !document.querySelector('dialog[open]')) {
        if (state.routing) abortRoute();
        else if (state.runner.isBusy()) state.runner.stopAll();
      }
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) { const code = btn.parentElement.querySelector('code'); if (code) MC.dom.copyText(code.textContent); }
    });
  }

  async function start() {
    state.settings = MC.storage.createSettings();
    state.presets = MC.presets.createPresetStore(MC.storage.defaultLs());
    MC.ui.settings.applyTheme(cfg().theme);
    state.store = await MC.storage.openStore({
      onBlocked: () => toast('Updating saved chats — close other Multaichat tabs to continue', 'warn', 15000),
    });
    if (state.store.kind === 'local') toast('Browser database unavailable — history stored in limited local storage', 'warn', 8000);
    state.runner = MC.runner.createRunner({
      getKey: () => state.settings.getKey(), save, onChange,
      loadAttachments: async (ids) => Object.fromEntries((await state.store.attachmentsFor(ids)).map((r) => [r.id, r.data])),
      getModel: modelById,
      getPdfMode: () => cfg().pdfMode,
    });
    bindGlobalKeys();
    MC.ui.composer.mount();
    await refreshModels(false);
    state.metas = await state.store.list();
    if (state.metas.length) {
      const conv = await state.store.get(state.metas[0].id);
      if (conv && MC.conv.recoverInterrupted(conv)) await state.store.put(conv);
      state.conv = conv || null;
    }
    if (!state.conv) { newChat(); return void document.body.classList.add('ready'); }
    refresh();
    document.body.classList.add('ready');
  }

  MC.app = {
    state, start, refresh, modelById, refreshModels, refreshDeciders, openModelPicker, setSelection, addModel, removeModel,
    sendBroadcast, sendTargeted, sendBatch, openConversation, newChat, deleteConversation, renameConversation,
    importConversations, forkAt, save, ensureConv, applyPreset, setChatSystemPrompt, promptHolder, sendWithAttachments, updateCost,
    sendRouted, abortRoute, isRouting, currentModelIds,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window.MC);
