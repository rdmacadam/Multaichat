/* MC.cost — chat cost summary from the usage stored on turns. Pure. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.cost = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FINISHED = ['done', 'stopped', 'error'];
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

  function summary(conv) {
    const parts = { answers: 0, earlier: 0, router: 0, derived: 0, judge: 0 };
    let unknown = 0;
    // Adds one request's usage to a part; a usage without a numeric cost is unknown.
    function add(part, usage) {
      if (!usage) return;
      if (isNum(usage.cost)) parts[part] += usage.cost;
      else unknown += 1;
    }
    for (const turn of (conv && conv.turns) || []) {
      for (const r of Object.values(turn.responses || {})) {
        if (FINISHED.includes(r.status)) add('answers', r.usage);
        for (const p of r.previous || []) add('earlier', p && p.usage);
      }
      if (turn.route) add('router', turn.route.usage);
      if (turn.tldr) add('derived', turn.tldr.usage);
      if (turn.fusion) add('derived', turn.fusion.usage);
      if (turn.judge) add('judge', turn.judge.usage);
      const sr = turn.spentReplaced;
      if (sr) {
        if (isNum(sr.derived)) parts.derived += sr.derived;
        if (isNum(sr.judge)) parts.judge += sr.judge;
      }
    }
    // Decisions paid for messages that were never sent (preview cancelled, …).
    if (conv && isNum(conv.spentUnsent)) parts.router += conv.spentUnsent;
    // Round away float noise (sums of tiny USD amounts).
    const r = (n) => Math.round(n * 1e12) / 1e12;
    for (const k of Object.keys(parts)) parts[k] = r(parts[k]);
    const total = r(parts.answers + parts.earlier + parts.router + parts.derived + parts.judge);
    return { total, unknown, parts };
  }

  // A replaced TL;DR / Fusion / judge keeps costing what it cost.
  function addReplaced(turn, kind, usage) {
    if (!usage || !isNum(usage.cost)) return;
    const sr = turn.spentReplaced || (turn.spentReplaced = { derived: 0, judge: 0 });
    sr[kind] = (sr[kind] || 0) + usage.cost;
  }

  // A routing decision whose message was not sent still cost what it cost.
  function addUnsent(conv, usage) {
    if (!conv || !usage || !isNum(usage.cost)) return;
    conv.spentUnsent = (isNum(conv.spentUnsent) ? conv.spentUnsent : 0) + usage.cost;
  }

  return { summary, addReplaced, addUnsent };
});
