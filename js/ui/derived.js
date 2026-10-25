/* TL;DR and Fusion cards shown under a turn. */
(function (MC) {
  'use strict';
  const { h, shortName, copyText } = MC.dom;

  function nameFor(conv, modelId) {
    const l = conv.lanes.find((x) => x.modelId === modelId);
    return shortName(l ? l.modelName : modelId);
  }

  function head(title, d, onRegen, copy) {
    return h('div', { class: 'derived-head' },
      h('strong', {}, title),
      d.modelId ? h('span', { class: 'muted small' }, 'by ' + shortName((MC.app.modelById(d.modelId) || { name: d.modelId }).name)) : null,
      d.status === 'streaming' ? h('span', { class: 'spinner', 'aria-label': 'Working' }) : null,
      h('span', { class: 'spacer' }),
      d.status !== 'streaming' && copy ? h('button', { class: 'ghost small', onclick: () => copyText(copy()) }, 'Copy') : null,
      d.status !== 'streaming' ? h('button', { class: 'ghost small', onclick: onRegen }, 'Regenerate') : null);
  }

  function tldrCard(conv, turn) {
    const d = turn.tldr;
    const regen = () => MC.app.state.runner.runTldr(conv, turn.id, MC.app.state.settings.get().summaryModel);
    return h('div', { class: 'card derived-card tldr' },
      head('TL;DR', d, regen, () => d.content),
      d.status === 'error' ? h('div', { class: 'cell-error' }, '⚠ ', d.error) : null,
      h('div', { class: 'md', html: MC.md.render(d.content || '') }));
  }

  function fusionMarkdown(conv, data) {
    const n = (id) => nameFor(conv, id);
    const out = [];
    if (data.overview) out.push(data.overview, '');
    for (const t of data.topics) {
      out.push(`## ${t.title}`, t.merged, `_Models: ${t.models.map(n).join(', ')}_`, '');
    }
    if (data.disagreements.length) {
      out.push('## Disagreements');
      for (const d of data.disagreements) out.push(`- **${d.point}** — ` + d.positions.map((p) => `${n(p.model)}: ${p.position}`).join('; '));
      out.push('');
    }
    if (data.unique.length) {
      out.push('## Unique points');
      for (const u of data.unique) out.push(`- ${n(u.model)}: ${u.point}`);
    }
    return out.join('\n');
  }

  function topicCard(conv, t) {
    const byModel = {};
    for (const x of t.excerpts) (byModel[x.model] = byModel[x.model] || []).push(x);
    const models = Object.keys(byModel);
    return h('div', { class: 'topic' },
      h('h4', {}, t.title),
      h('div', { class: 'md', html: MC.md.render(t.merged) }),
      h('div', { class: 'chips' }, t.models.map((m) => h('span', { class: 'chip small', title: m }, nameFor(conv, m)))),
      t.excerpts.length ? h('details', { class: 'sources' },
        h('summary', {}, `Show sources (${t.excerpts.length})`),
        h('div', { class: 'excerpts grid', style: `--cols:${models.length}` },
          models.map((m) => h('div', { class: 'excerpt-col' },
            h('div', { class: 'muted small' }, nameFor(conv, m)),
            byModel[m].map((x) => h('blockquote', { class: x.verified ? '' : 'unverified' },
              x.quote, x.verified ? null : h('span', { class: 'badge', title: 'Not found word-for-word in the answer' }, 'paraphrased'))))))) : null);
  }

  function fusionCard(conv, turn) {
    const d = turn.fusion;
    const regen = () => MC.app.state.runner.runFusion(conv, turn.id, MC.app.state.settings.get().fusionModel);
    const body = [];
    if (d.status === 'streaming') body.push(h('p', { class: 'muted' }, 'Fusing answers…'));
    else if (d.status === 'error') {
      body.push(h('div', { class: 'cell-error' }, '⚠ ', d.raw ? "Couldn't structure this — Regenerate" : d.error));
      if (d.raw) body.push(h('div', { class: 'md', html: MC.md.render(d.raw) }));
    } else {
      const data = d.data;
      if (data.overview) body.push(h('div', { class: 'md overview', html: MC.md.render(data.overview) }));
      body.push(data.topics.map((t) => topicCard(conv, t)));
      if (data.disagreements.length) {
        body.push(h('div', { class: 'topic disagreements' }, h('h4', {}, 'Disagreements'),
          h('ul', {}, data.disagreements.map((x) => h('li', {}, h('strong', {}, x.point), h('ul', {},
            x.positions.map((p) => h('li', {}, h('span', { class: 'chip small' }, nameFor(conv, p.model)), ' ', p.position))))))));
      }
      if (data.unique.length) {
        body.push(h('div', { class: 'topic unique' }, h('h4', {}, 'Unique points'),
          h('ul', {}, data.unique.map((u) => h('li', {}, h('span', { class: 'chip small' }, nameFor(conv, u.model)), ' ', u.point)))));
      }
    }
    return h('div', { class: 'card derived-card fusion' },
      head('Fusion', d, regen, d.status === 'done' ? () => fusionMarkdown(conv, d.data) : null), body);
  }

  function render(conv, turn) {
    return [turn.tldr ? tldrCard(conv, turn) : null, turn.fusion ? fusionCard(conv, turn) : null];
  }

  MC.ui = MC.ui || {};
  MC.ui.derived = { render, fusionMarkdown };
})(window.MC);
