/* MC.router — the router's pure logic: router settings, the candidate pool,
   rule order, the decision model chain, the decision and judge requests sent
   to OpenRouter decision models, and ranking their answers. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.router = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const MODES = ['auto', 'free', 'diverse', 'best', 'manual', 'native'];
  const NATIVE_ID = 'openrouter/auto';
  const DEFAULT_DECIDER = 'perplexity/pplx-decider-v1.2';
  const FREE_DECIDER = 'baseten/mammoth-1:free';
  const MAX_COUNT = 8;
  const MAX_CANDIDATES = 30;
  const MAX_IMAGES = 4;
  const MAX_DECIDERS = 2;
  const BUDGET_SHARE = 0.6;   // share of the decider's context we may use
  const STATE_SHARE = 0.4;    // share of that budget the state may use
  const SHORT_DESC = 60;
  const TEXT_EXCERPT = 2000;
  const IMAGE_CHARS = 4000;   // rough size of one image part (~1k tokens); data URLs are not text
  const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'];
  const TYPESAFE_MIME = ['image/png', 'image/jpeg'];

  const AUTO_GOAL = 'Which model will give the best answer to the user message, balancing answer quality against price?';
  const GOAL = Object.freeze({
    auto: AUTO_GOAL,
    free: 'Which of these free models will give the best answer to the user message?',
    diverse: 'Which model will give the best answer to the user message? Several different models will be chosen to get different perspectives.',
    best: 'Which model will give the highest-quality answer to the user message? Ignore price.',
    manual: AUTO_GOAL,
  });

  const TASKS = Object.freeze({
    code: 'Writing, reviewing or debugging code.',
    math: 'Calculations, proofs or quantitative problems.',
    writing: 'Creative or professional writing, editing or translation.',
    analysis: 'Reasoning about data, documents, options or arguments.',
    research: 'Finding facts or explaining a topic in depth.',
    chat: 'Casual conversation or a quick question.',
    vision: 'Understanding or describing attached images.',
  });

  const DEFAULTS = Object.freeze({
    enabled: false,
    mode: 'auto',
    count: 3,
    pool: 'catalog',
    decisionModel: DEFAULT_DECIDER,
    manualPool: Object.freeze([]),
    extras: Object.freeze({ fusion: false, judge: false }),
    preview: false,
    allowPaidInFree: false,
  });

  const bool = (v, d) => (typeof v === 'boolean' ? v : d);

  // Stored router settings with missing or invalid fields replaced by defaults.
  function withDefaults(router) {
    const r = router && typeof router === 'object' ? router : {};
    const extras = r.extras && typeof r.extras === 'object' ? r.extras : {};
    const mode = MODES.includes(r.mode) ? r.mode : DEFAULTS.mode;
    const n = Math.floor(Number(r.count));
    // Native always uses 1, but that clamp is applied where the count is used,
    // so trying Native does not overwrite the saved count.
    const count = isFinite(n) && r.count !== '' && r.count != null
      ? Math.min(MAX_COUNT, Math.max(1, n)) : DEFAULTS.count;
    return {
      enabled: bool(r.enabled, DEFAULTS.enabled),
      mode,
      count,
      pool: r.pool === 'selection' ? 'selection' : 'catalog',
      decisionModel: typeof r.decisionModel === 'string' && r.decisionModel ? r.decisionModel : DEFAULTS.decisionModel,
      manualPool: Array.isArray(r.manualPool) ? r.manualPool.filter((id) => typeof id === 'string') : [],
      extras: { fusion: bool(extras.fusion, false), judge: bool(extras.judge, false) },
      preview: bool(r.preview, DEFAULTS.preview),
      allowPaidInFree: bool(r.allowPaidInFree, DEFAULTS.allowPaidInFree),
    };
  }

  // ---- rule order (§5.5) ----

  const newestFirst = (a, b) => b.created - a.created;

  function topFirst(list, now) {
    const top = MC.models.sections(list, now).top;
    const set = new Set(top);
    return top.concat(list.filter((m) => !set.has(m)).sort(newestFirst));
  }

  // One model per provider first (newest of each; providers with a Top pick
  // first, in Top-pick order), then the remaining models newest first.
  function diverseOrder(list, now) {
    const topProviders = MC.models.sections(list, now).top.map((m) => m.provider);
    const sorted = list.slice().sort(newestFirst);
    const firsts = [];
    const seen = new Set();
    for (const m of sorted) if (!seen.has(m.provider)) { seen.add(m.provider); firsts.push(m); }
    const rank = (m) => { const i = topProviders.indexOf(m.provider); return i < 0 ? Infinity : i; };
    firsts.sort((a, b) => rank(a) - rank(b) || newestFirst(a, b));
    const firstSet = new Set(firsts);
    return firsts.concat(sorted.filter((m) => !firstSet.has(m)));
  }

  function ruleOrder(list, mode, now) {
    switch (mode) {
      case 'manual': return list.slice();
      case 'free': return list.slice().sort((a, b) => newestFirst(a, b) || b.context - a.context);
      case 'diverse': return diverseOrder(list, now);
      case 'best': {
        const out = (m) => (m.priceOut == null ? -1 : m.priceOut);
        return list.slice().sort((a, b) => out(b) - out(a) || newestFirst(a, b));
      }
      default: return topFirst(list, now);   // auto, native
    }
  }

  function rulesPick(list, mode, n, now = Date.now()) {
    return ruleOrder(list || [], mode, now).slice(0, Math.max(0, n));
  }

  // ---- candidate pool (§5.2) ----

  const hasImage = (attachments) => (attachments || []).some((a) => a && a.kind === 'image');

  // reason: the step that emptied the pool, or else the last step that
  // removed a model. EXCLUDE and router-type removals never set a reason.
  function candidates(models, { mode, pool, selection, manualPool, filters, attachments } = {}) {
    let reason = null;
    let list;
    const step = (name, next) => {
      if (next.length < list.length) reason = name;
      list = next;
      return !list.length;
    };
    if (mode === 'manual' || pool === 'selection') {
      const wanted = [...new Set((mode === 'manual' ? manualPool : selection) || [])];
      const byId = new Map(models.map((m) => [m.id, m]));
      list = wanted.map((id) => byId.get(id)).filter(Boolean);
      if (!list.length || list.length < wanted.length) reason = 'selection';
      if (!list.length) return { list, reason };
    } else {
      list = models.filter((m) => !MC.models.EXCLUDE.test(m.id));
    }
    list = list.filter((m) => !m.router);
    if (!list.length) return { list, reason: null };
    if (step('filters', MC.models.filter(list, filters || {}))) return { list, reason };
    if (hasImage(attachments) && step('images', list.filter((m) => m.images))) return { list, reason };
    if (mode === 'free' && step('free', list.filter((m) => m.free))) return { list, reason };
    return { list: ruleOrder(list, mode), reason };
  }

  // ---- decision model chain (§5.3) ----

  function chooseDecider(deciders, { mode, decisionModel, starred, allowPaidInFree, hasImages } = {}) {
    const byId = new Map((deciders || []).map((d) => [d.id, d]));
    const chosen = decisionModel || DEFAULT_DECIDER;
    const star = (starred || []).filter((id) => byId.has(id));
    const seen = new Set();
    // Present, not yet listed; image deciders first when images are attached.
    const group = (ids) => {
      const list = ids.filter((id) => byId.has(id) && !seen.has(id) && seen.add(id)).map((id) => byId.get(id));
      return hasImages ? list.filter((d) => d.images).concat(list.filter((d) => !d.images)) : list;
    };
    let list;
    if (mode === 'free') {
      // Free deciders always come before paid ones, even with images attached.
      const isFree = (id) => byId.has(id) && byId.get(id).free;
      list = group([chosen, FREE_DECIDER].concat(star, (deciders || []).map((d) => d.id)).filter(isFree));
      if (allowPaidInFree) list = list.concat(group([chosen].concat(star)));
    } else {
      list = group([chosen].concat(star));
    }
    return list.slice(0, MAX_DECIDERS);
  }

  // ---- decision request (§5.4) ----

  // Some deciders list no context length (0): size their requests for 16k.
  const UNKNOWN_CONTEXT = 16384;
  const budgetChars = (decider) => Math.floor((Number(decider && decider.context) || UNKNOWN_CONTEXT) * BUDGET_SHARE) * 4;

  function fmtPrice(v) { return v == null ? '?' : String(Number(v.toPrecision(3))); }

  function fmtCtx(n) {
    return n >= 1e6 ? Number((n / 1e6).toFixed(1)) + 'M' : Math.round(n / 1000) + 'k';
  }

  function guidance(m, mode) {
    const parts = [m.name, m.provider];
    if (mode !== 'best') parts.push(`$${fmtPrice(m.priceIn)}/$${fmtPrice(m.priceOut)} per M`);
    if (m.context) parts.push(fmtCtx(m.context) + ' ctx');
    if (m.images) parts.push('reads images');
    if (m.desc) parts.push(m.desc);
    return parts.join(' · ');
  }

  function questionsFor(list, mode) {
    const criteria = {};
    for (const m of list) criteria[m.id] = guidance(m, mode);
    return {
      pick: { type: 'choice', instructions: (GOAL[mode] || GOAL.auto) + ' Answer with the label of one model.', criteria },
      task: { type: 'choice', instructions: 'What kind of task is the user message?', criteria: Object.assign({}, TASKS) },
    };
  }

  // Candidates (rule order) that fit next to stateChars of state: at most 30;
  // if too big, descriptions shortened to 60 chars, then the tail dropped.
  // Fewer than 2 → [] (the caller falls back to rule ranking).
  function fitToContext(list, decider, stateChars, mode = 'auto') {
    const room = budgetChars(decider) - (stateChars || 0);
    const fits = (l) => JSON.stringify(questionsFor(l, mode)).length <= room;
    let out = (list || []).slice(0, MAX_CANDIDATES);
    if (out.length < 2) return [];
    if (fits(out)) return out;
    out = out.map((m) => (m.desc && m.desc.length > SHORT_DESC ? Object.assign({}, m, { desc: m.desc.slice(0, SHORT_DESC) }) : m));
    while (out.length >= 2 && !fits(out)) out.pop();
    return out.length >= 2 ? out : [];
  }

  // Estimated size of a state array: strings as JSON, image parts as IMAGE_CHARS.
  function stateChars(state) {
    return state.reduce((n, p) => n + 1 + (typeof p === 'string' ? JSON.stringify(p).length : IMAGE_CHARS), 1);
  }

  // Cuts text parts ({ head, body }) until the state fits maxChars. groups
  // lists part indexes in cut order; within a group the longest bodies are
  // cut first, so they end up about equally long.
  function cutToFit(parts, maxChars, groups) {
    const build = () => parts.map((p) => (p.head == null ? p : p.head + p.body));
    for (const group of groups) {
      let over = stateChars(build()) - maxChars;
      while (over > 0) {
        const lens = group.map((i) => parts[i].body.length);
        // saved chars when cutting a body to L (a cut body ends with '…')
        const saved = (L) => lens.reduce((s, len) => s + (len <= L ? 0 : L === 0 ? len : len - L - 1), 0);
        if (saved(0) <= over) { group.forEach((i) => { parts[i].body = ''; }); break; }
        let lo = 0;
        let hi = Math.max(...lens);
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (saved(mid) >= over) lo = mid; else hi = mid - 1; }
        group.forEach((i) => {
          const b = parts[i].body;
          if (b.length > lo) parts[i].body = lo === 0 ? '' : b.slice(0, lo) + '…';
        });
        over = stateChars(build()) - maxChars;
      }
      if (over <= 0) break;
    }
    return build();
  }

  function imageAllowed(decider, mime) {
    return (/^typesafe\//.test(decider.id || '') ? TYPESAFE_MIME : IMAGE_MIME).includes(mime);
  }

  // textContents: { attachmentId: text } as for MC.attach.buildInputs; text is
  // the composer's own text (without the inlined file bodies).
  function decisionRequest({ mode, candidates: list, decider, text, systemPrompt, contextNote, attachments, images, textContents }) {
    const maxState = Math.floor(budgetChars(decider) * STATE_SHARE);
    // images may use at most half of the state's share, so the message stays
    const maxImages = Math.min(MAX_IMAGES, Math.floor(maxState / 2 / IMAGE_CHARS));
    const parts = [{ head: 'User message:\n', body: String(text || '') }];
    if (systemPrompt) parts.push({ head: 'System prompt:\n', body: String(systemPrompt) });
    if (contextNote) parts.push({ head: 'Earlier in this chat:\n', body: String(contextNote) });
    const atts = attachments || [];
    const sent = [];
    let unsent = 0;
    for (const a of atts.filter((x) => x && x.kind === 'image')) {
      const url = images && images[a.id];
      if (decider.images && url && imageAllowed(decider, a.mime) && sent.length < maxImages) {
        sent.push({ type: 'image_url', image_url: { url } });
      } else unsent++;
    }
    parts.push(...sent);
    if (unsent) parts.push(`[${unsent} image(s) attached]`);
    const files = [];
    for (const a of atts) {
      if (a && a.kind === 'pdf') parts.push(`[PDF attached: ${a.name}]`);
      const body = a && a.kind === 'text' && textContents && textContents[a.id];
      if (typeof body === 'string') files.push(parts.push({ head: `${a.name}:\n`, body: body.slice(0, TEXT_EXCERPT) }) - 1);
    }

    // cut order: context note, system prompt, text files, message last
    const note = parts.findIndex((p) => p.head === 'Earlier in this chat:\n');
    const sp = parts.findIndex((p) => p.head === 'System prompt:\n');
    const groups = [[note], [sp], files, [0]].filter((g) => g.length && g[0] >= 0);
    const state = cutToFit(parts, maxState, groups);
    const fit = fitToContext(list, decider, stateChars(state), mode);
    return { state, questions: questionsFor(fit, mode), candidateIds: fit.map((m) => m.id) };
  }

  // ---- ranking (§5.5) ----

  const providerOf = (id) => String(id).split('/')[0];
  const isProb = (v) => typeof v === 'number' && isFinite(v);

  // The decider's ranking of valid labels: by probability, or the choice alone.
  function answered(pick, valid, order) {
    if (!pick) return [];
    const probs = pick.probabilities && typeof pick.probabilities === 'object' ? pick.probabilities : {};
    const at = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
    const ranked = Object.keys(probs).filter((id) => valid.has(id) && isProb(probs[id]))
      .sort((a, b) => probs[b] - probs[a] || at(a) - at(b))
      .map((id) => ({ modelId: id, p: probs[id] }));
    if (ranked.length) return ranked;
    if (valid.has(pick.choice)) return [{ modelId: pick.choice, p: isProb(pick.confidence) ? pick.confidence : null }];
    return [];
  }

  function rank(answers, candidateIds, rules, mode, n) {
    const order = (rules || []).map((m) => m.id);
    const ranking = answered(answers && answers.pick, new Set(candidateIds || []), order)
      .concat(order.map((id) => ({ modelId: id, p: null })));
    const seen = new Set();
    const unique = ranking.filter((x) => !seen.has(x.modelId) && seen.add(x.modelId));
    if (mode !== 'diverse') return unique.slice(0, n);
    const out = [];
    const providers = new Set();
    for (const x of unique) {
      if (out.length >= n) break;
      if (!providers.has(providerOf(x.modelId))) { providers.add(providerOf(x.modelId)); out.push(x); }
    }
    for (const x of unique) if (out.length < n && !out.includes(x)) out.push(x);
    return out;
  }

  function taskOf(answers) {
    const c = answers && answers.task && answers.task.choice;
    return typeof c === 'string' && Object.prototype.hasOwnProperty.call(TASKS, c) ? c : null;
  }

  // ---- judge (§5.8) ----

  function judgeRequest({ text, answers, decider }) {
    const criteria = {};
    for (const a of answers) criteria[a.modelId] = a.name || a.modelId;
    const questions = {
      best: { type: 'choice', instructions: 'Which answer best and most correctly answers the question?', criteria },
    };
    const parts = [{ head: 'Question:\n', body: String(text || '') }]
      .concat(answers.map((a) => ({ head: `Answer from ${a.modelId}:\n`, body: String(a.content || '') })));
    const room = budgetChars(decider) - JSON.stringify(questions).length;
    const state = cutToFit(parts, room, [answers.map((_, i) => i + 1), [0]]);
    return { state, questions };
  }

  function judgeResult(answers, laneByModel) {
    const valid = new Set(Object.keys(laneByModel || {}));
    const best = answered(answers && answers.best, valid, [])[0];
    return best ? { laneId: laneByModel[best.modelId], modelId: best.modelId, p: best.p } : null;
  }

  return {
    MODES, NATIVE_ID, DEFAULT_DECIDER, FREE_DECIDER, GOAL, TASKS, DEFAULTS,
    withDefaults, candidates, rulesPick, chooseDecider, decisionRequest, fitToContext, rank, taskOf, judgeRequest, judgeResult,
  };
});
