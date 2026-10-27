/* MC.conv — conversation data model. A conversation has one lane per model
   (each lane is that model's private thread) and a shared list of turns.
   Each turn records what every addressed lane was sent (`inputs`) and its
   response; a lane absent from a turn was "not asked". */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.conv = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const NEW_TITLE = 'New chat';
  const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  function touch(conv) { conv.updatedAt = Math.max(Date.now(), (conv.updatedAt || 0) + 1); }

  function newLane(model, joinedAtTurn) {
    return { id: MC.util.uid('l_'), modelId: model.id, modelName: model.name || model.id, active: true, joinedAtTurn };
  }

  function create(models, now = Date.now()) {
    return {
      id: MC.util.uid('c_'),
      title: NEW_TITLE,
      createdAt: now,
      updatedAt: now,
      lanes: models.map((m) => newLane(m, 0)),
      turns: [],
    };
  }

  function emptyResponse() {
    return { status: 'streaming', content: '', previous: [], asksQuestion: false };
  }

  function addTurn(conv, kind, inputs) {
    const turn = { id: MC.util.uid('t_'), index: conv.turns.length, createdAt: Date.now(), kind, inputs: Object.assign({}, inputs), responses: {} };
    for (const laneId of Object.keys(inputs)) turn.responses[laneId] = emptyResponse();
    conv.turns.push(turn);
    if (conv.title === NEW_TITLE) {
      const first = String(Object.values(inputs)[0] || '').split('\n').find((l) => l.trim()) || '';
      if (first) conv.title = first.trim().slice(0, 60).trim();
    }
    touch(conv);
    return turn;
  }

  function broadcastInputs(conv, text) {
    const out = {};
    for (const l of conv.lanes) if (l.active) out[l.id] = text;
    return out;
  }

  function laneById(conv, laneId) { return conv.lanes.find((l) => l.id === laneId); }
  function turnById(conv, turnId) { return conv.turns.find((t) => t.id === turnId); }

  function hasAnswer(r) { return r && (r.status === 'done' || r.status === 'stopped') && !!r.content; }

  // The chat's system prompt applies from turn `systemPromptFromTurn` on;
  // earlier prompts are kept in `systemPromptHistory` so rebuilt history uses
  // the prompt that was in force at each turn.
  function setSystemPrompt(conv, text, presetId) {
    if (conv.turns.length) {
      conv.systemPromptHistory = conv.systemPromptHistory || [];
      conv.systemPromptHistory.push({ fromTurn: conv.systemPromptFromTurn || 0, text: conv.systemPrompt || '' });
      conv.systemPromptFromTurn = conv.turns.length;
    } else {
      conv.systemPromptFromTurn = 0;
    }
    if (text && text.trim()) {
      conv.systemPrompt = text;
      if (presetId) conv.presetId = presetId; else delete conv.presetId;
    } else {
      delete conv.systemPrompt;
      delete conv.presetId;
    }
    touch(conv);
  }

  function promptAt(conv, turnIndex) {
    if (turnIndex >= (conv.systemPromptFromTurn || 0)) return conv.systemPrompt || null;
    const past = (conv.systemPromptHistory || []).filter((h) => h.fromTurn <= turnIndex);
    const h = past[past.length - 1];
    return (h && h.text) || null;
  }

  // Messages to send a lane for turn `uptoTurnIndex`: its history before that
  // turn plus that turn's user input (never that turn's own answer).
  function buildMessages(conv, laneId, uptoTurnIndex) {
    const lane = laneById(conv, laneId);
    const msgs = [];
    const sys = promptAt(conv, uptoTurnIndex);
    if (sys) msgs.push({ role: 'system', content: sys });
    if (lane && lane.seedContext) msgs.push({ role: 'system', content: lane.seedContext });
    for (const turn of conv.turns) {
      if (turn.index > uptoTurnIndex) break;
      if (!(laneId in turn.inputs)) continue;
      msgs.push({ role: 'user', content: turn.inputs[laneId] });
      const r = turn.responses[laneId];
      if (turn.index < uptoTurnIndex && hasAnswer(r)) msgs.push({ role: 'assistant', content: r.content });
    }
    return msgs;
  }

  function addLane(conv, model) {
    const lane = newLane(model, conv.turns.length);
    const tldrs = conv.turns.filter((t) => t.tldr && t.tldr.status === 'done' && t.tldr.content).map((t) => t.tldr.content);
    let body;
    if (tldrs.length) body = tldrs.map((c, i) => `Turn ${i + 1} summary:\n${c}`).join('\n\n');
    else {
      const seen = new Set();
      body = conv.turns.flatMap((t) => Object.values(t.inputs)).filter((s) => !seen.has(s) && seen.add(s)).map((s) => 'User: ' + s).join('\n');
    }
    if (body) lane.seedContext = 'Context from the conversation so far (you joined late):\n' + body;
    conv.lanes.push(lane);
    touch(conv);
    return lane;
  }

  function removeLane(conv, laneId) {
    const l = laneById(conv, laneId);
    if (l) { l.active = false; touch(conv); }
  }

  function beginRetry(conv, turnId, laneId) {
    const r = turnById(conv, turnId).responses[laneId];
    if (r.content || r.status === 'error') r.previous.push({ content: r.content, usage: r.usage, createdAt: Date.now(), status: r.status, error: r.error });
    Object.assign(r, { status: 'streaming', content: '', error: undefined, usage: undefined, asksQuestion: false, question: undefined });
    touch(conv);
    return r;
  }

  function fork(conv, turnIndex, { onlyLaneId } = {}) {
    const f = clone(conv);
    f.id = MC.util.uid('c_');
    f.parentId = conv.id;
    f.forkedAtTurn = turnIndex;
    f.title = '↳ ' + conv.title;
    f.createdAt = Date.now();
    f.turns = f.turns.filter((t) => t.index <= turnIndex);
    if (onlyLaneId) {
      f.lanes = f.lanes.filter((l) => l.id === onlyLaneId);
      f.turns = f.turns
        .filter((t) => onlyLaneId in t.inputs)
        .map((t) => {
          t.inputs = { [onlyLaneId]: t.inputs[onlyLaneId] };
          t.responses = t.responses[onlyLaneId] ? { [onlyLaneId]: t.responses[onlyLaneId] } : {};
          delete t.fusion;
          return t;
        });
      f.turns.forEach((t, i) => { t.index = i; });
    }
    // Fresh turn ids keep the fork independent of streams still running in the
    // original; anything still streaming there is frozen as "stopped" here.
    f.turns.forEach((t) => { t.id = MC.util.uid('t_'); });
    recoverInterrupted(f);
    touch(f);
    return f;
  }

  function recoverInterrupted(conv) {
    let changed = false;
    for (const t of conv.turns) {
      for (const r of Object.values(t.responses)) {
        if (r.status === 'streaming') { r.status = 'stopped'; changed = true; }
      }
      for (const k of ['tldr', 'fusion']) {
        if (t[k] && t[k].status === 'streaming') { t[k].status = 'error'; t[k].error = 'Interrupted'; changed = true; }
      }
    }
    return changed;
  }

  function answeredLanes(turn) {
    return Object.keys(turn.responses).filter((id) => hasAnswer(turn.responses[id]));
  }

  return { NEW_TITLE, setSystemPrompt, promptAt, create, addTurn, broadcastInputs, laneById, turnById, buildMessages, addLane, removeLane, beginRetry, fork, recoverInterrupted, answeredLanes, touch };
});
