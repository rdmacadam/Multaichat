/* MC.runner — streams a turn to every addressed lane in parallel, writes the
   results into the conversation, and runs TL;DR / Fusion. Also routes a
   message (decision model chain with fallbacks) and runs the judge. DOM-free:
   the UI passes `save` and `onChange` callbacks. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.runner = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  const NO_KEY = 'Add your OpenRouter API key in Settings';
  const NO_ALLOWED_MODEL = 'No allowed model fits — loosen filters or remove images';
  const NATIVE_NAME = 'OpenRouter Auto';
  const DECISION_TIMEOUT = 15000;
  const MAX_DECISION_LIST = 30;   // route.candidates when rules decide
  const MAX_ALLOWED_MODELS = 100; // native allowed_models
  const IMAGE_ERRORS = [400, 413, 422];
  const EMPTY_POOL = {
    filters: 'No model fits your model filters — loosen them to route this message',
    images: 'No model in the pool reads images — remove the images or widen the pool',
    free: 'No free model fits — loosen the filters or pick another mode',
    selection: 'Your selection has no models to route to — add models or pick from the whole catalog',
  };
  const EMPTY_POOL_DEFAULT = 'No models available to route to';

  const hasImagePart = (state) => (state || []).some((p) => p && typeof p === 'object' && p.type === 'image_url');

  // Sums the usage of several decision calls; cost null when none was known.
  function sumUsage(list) {
    if (!list.length) return undefined;
    const known = list.filter((u) => typeof u.cost === 'number');
    return {
      inputTokens: list.reduce((n, u) => n + (u.inputTokens || 0), 0),
      cost: known.length ? Math.round(known.reduce((n, u) => n + u.cost, 0) * 1e12) / 1e12 : null,
    };
  }

  // The auto-router plugin for a native lane: the turn's allowed pool, or the
  // latest native route's pool for a reply outside a routed turn.
  function autoRouterPlugin(conv, turn) {
    let route = turn.route;
    if (!route || route.method !== 'native') {
      route = conv.turns.slice(0, turn.index).reverse().map((t) => t.route).find((r) => r && r.method === 'native');
    }
    const plugin = { id: 'auto-router' };
    if (route && Array.isArray(route.candidates) && route.candidates.length) plugin.allowed_models = route.candidates.slice(0, MAX_ALLOWED_MODELS);
    return plugin;
  }

  // loadAttachments(ids) -> {id: dataURL}; getModel(id) -> catalog model (for PDF
  // engine choice); getPdfMode() -> 'auto' | 'ocr'.
  function createRunner({
    api = MC.api, getKey, save, onChange = () => {}, saveThrottleMs = 1000,
    loadAttachments = async () => ({}), getModel = () => undefined, getPdfMode = () => 'auto',
  }) {
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
      const native = lane.modelId === MC.router.NATIVE_ID;
      if (native) delete r.servedModel;
      const { token, ctrl } = begin(conv, turn.id + ':' + laneId);
      try {
        const ids = MC.conv.attachmentIdsFor(conv, laneId, turn.index);
        const urls = ids.length ? await loadAttachments(ids) : {};
        const hasPdf = conv.turns.some((t) => (t.attachments || []).some((r) => r.kind === 'pdf' && ids.includes(r.id)));
        const plugins = hasPdf ? [{ id: 'file-parser', pdf: { engine: MC.attach.pdfEngine(getModel(lane.modelId), getPdfMode()) } }] : [];
        if (native) plugins.push(autoRouterPlugin(conv, turn));
        const res = await api.streamChat({
          key,
          model: lane.modelId,
          messages: MC.conv.buildMessages(conv, laneId, turn.index, (id) => urls[id] || null),
          plugins: plugins.length ? plugins : undefined,
          extraBody: native ? { session_id: conv.id } : undefined,
          signal: ctrl.signal,
          onDelta(t) {
            r.content += t;
            onChange(conv, { turnId: turn.id, laneId });
            throttledSave(conv);
          },
        });
        r.content = res.content;
        r.usage = res.usage || undefined;
        if (native && res.servedModel) r.servedModel = res.servedModel;
        r.status = 'done';
        const q = MC.clarify.detect(r.content);
        r.asksQuestion = q.asks;
        r.question = q.question || undefined;
      } catch (err) {
        if (err && err.partial && err.partial.length > r.content.length) r.content = err.partial;
        if (err && err.status === 'aborted') r.status = 'stopped';
        else {
          r.status = 'error';
          r.error = native && err && err.status === 404 && /No models match/i.test(err.message || '') ? NO_ALLOWED_MODEL : errText(err, lane.modelId);
          r.errorStatus = err && err.status;
        }
      } finally {
        end(conv, token);
        MC.conv.touch(conv);
        onChange(conv, { turnId: turn.id, laneId });
      }
    }

    async function send(conv, kind, inputs, extra) {
      const turn = MC.conv.addTurn(conv, kind, inputs, extra);
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
      if (turn.tldr) MC.cost.addReplaced(turn, 'derived', turn.tldr.usage);
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
        if (res.usage) d.usage = res.usage;
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
      if (turn.fusion) MC.cost.addReplaced(turn, 'derived', turn.fusion.usage);
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
        if (res.usage) turn.fusion.usage = res.usage;
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

    // ---- routing (spec §5.7–§5.9) ----

    // One decision call with its own AbortController, aborted by a timer or
    // by `signal`. Resolves even when the api ignores its signal. A timeout
    // throws an error with status 'timeout'; an outer abort status 'aborted'.
    async function decideOnce(key, model, req, signal, timeoutMs) {
      if (signal && signal.aborted) throw new MC.api.ApiError('aborted', 'Stopped');
      const ctrl = new AbortController();
      let timer;
      let onAbort;
      const cut = new Promise((resolve, reject) => {
        const fail = (err) => { ctrl.abort(); reject(err); };
        timer = setTimeout(() => fail(Object.assign(new Error('timed out'), { status: 'timeout' })), timeoutMs);
        onAbort = () => fail(new MC.api.ApiError('aborted', 'Stopped'));
        if (signal) signal.addEventListener('abort', onAbort);
      });
      try {
        return await Promise.race([api.decide({ key, model, state: req.state, questions: req.questions, signal: ctrl.signal }), cut]);
      } catch (err) {
        if (signal && signal.aborted) throw new MC.api.ApiError('aborted', 'Stopped');
        throw err;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }

    // A decision failure that must stop the send (no fallback), or null.
    function fatalDecision(err) {
      const s = err && err.status;
      if (s === 'aborted') return { ok: false, reason: 'aborted', message: 'Stopped' };
      if (s === 401) return { ok: false, reason: 'auth', message: MC.api.errorMessage(err) };
      if (s === 402) return { ok: false, reason: 'credits', message: MC.api.errorMessage(err) };
      return null;
    }

    // Spec §5.9 steps 2–5: pool → native | rules | decider chain → ranking.
    async function route(opts) {
      const t0 = Date.now();
      const {
        text, attachments = [], images = {}, models = [], deciders = [], starred = [], selection = [], filters = {},
        systemPrompt, contextNote, textContents, signal, timeoutMs = DECISION_TIMEOUT,
      } = opts || {};
      const s = MC.router.withDefaults(opts && opts.settings);
      const { mode, count } = s;
      const pool = MC.router.candidates(models, { mode, pool: s.pool, selection, manualPool: s.manualPool, filters, attachments });
      if (!pool.list.length) return { ok: false, reason: 'empty', message: EMPTY_POOL[pool.reason] || EMPTY_POOL_DEFAULT };
      if (signal && signal.aborted) return fatalDecision({ status: 'aborted' });

      const notes = [];
      if (pool.list.length < count) notes.push(`only ${pool.list.length} models fit (${pool.reason || 'pool'})`);
      const usages = [];
      const byId = new Map(pool.list.map((m) => [m.id, m]));
      const finish = (route, picks) => {
        if (notes.length) route.note = notes.join('; ');
        const usage = sumUsage(usages);
        if (usage) route.usage = usage;
        route.ms = Date.now() - t0;
        return { ok: true, route, picks };
      };
      const byRules = () => {
        const picks = MC.router.rulesPick(pool.list, mode, count);
        return finish({
          mode, count, method: 'rules', picks: picks.map((m) => ({ modelId: m.id, p: null })),
          candidates: pool.list.slice(0, MAX_DECISION_LIST).map((m) => m.id),
        }, picks);
      };

      if (mode === 'native') {
        const known = models.find((m) => m.id === MC.router.NATIVE_ID);
        return finish({
          mode, count, method: 'native', picks: [{ modelId: MC.router.NATIVE_ID, p: null }],
          candidates: pool.list.slice(0, MAX_ALLOWED_MODELS).map((m) => m.id),
        }, [Object.assign({}, known, { id: MC.router.NATIVE_ID, name: NATIVE_NAME })]);
      }

      const chain = MC.router.chooseDecider(deciders, {
        mode, decisionModel: s.decisionModel, starred, allowPaidInFree: s.allowPaidInFree,
        hasImages: attachments.some((a) => a && a.kind === 'image'),
      });
      if (!chain.length) {
        notes.push(mode === 'free' ? 'no free decision model available' : 'no decision model available');
        return byRules();
      }
      if (pool.list.length < 2) return byRules();   // nothing to choose between
      const key = getKey();
      if (!key) return { ok: false, reason: 'auth', message: NO_KEY };

      let lastErr = null;
      let lastModel = null;
      for (const decider of chain) {
        const request = (imgs) => MC.router.decisionRequest({
          mode, candidates: pool.list, decider, text, systemPrompt, contextNote, attachments, images: imgs, textContents,
        });
        let req = request(images);
        let withoutImages = false;
        if (req.candidateIds.length < 2) {
          lastErr = new Error('the message is too long for the decision model');
          lastModel = decider.id;
          continue;
        }
        for (;;) {
          try {
            const res = await decideOnce(key, decider.id, req, signal, timeoutMs);
            if (res.usage) usages.push(res.usage);
            if (withoutImages) notes.push('decided without the images');
            const picks = MC.router.rank(res.answers, req.candidateIds, pool.list, mode, count);
            const route = { mode, count, method: 'model', decisionModel: decider.id };
            const task = MC.router.taskOf(res.answers);
            if (task) route.task = task;
            Object.assign(route, { picks, candidates: req.candidateIds });
            return finish(route, picks.map((x) => byId.get(x.modelId)));
          } catch (err) {
            const fatal = fatalDecision(err);
            if (fatal) return fatal;
            if (!withoutImages && IMAGE_ERRORS.includes(err && err.status) && hasImagePart(req.state)) {
              withoutImages = true;
              req = request({});
              continue;
            }
            lastErr = err;
            lastModel = decider.id;
            break;
          }
        }
      }
      notes.push('decision failed: ' + errText(lastErr, lastModel));
      return byRules();
    }

    // Very best answer judge (spec §5.8): one decision over the turn's
    // answers, trying `deciderChain` in order (fallback as in route()).
    async function runJudge(conv, turnId, deciderChain) {
      const turn = MC.conv.turnById(conv, turnId);
      if (!turn) return null;
      const laneByModel = {};
      const answers = [];
      for (const laneId of MC.conv.answeredLanes(turn)) {
        const lane = MC.conv.laneById(conv, laneId);
        if (!lane || laneByModel[lane.modelId]) continue;
        laneByModel[lane.modelId] = laneId;
        answers.push({ modelId: lane.modelId, name: lane.modelName, content: turn.responses[laneId].content });
      }
      if (answers.length < 2) return null;
      const text = turn.inputs[laneByModel[answers[0].modelId]];

      if (turn.judge) MC.cost.addReplaced(turn, 'judge', turn.judge.usage);
      turn.judge = { status: 'streaming', createdAt: Date.now() };
      onChange(conv, { turnId, derived: 'judge' });
      const key = getKey();
      const { token, ctrl } = begin(conv, turnId + ':judge');
      let modelId;
      try {
        if (!key) throw Object.assign(new Error(NO_KEY), { noKey: true });
        const chain = (deciderChain || []).slice(0, 2);
        if (!chain.length) throw new Error('No decision model available');
        let lastErr = null;
        for (const decider of chain) {
          modelId = decider.id;
          try {
            const res = await decideOnce(key, decider.id, MC.router.judgeRequest({ text, answers, decider }), ctrl.signal, DECISION_TIMEOUT);
            const win = MC.router.judgeResult(res.answers, laneByModel);
            turn.judge = win
              ? { modelId, laneId: win.laneId, p: win.p, usage: res.usage, status: 'done', createdAt: Date.now() }
              : { modelId, usage: res.usage, status: 'error', error: 'The judge gave no valid answer', createdAt: Date.now() };
            lastErr = null;
            break;
          } catch (err) {
            if (fatalDecision(err)) throw err;
            lastErr = err;
          }
        }
        if (lastErr) throw lastErr;
      } catch (err) {
        turn.judge = { modelId, status: 'error', error: err.noKey ? NO_KEY : errText(err, modelId), createdAt: Date.now() };
      } finally {
        end(conv, token);
        MC.conv.touch(conv);
        onChange(conv, { turnId, derived: 'judge' });
        await save(conv);
      }
      return turn.judge;
    }

    return { send, retry, stop, stopConversation, stopAll, isBusy, liveConversation, runTldr, runFusion, route, runJudge };
  }

  return { createRunner, NO_KEY };
});
