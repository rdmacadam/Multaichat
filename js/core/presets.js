/* MC.presets — named bundles of an optional system prompt, message template
   and model set. Built-ins are fixed; user presets live in localStorage. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.presets = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const KEY = 'mc.presets';

  const BUILT_INS = Object.freeze([
    {
      id: 'builtin-concise', name: 'Concise expert', builtIn: true,
      systemPrompt: 'You are a concise expert. Answer directly, use short paragraphs or bullets, and state uncertainty briefly.',
    },
    {
      id: 'builtin-code-review', name: 'Code reviewer', builtIn: true,
      systemPrompt: 'You are a meticulous senior code reviewer. Point out bugs, security issues and unclear code, citing the exact lines. Suggest concrete fixes.',
      template: 'Review this code:\n\n',
    },
    {
      id: 'builtin-simple', name: 'Explain simply', builtIn: true,
      systemPrompt: 'Explain like you are talking to a curious 12-year-old. Use plain words and one everyday analogy.',
    },
  ].map(Object.freeze));

  const isBuiltInId = (id) => BUILT_INS.some((b) => b.id === id);

  // Keeps only non-empty parts; returns a fresh object without builtIn.
  function clean(p) {
    const out = { id: p.id, name: String(p.name || '').trim() };
    if (p.systemPrompt && p.systemPrompt.trim()) out.systemPrompt = p.systemPrompt;
    if (p.template && p.template.trim()) out.template = p.template;
    if (Array.isArray(p.models) && p.models.length) out.models = p.models.slice();
    return out;
  }

  function createPresetStore(ls) {
    const read = () => {
      try {
        const v = JSON.parse(ls.getItem(KEY));
        return Array.isArray(v) ? v.filter((p) => p && p.id && !isBuiltInId(p.id)) : [];
      } catch (e) { return []; }
    };
    const write = (list) => ls.setItem(KEY, JSON.stringify(list));
    const byName = (a, b) => a.name.localeCompare(b.name);

    return {
      list() { return BUILT_INS.concat(read().sort(byName)); },
      userPresets() { return read(); },
      get(id) { return this.list().find((p) => p.id === id); },
      save(p) {
        const c = clean(p);
        if (!c.name) throw new Error('Name required');
        if (!c.id || isBuiltInId(c.id)) c.id = MC.util.uid('p_');
        const list = read();
        const i = list.findIndex((x) => x.id === c.id);
        if (i >= 0) list[i] = c; else list.push(c);
        write(list);
        return c;
      },
      remove(id) {
        if (isBuiltInId(id)) return false;
        const list = read();
        const next = list.filter((p) => p.id !== id);
        write(next);
        return next.length !== list.length;
      },
      duplicate(id) {
        const src = this.get(id);
        if (!src) return null;
        return this.save(Object.assign({}, src, { id: undefined, name: src.name + ' (copy)' }));
      },
      importMany(presets) {
        const list = read();
        let n = 0;
        for (const p of presets || []) {
          if (!p || !p.id || isBuiltInId(p.id) || !String(p.name || '').trim()) continue;
          const c = clean(p);
          const i = list.findIndex((x) => x.id === c.id);
          if (i >= 0) list[i] = c; else list.push(c);
          n++;
        }
        write(list);
        return n;
      },
    };
  }

  function sameSet(a, b) {
    return a.length === b.length && a.every((x) => b.includes(x));
  }

  // What applying `preset` to `conv` (null = no chat yet) should change.
  function applyPlan(preset, conv) {
    const models = preset.models && preset.models.length ? preset.models.slice() : null;
    const midChat = !!(conv && conv.turns && conv.turns.length);
    const active = conv ? conv.lanes.filter((l) => l.active).map((l) => l.modelId) : [];
    return {
      models,
      systemPrompt: preset.systemPrompt || null,
      presetId: preset.id,
      template: preset.template || null,
      confirmModels: !!(midChat && models && !sameSet(models, active)),
    };
  }

  function fromCurrent({ systemPrompt = '', models = [], template = '' }) {
    return {
      name: '', systemPrompt, models, template,
      include: { systemPrompt: !!systemPrompt, models: models.length > 0, template: !!template.trim() },
    };
  }

  function isEdited(conv, preset) {
    return !!preset && (conv.systemPrompt || '') !== (preset.systemPrompt || '');
  }

  function presetLabel(conv, store) {
    if (!conv || !conv.systemPrompt) return null;
    const p = conv.presetId && store.get(conv.presetId);
    if (!p) return 'Custom';
    return p.name + (isEdited(conv, p) ? ' (edited)' : '');
  }

  return { BUILT_INS, createPresetStore, applyPlan, fromCurrent, isEdited, presetLabel };
});
