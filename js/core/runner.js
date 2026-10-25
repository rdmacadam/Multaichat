/* MC.runner — streams a turn to every addressed lane in parallel, writes the
   results into the conversation, and runs TL;DR / Fusion. DOM-free: the UI
   passes `save` and `onChange` callbacks. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.runner = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const NO_KEY = 'Add your OpenRouter API key in Settings';

  function createRunner({ api = MC.api, getKey, save, onChange = () => {}, saveThrottleMs = 1000 }) {
    // Every in-flight request: token -> { ctrl, convId, turnId }
    const inflight = new Map();
    // Conversations with requests in flight: id -> { conv, count }
    const live = new Map();
    // One throttled saver per conversation so chats don't cancel each other's saves.
    const savers = new Map();

    function begin(conv, turnId) {
      const token = {};
      const ctrl = new AbortController();
      inflight.set(token, { ctrl, convId: conv.id, turnId });
      const l = live.get(conv.id) || { conv, count: 0 };
      l.count++;
      live.set(conv.id, l);
      return { token, ctrl };
    }

    function end(conv, token) {
      inflight.delete(token);
      const l = live.get(conv.id);
      if (l && --l.count <= 0) live.delete(conv.id);
    }

    function throttledSave(conv) {
      let s = savers.get(conv.id);
      if (!s) { s = MC.util.throttle((c) => { save(c); }, saveThrottleMs); savers.set(conv.id, s); }
      s(conv);
    }

    function errText(err, modelId) {
      return MC.api.errorMessage(err, modelId);
    }

    async function streamLane(conv, turn, laneId) {
      const lane = MC.conv.laneById(conv, laneId);
      const r = turn.responses[laneId];
      if (!lane || !r) return;
      const key = getKey();
      if (!key) {
        Object.assign(r, { status: 'error', error: NO_KEY });
        onChange(conv, { turnId: turn.id, laneId });
        return;
      }
      const { token, ctrl } = begin(conv, turn.id + ':' + laneId);
      try {
        const res = await api.streamChat({
          key,
          model: lane.modelId,
          messages: MC.conv.buildMessages(conv, laneId, turn.index),
          signal: ctrl.signal,
          onDelta(t) {
            r.content += t;
            onChange(conv, { turnId: turn.id, laneId });
            throttledSave(conv);
          },
        });
        r.content = res.content;
        r.usage = res.usage || undefined;
        r.status = 'done';
        const q = MC.clarify.detect(r.content);
        r.asksQuestion = q.asks;
        r.question = q.question || undefined;
      } catch (err) {
        if (err && err.partial && err.partial.length > r.content.length) r.content = err.partial;
        if (err && err.status === 'aborted') r.status = 'stopped';
        else { r.status = 'error'; r.error = errText(err, lane.modelId); r.errorStatus = err && err.status; }
      } finally {
        end(conv, token);
        MC.conv.touch(conv);
        onChange(conv, { turnId: turn.id, laneId });
      }
    }

    async function send(conv, kind, inputs) {
      const turn = MC.conv.addTurn(conv, kind, inputs);
      await save(conv);
      onChange(conv, { turnId: turn.id });
      await Promise.all(Object.keys(inputs).map((laneId) => streamLane(conv, turn, laneId)));
      await save(conv);
      return turn;
    }

    async function retry(conv, turnId, laneId) {
      const turn = MC.conv.turnById(conv, turnId);
      MC.conv.beginRetry(conv, turnId, laneId);
      onChange(conv, { turnId, laneId });
      await streamLane(conv, turn, laneId);
      await save(conv);
      return turn;
    }

    // stop(turnId) stops a whole turn (answers, TL;DR, Fusion); stop(turnId, laneId) one answer.
    function stop(turnId, laneId) {
      for (const f of inflight.values()) {
        if (laneId ? f.turnId === turnId + ':' + laneId : f.turnId.split(':')[0] === turnId) f.ctrl.abort();
      }
    }

    function stopConversation(convId) {
      for (const f of inflight.values()) if (f.convId === convId) f.ctrl.abort();
    }

    function stopAll() { for (const f of inflight.values()) f.ctrl.abort(); }

    // isBusy() — anything running; isBusy(turnId) — that turn; isBusy(null, convId) — that conversation.
    function isBusy(turnId, convId) {
      for (const f of inflight.values()) {
        if (convId && f.convId !== convId) continue;
        if (turnId && f.turnId.split(':')[0] !== turnId) continue;
        return true;
      }
      return false;
    }

    function liveConversation(convId) {
      const l = live.get(convId);
      return l ? l.conv : null;
    }

    async function runTldr(conv, turnId, modelId) {
      const turn = MC.conv.turnById(conv, turnId);
      const d = (turn.tldr = { modelId, status: 'streaming', content: '', createdAt: Date.now() });
      onChange(conv, { turnId, derived: 'tldr' });
      const key = getKey();
      const { token, ctrl } = begin(conv, turnId + ':tldr');
      try {
        if (!key) throw Object.assign(new Error(NO_KEY), { noKey: true });
        const res = await api.streamChat({
          key, model: modelId, messages: MC.fusion.tldrMessages(conv, turn), signal: ctrl.signal,
          onDelta(t) { d.content += t; onChange(conv, { turnId, derived: 'tldr' }); },
        });
        d.content = res.content;
        d.status = 'done';
      } catch (err) {
        d.status = 'error';
        d.error = err.noKey ? NO_KEY : errText(err, modelId);
      } finally {
        end(conv, token);
        MC.conv.touch(conv);
        onChange(conv, { turnId, derived: 'tldr' });
        await save(conv);
      }
      return d;
    }

    async function runFusion(conv, turnId, modelId) {
      const turn = MC.conv.turnById(conv, turnId);
      turn.fusion = { modelId, status: 'streaming', createdAt: Date.now() };
      onChange(conv, { turnId, derived: 'fusion' });
      const key = getKey();
      const { token, ctrl } = begin(conv, turnId + ':fusion');
      try {
        if (!key) throw Object.assign(new Error(NO_KEY), { noKey: true });
        const res = await api.complete({
          key, model: modelId, messages: MC.fusion.fusionMessages(conv, turn),
          responseFormat: { type: 'json_object' }, signal: ctrl.signal,
        });
        const parsed = MC.fusion.parse(res.content, MC.fusion.answersByModel(conv, turn));
        turn.fusion = parsed.ok
          ? { modelId, status: 'done', data: parsed.data, createdAt: Date.now() }
          : { modelId, status: 'error', raw: parsed.raw, error: "Couldn't structure this", createdAt: Date.now() };
      } catch (err) {
        turn.fusion = { modelId, status: 'error', error: err.noKey ? NO_KEY : errText(err, modelId), createdAt: Date.now() };
      } finally {
        end(conv, token);
        MC.conv.touch(conv);
        onChange(conv, { turnId, derived: 'fusion' });
        await save(conv);
      }
      return turn.fusion;
    }

    return { send, retry, stop, stopConversation, stopAll, isBusy, liveConversation, runTldr, runFusion };
  }

  return { createRunner, NO_KEY };
});
