/* MC.models — OpenRouter model catalog: normalization, suggestion sections,
   search, sorting/filtering and the 24 h localStorage cache. Pure except for
   loadCached, which takes its storage and fetch function as arguments. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.models = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const DAY = 86400e3;
  const CACHE_KEY = 'mc.modelsCache';
  const CACHE_TTL = DAY;

  const FLAGSHIP = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'meta-llama', 'mistralai', 'qwen'];
  // Providers whose models are open-weight. Entries ending in * are id prefixes.
  const OPEN_PROVIDERS = ['meta-llama', 'mistralai', 'qwen', 'deepseek', 'google/gemma*', 'microsoft', 'nvidia',
    'nousresearch', 'moonshotai', 'z-ai', 'thudm', 'minimax', 'allenai', 'openai/gpt-oss*', 'cohere/command-r7b*',
    'ibm-granite', 'baidu', 'tencent', 'liquid'];
  const EXCLUDE = /preview|beta|-exp|:extended|audio|image|embed|guard/i;

  const FALLBACK_RAW = [
    ['anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5', '0.000003', '0.000015', 200000],
    ['openai/gpt-5', 'OpenAI: GPT-5', '0.00000125', '0.00001', 400000],
    ['google/gemini-2.5-pro', 'Google: Gemini 2.5 Pro', '0.00000125', '0.00001', 1048576],
    ['deepseek/deepseek-chat-v3.1', 'DeepSeek: DeepSeek V3.1', '0.0000002', '0.0000008', 163840],
    ['meta-llama/llama-3.3-70b-instruct:free', 'Meta: Llama 3.3 70B Instruct (free)', '0', '0', 65536],
  ].map(([id, name, p, c, ctx]) => ({ id, name, created: 0, context_length: ctx, pricing: { prompt: p, completion: c } }));

  function pricePerM(v) { return MC.util.pricePerM(v); }

  function isOpen(raw, provider) {
    if (raw.hugging_face_id) return true;
    return OPEN_PROVIDERS.some((p) => (p.endsWith('*') ? raw.id.startsWith(p.slice(0, -1)) : p === provider));
  }

  function normalize(raw) {
    return (raw || [])
      .filter((r) => r && r.id)
      .filter((r) => {
        const out = r.architecture && r.architecture.output_modalities;
        return !Array.isArray(out) || out.includes('text');
      })
      .map((r) => {
        const provider = r.id.split('/')[0];
        const priceIn = pricePerM(r.pricing && r.pricing.prompt);
        const priceOut = pricePerM(r.pricing && r.pricing.completion);
        const created = (r.created || 0) * 1000;
        const ins = r.architecture && Array.isArray(r.architecture.input_modalities) && r.architecture.input_modalities.length
          ? r.architecture.input_modalities.slice() : ['text'];
        return {
          id: r.id,
          name: r.name || r.id,
          provider,
          created,
          context: r.context_length || 0,
          priceIn,
          priceOut,
          free: /:free$/.test(r.id) || (priceIn === 0 && priceOut === 0),
          open: isOpen(r, provider),
          inputs: ins,
          images: ins.includes('image'),
          files: ins.includes('file'),
          isNew(now = Date.now()) { return created > 0 && now - created <= 30 * DAY; },
        };
      });
  }

  const newestFirst = (a, b) => b.created - a.created;
  const eligible = (m, minCtx) => !EXCLUDE.test(m.id) && m.context >= minCtx;

  function sections(models, now = Date.now()) {
    const top = [];
    for (const p of FLAGSHIP) {
      const best = models.filter((m) => m.provider === p && !m.free && eligible(m, 32000)).sort(newestFirst)[0];
      if (best) top.push(best);
    }
    const free = models.filter((m) => m.free && eligible(m, 8000)).sort(newestFirst);
    const perProvider = {};
    const open = models
      .filter((m) => m.open && !/:free$/.test(m.id) && eligible(m, 32000) && now - m.created <= 180 * DAY)
      .sort((a, b) => newestFirst(a, b) || b.context - a.context)
      .filter((m) => (perProvider[m.provider] = (perProvider[m.provider] || 0) + 1) <= 2)
      .slice(0, 12);
    return { top, free, open, all: models.slice() };
  }

  function search(models, query, now = Date.now()) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const flags = { free: false, open: false, new: false };
    const terms = [];
    for (const w of words) (w in flags ? (flags[w] = true) : terms.push(w));
    const hay = (m) => (m.name + ' ' + m.id + ' ' + m.provider).toLowerCase();
    const res = models.filter((m) =>
      (!flags.free || m.free) && (!flags.open || m.open) && (!flags.new || m.isNew(now)) &&
      terms.every((t) => hay(m).includes(t)));
    if (!terms.length) return res.sort(newestFirst);
    const first = terms[0];
    const startsWord = (m) => {
      const idPart = m.id.split('/').pop().toLowerCase();
      const namePart = m.name.toLowerCase().split(': ').pop();
      return idPart.startsWith(first) || namePart.startsWith(first) || m.name.toLowerCase().startsWith(first) ? 0 : 1;
    };
    return res.sort((a, b) => startsWord(a) - startsWord(b) || newestFirst(a, b));
  }

  function sortBy(models, key) {
    const list = models.slice();
    if (key === 'price') {
      const p = (m) => (m.priceOut == null ? Infinity : m.priceOut);
      return list.sort((a, b) => p(a) - p(b) || newestFirst(a, b));
    }
    if (key === 'context') return list.sort((a, b) => b.context - a.context || newestFirst(a, b));
    return list.sort(newestFirst);
  }

  const isSet = (v) => v != null && v !== '' && v !== false;

  // Picker filters. Unset fields (null, '', false) do not filter. maxPrice is
  // the v1 name for maxOut. A price limit excludes models with unknown price.
  function filter(models, { freeOnly, openOnly, maxPrice, maxIn, maxOut, minContext, images, files } = {}) {
    if (!isSet(maxOut)) maxOut = maxPrice;
    return models.filter((m) =>
      (!freeOnly || m.free) && (!openOnly || m.open) &&
      (!isSet(maxIn) || (m.priceIn != null && m.priceIn <= Number(maxIn))) &&
      (!isSet(maxOut) || (m.priceOut != null && m.priceOut <= Number(maxOut))) &&
      (!isSet(minContext) || m.context >= Number(minContext)) &&
      (!images || m.images) && (!files || m.files));
  }

  function activeFilterCount(f) {
    if (!f) return 0;
    return ['maxIn', 'maxOut', 'minContext', 'images', 'files'].filter((k) => isSet(f[k])).length;
  }

  async function loadCached({ ls = globalThis.localStorage, fetchModelsFn, now = Date.now(), force = false } = {}) {
    let cache = null;
    try { cache = JSON.parse(ls.getItem(CACHE_KEY)); } catch (e) { cache = null; }
    if (cache && !Array.isArray(cache.raw)) cache = null;
    if (cache && !force && now - cache.fetchedAt < CACHE_TTL && cache.raw.length) {
      return { models: normalize(cache.raw), stale: false, source: 'cache' };
    }
    try {
      const raw = await fetchModelsFn();
      if (!raw || !raw.length) throw new Error('empty model list');
      try { ls.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: now, raw })); } catch (e) { /* quota */ }
      return { models: normalize(raw), stale: false, source: 'network' };
    } catch (e) {
      if (cache && cache.raw.length) return { models: normalize(cache.raw), stale: true, source: 'cache' };
      return { models: normalize(FALLBACK_RAW), stale: true, source: 'fallback' };
    }
  }

  function defaults(models, now) {
    const top = sections(models, now).top;
    const pool = top.length ? top : models;
    const priced = pool.filter((m) => m.priceOut != null).sort((a, b) => a.priceOut - b.priceOut);
    return {
      selected: pool.slice(0, 3).map((m) => m.id),
      summaryModel: (priced[0] || pool[0] || {}).id || null,
      fusionModel: (pool[0] || {}).id || null,
    };
  }

  function reconcileSelection(settings, models, now = Date.now()) {
    const known = new Set(models.map((m) => m.id));
    const d = defaults(models, now);
    const selected = (settings.selected || []).filter((id) => known.has(id));
    const dropped = (settings.selected || []).filter((id) => !known.has(id));
    return {
      dropped,
      settings: Object.assign({}, settings, {
        selected: selected.length ? selected : d.selected,
        summaryModel: known.has(settings.summaryModel) ? settings.summaryModel : d.summaryModel,
        fusionModel: known.has(settings.fusionModel) ? settings.fusionModel : d.fusionModel,
      }),
    };
  }

  return { FLAGSHIP, OPEN_PROVIDERS, FALLBACK_RAW, normalize, sections, search, sortBy, filter, activeFilterCount, loadCached, reconcileSelection };
});
