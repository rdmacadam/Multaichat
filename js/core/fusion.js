/* MC.fusion — prompts for TL;DR and topic-grouped Fusion, and a tolerant
   parser/validator for the Fusion JSON a model returns. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.fusion = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const TLDR_SYSTEM = "Summarize these answers to the user's question in 3–6 bullet points. Note where models disagree. Be terse.";

  const FUSION_SYSTEM = [
    'You merge several AI models\' answers to the same question into one answer organized by topic.',
    'Return ONLY a JSON object (no prose, no code fences) with exactly this shape:',
    '{',
    '  "overview": "1–3 sentence synthesis",',
    '  "topics": [',
    '    { "title": "Topic heading", "merged": "Markdown synthesis of what models said on this topic",',
    '      "models": ["<model id>"], "excerpts": [{ "model": "<model id>", "quote": "verbatim text" }] }',
    '  ],',
    '  "disagreements": [{ "point": "...", "positions": [{ "model": "<model id>", "position": "..." }] }],',
    '  "unique": [{ "model": "<model id>", "point": "only this model mentioned..." }]',
    '}',
    'Rules: use 2–7 topics. Use the exact model ids given. "models" lists every model that made the point.',
    'Each "quote" must be copied verbatim from that model\'s answer (at most 300 characters).',
    'Use empty arrays when there are no disagreements or unique points.',
  ].join('\n');

  function questionsOf(turn) {
    return [...new Set(Object.values(turn.inputs))];
  }

  function answered(conv, turn) {
    return MC.conv.answeredLanes(turn).map((laneId) => {
      const lane = MC.conv.laneById(conv, laneId);
      return { lane, content: turn.responses[laneId].content };
    });
  }

  function answersByModel(conv, turn) {
    const out = {};
    for (const { lane, content } of answered(conv, turn)) out[lane.modelId] = content;
    return out;
  }

  function questionBlock(turn) {
    const qs = questionsOf(turn);
    return (qs.length > 1 ? 'Question(s):\n' : 'Question:\n') + qs.map((q) => '> ' + q.replace(/\n/g, '\n> ')).join('\n\n');
  }

  function tldrMessages(conv, turn) {
    const body = answered(conv, turn).map(({ lane, content }) => `### ${lane.modelName}\n${content}`).join('\n\n');
    return [
      { role: 'system', content: TLDR_SYSTEM },
      { role: 'user', content: questionBlock(turn) + '\n\nAnswers:\n\n' + body },
    ];
  }

  function fusionMessages(conv, turn) {
    const body = answered(conv, turn)
      .map(({ lane, content }) => `### ${lane.modelName} (model id: ${lane.modelId})\n${content}`)
      .join('\n\n');
    return [
      { role: 'system', content: FUSION_SYSTEM },
      { role: 'user', content: questionBlock(turn) + '\n\nAnswers:\n\n' + body },
    ];
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v : '');

  function parse(text, answersByModelMap) {
    const raw = String(text || '');
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    let obj = null;
    if (s >= 0 && e > s) {
      try { obj = JSON.parse(raw.slice(s, e + 1)); } catch (err) { obj = null; }
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.topics)) return { ok: false, raw };

    const known = (id) => Object.prototype.hasOwnProperty.call(answersByModelMap, id);
    const normAnswers = {};
    for (const id of Object.keys(answersByModelMap)) normAnswers[id] = norm(answersByModelMap[id]);

    const data = {
      overview: str(obj.overview),
      topics: obj.topics.filter((t) => t && typeof t === 'object').map((t) => ({
        title: str(t.title) || 'Untitled',
        merged: str(t.merged),
        models: arr(t.models).filter(known),
        excerpts: arr(t.excerpts)
          .filter((x) => x && known(x.model) && str(x.quote))
          .map((x) => ({ model: x.model, quote: x.quote, verified: normAnswers[x.model].includes(norm(x.quote)) })),
      })),
      disagreements: arr(obj.disagreements).filter((d) => d && str(d.point)).map((d) => ({
        point: d.point,
        positions: arr(d.positions).filter((p) => p && known(p.model)).map((p) => ({ model: p.model, position: str(p.position) })),
      })),
      unique: arr(obj.unique).filter((u) => u && known(u.model) && str(u.point)).map((u) => ({ model: u.model, point: u.point })),
    };
    return { ok: true, data };
  }

  return { TLDR_SYSTEM, FUSION_SYSTEM, tldrMessages, fusionMessages, answersByModel, parse };
});
