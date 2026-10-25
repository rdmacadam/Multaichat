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
    const controllers = new Map(); // `${turnId}:${laneId}` -> AbortController
    const ctrlKey = (turnId, laneId) => turnId + ':' + laneId;

    const throttledSave = MC.util.throttle((conv) => { save(conv); }, saveThrottleMs);

    function errText(err, modelId) {
      return MC.api.errorMessage(err, modelId);
    }

    async function streamLane(conv, turn, laneId) {
      const lane = MC.conv.laneById(conv, laneId);
      const r = turn.responses[laneId];
      const key = getKey();
      if (!key) {
        Object.assign(r, { status: 'error', error: NO_KEY });
        onChange(conv, { turnId: turn.id, laneId });
        return;
      }
      const ctrl = new AbortController();
      controllers.set(ctrlKey(turn.id, laneId), ctrl);
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
        controllers.delete(ctrlKey(turn.id, laneId));
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

    function stop(turnId, laneId) {
      for (const [k, c] of controllers) {
        if (k === ctrlKey(turnId, laneId) || (!laneId && k.startsWith(turnId + ':'))) c.abort();
      }
    }

    function stopAll() { for (const c of controllers.values()) c.abort(); }

    function isBusy(turnId) {
      for (const k of controllers.keys()) if (!turnId || k.startsWith(turnId + ':')) return true;
      return false;
    }

    async function runTldr(conv, turnId, modelId) {
      const turn = MC.conv.turnById(conv, turnId);
      const d = (turn.tldr = { modelId, status: 'streaming', content: '', createdAt: Date.now() });
      onChange(conv, { turnId, derived: 'tldr' });
      const key = getKey();
      const ctrl = new AbortController();
      controllers.set(ctrlKey(turnId, 'tldr'), ctrl);
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
        controllers.delete(ctrlKey(turnId, 'tldr'));
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
      const ctrl = new AbortController();
      controllers.set(ctrlKey(turnId, 'fusion'), ctrl);
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
        controllers.delete(ctrlKey(turnId, 'fusion'));
        MC.conv.touch(conv);
        onChange(conv, { turnId, derived: 'fusion' });
        await save(conv);
      }
      return turn.fusion;
    }

    return { send, retry, stop, stopAll, isBusy, runTldr, runFusion };
  }

  return { createRunner, NO_KEY };
});
