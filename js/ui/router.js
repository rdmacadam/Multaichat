/* Router panel (🧭): router on/off, mode, count, pool, decision model list,
   extras; plus the label shared by the toolbar button and composer chip. */
(function (MC) {
  'use strict';
  const { h, append, clear, openDialog, closeDialog, info } = MC.dom;
  const U = MC.util;
  const app = () => MC.app;

  const SHORT = { auto: 'Auto', free: 'Free', diverse: 'Diverse', best: 'Best', manual: 'Manual', native: 'Native' };
  const MODE_INFO = {
    auto: ['Full auto', 'The decision model picks, balancing quality and price.',
      'The decision model picks the best models for this message, weighing answer quality against price.'],
    free: ['Best free', 'Only free models, picked by a free decision model.',
      'Only free models are considered, and a free decision model picks among them. If no free decision model works, the newest free models are picked by simple rules, so this mode stays free.'],
    diverse: ['Diverse perspectives', 'Strong models from different providers.',
      'Picks strong models from different providers so you see different viewpoints. Pairs well with Fusion.'],
    best: ['Very best answer', 'The strongest models for this message, whatever the price.',
      'Picks the strongest models for this message and ignores price. Optionally fuses their answers or lets a judge mark the best one.'],
    manual: ['Full manual', 'You choose the pool and the decision model.',
      'You choose the models the router may pick from and the decision model.'],
    native: ['OpenRouter native', "OpenRouter's Auto Router picks one model.",
      "OpenRouter's own Auto Router picks one model per message from your allowed pool. The answer shows which model was used."],
  };
  const INFO = {
    router: 'When on, a decision model chooses which of your models answer each message you send to everyone. Replies to one model are never routed.',
    count: 'How many models answer each routed message. 1 means a single model. OpenRouter native always uses 1.',
    pool: 'Whole catalog: any model that passes your model filters. Only my current selection: just the models in the toolbar.',
    decider: "The model that makes the routing decision. Decision models don't chat; they choose quickly and cost a fraction of a cent. ★ marks your favourites; they are tried in order if the first one fails.",
    fusion: 'After the answers arrive, Fusion merges them into one answer grouped by topic (uses your Fusion model).',
    judge: 'After the answers arrive, the decision model reads them and marks the best one with 🏆. Costs one more small decision.',
    preview: "Shows the router's picks first so you can change them or cancel before anything is sent.",
    paid: 'If no free decision model works, use your paid one instead of simple rules. The answers themselves stay free.',
  };
  const MAX_COUNT = 8;

  function current() { return MC.router.withDefaults(app().state.settings.get().router); }

  function save(patch) {
    const next = MC.router.withDefaults(Object.assign(current(), patch));
    app().state.settings.set({ router: next });
    app().refresh();
    return next;
  }

  function starred() {
    const s = app().state.settings.get().starredDeciders;
    return Array.isArray(s) ? s.filter((id) => typeof id === 'string') : MC.storage.DEFAULT_SETTINGS.starredDeciders.slice();
  }

  function label(settings) {
    const r = MC.router.withDefaults(settings && settings.router);
    if (!r.enabled) return '🧭 Off';
    if (r.mode === 'native') return '🧭 Native';
    return `🧭 ${SHORT[r.mode]} ×${r.count}`;
  }

  // Composer placeholder while the router is on.
  function placeholder(settings) {
    const r = MC.router.withDefaults(settings && settings.router);
    if (r.mode === 'native') return 'Ask — OpenRouter picks the model…';
    return `Ask — the router picks ${r.count} model${r.count === 1 ? '' : 's'}…`;
  }

  // ---------- decision model list ----------
  function priceText(d) {
    if (d.priceIn == null) return '—';
    return '$' + Number(d.priceIn.toPrecision(3)) + '/M in';
  }

  function deciderList(onChoose) {
    const ui = { query: '', images: false, files: false, free: false };
    const search = h('input', { type: 'search', class: 'decider-search', placeholder: 'Search decision models', 'aria-label': 'Search decision models', autocomplete: 'off' });
    const box = (cls, text, key) => {
      const el = h('input', { type: 'checkbox', class: cls, onchange: () => { ui[key] = el.checked; render(); } });
      return h('label', { class: 'check' }, el, ' ' + text);
    };
    const currentEl = h('div', { class: 'decider-current' });
    const body = h('div', { class: 'decider-list', role: 'listbox', 'aria-label': 'Decision models' });

    const filtering = () => ui.query.trim() || ui.images || ui.files || ui.free;
    const matches = (d) => {
      const q = ui.query.trim().toLowerCase();
      if (q && !q.split(/\s+/).every((w) => (d.name + ' ' + d.id).toLowerCase().includes(w))) return false;
      return (!ui.images || d.images) && (!ui.files || d.files) && (!ui.free || d.free);
    };

    function toggleStar(id) {
      const s = starred();
      const next = s.includes(id) ? s.filter((x) => x !== id) : s.concat(id);
      app().state.settings.set({ starredDeciders: next });
      render();
    }

    function row(d, isStarred, chosen) {
      const star = h('button', {
        type: 'button', class: 'star icon small', 'aria-pressed': String(isStarred),
        'aria-label': (isStarred ? 'Unstar ' : 'Star ') + d.name,
        onclick: (e) => { e.stopPropagation(); toggleStar(d.id); },
      }, isStarred ? '★' : '☆');
      return h('div', {
        class: 'decider-row' + (chosen ? ' selected' : ''), role: 'option', 'aria-selected': String(chosen), tabindex: '0',
        dataset: { id: d.id },
        onclick: () => onChoose(d.id),
        onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onChoose(d.id); } },
      },
        star,
        h('span', { class: 'decider-main' },
          h('span', { class: 'decider-name' }, d.name),
          d.desc ? h('span', { class: 'decider-desc muted small' }, d.desc) : null),
        h('span', { class: 'decider-meta' },
          d.images ? h('span', { class: 'badge img', title: 'Accepts images' }, '🖼') : null,
          d.files ? h('span', { class: 'badge file', title: 'Accepts files' }, '📄') : null,
          d.free ? h('span', { class: 'badge free' }, 'FREE') : h('span', { class: 'price' }, priceText(d)),
          h('span', { class: 'muted' }, U.formatTokens(d.context) + ' ctx')));
    }

    function missingRow(id) {
      return h('div', { class: 'decider-row unavailable', dataset: { id }, 'aria-disabled': 'true' },
        h('button', { type: 'button', class: 'star icon small', 'aria-pressed': 'true', 'aria-label': 'Unstar ' + id, onclick: () => toggleStar(id) }, '★'),
        h('span', { class: 'decider-main' }, h('span', { class: 'decider-name' }, id),
          h('span', { class: 'muted small' }, 'not available right now')));
    }

    function render() {
      const deciders = app().state.deciders || [];
      const byId = new Map(deciders.map((d) => [d.id, d]));
      const stars = starred();
      const chosenId = current().decisionModel;
      const chosen = byId.get(chosenId);
      append(clear(currentEl), [h('span', { class: 'muted small' }, 'Using: '),
        h('strong', {}, chosen ? chosen.name : chosenId),
        chosen ? null : h('span', { class: 'muted small' }, ' (not available right now)')]);
      const keep = body.scrollTop;
      clear(body);
      const starRows = stars.map((id) => {
        const d = byId.get(id);
        if (!d) return filtering() ? null : missingRow(id);
        return matches(d) ? row(d, true, id === chosenId) : null;
      }).filter(Boolean);
      const rest = deciders.filter((d) => !stars.includes(d.id) && matches(d))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => row(d, false, d.id === chosenId));
      if (starRows.length) append(body, [h('h3', {}, '★ Starred'), starRows]);
      if (rest.length) append(body, [h('h3', {}, 'All decision models'), rest]);
      if (!starRows.length && !rest.length) {
        body.append(h('p', { class: 'muted empty' }, deciders.length ? 'No decision models match.' : 'The decision model list could not be loaded.'));
      }
      body.scrollTop = keep;
    }

    search.addEventListener('input', U.debounce(() => { ui.query = search.value; render(); }, 100));
    render();
    const el = h('div', { class: 'decider-picker' },
      currentEl,
      search,
      h('div', { class: 'row wrap decider-filters' },
        box('decider-images', '🖼 Images', 'images'), box('decider-files', '📄 Files', 'files'), box('decider-free', 'Free', 'free')),
      body);
    return { el, render };
  }

  // ---------- panel ----------
  let view = null;

  function rowLabel(text, tip) { return h('span', { class: 'router-label' }, h('strong', {}, text), info(tip)); }

  function open() {
    const dlg = document.getElementById('router-dialog');
    clear(dlg);
    const r = current();

    const enabled = h('input', { type: 'checkbox', role: 'switch', class: 'router-enabled', checked: r.enabled,
      onchange: () => { save({ enabled: enabled.checked }); sync(); } });

    const modeCards = MC.router.MODES.map((m) => {
      const [name, summary, tip] = MODE_INFO[m];
      const radio = h('input', { type: 'radio', name: 'router-mode', value: m, checked: r.mode === m,
        onchange: () => { if (radio.checked) { save({ mode: m }); sync(); } } });
      return h('div', { class: 'mode-card', dataset: { mode: m } },
        h('label', { class: 'mode-pick' }, radio,
          h('span', { class: 'mode-text' }, h('strong', {}, name), h('span', { class: 'muted small' }, summary))),
        info(tip));
    });

    const count = h('input', { type: 'number', class: 'num router-count', min: '1', max: String(MAX_COUNT), step: '1', 'aria-label': 'How many models',
      onchange: () => { save({ count: count.value }); sync(); } });
    const step = (d) => { save({ count: current().count + d }); sync(); };
    const down = h('button', { type: 'button', class: 'ghost small count-down', 'aria-label': 'Fewer models', onclick: () => step(-1) }, '−');
    const up = h('button', { type: 'button', class: 'ghost small count-up', 'aria-label': 'More models', onclick: () => step(1) }, '+');

    const poolRadio = (value, text) => {
      const el = h('input', { type: 'radio', name: 'router-pool', value, checked: r.pool === value,
        onchange: () => { if (el.checked) save({ pool: value }); } });
      return h('label', { class: 'check' }, el, ' ' + text);
    };

    const deciders = deciderList((id) => { save({ decisionModel: id }); deciders.render(); });

    const extra = (key, text, tip) => {
      const el = h('input', { type: 'checkbox', class: 'extra-' + key, checked: r.extras[key],
        onchange: () => save({ extras: Object.assign({}, current().extras, { [key]: el.checked }) }) });
      return h('span', { class: 'check' }, h('label', { class: 'check' }, el, ' ' + text), info(tip));
    };

    const manualCount = h('span', { class: 'muted small manual-count' });
    const choosePool = h('button', {
      type: 'button', class: 'ghost small',
      onclick: () => MC.ui.picker.open({
        mode: 'select', selected: current().manualPool,
        onDone: (ids) => { save({ manualPool: ids }); sync(); openDialog(dlg); },
      }),
    }, 'Choose pool models…');

    const preview = h('input', { type: 'checkbox', class: 'router-preview', checked: r.preview,
      onchange: () => save({ preview: preview.checked }) });
    const paid = h('input', { type: 'checkbox', class: 'router-paid', checked: r.allowPaidInFree,
      onchange: () => save({ allowPaidInFree: paid.checked }) });

    const rows = {
      pool: h('section', { class: 'row-pool' }, rowLabel('Pick from', INFO.pool),
        h('div', { class: 'row wrap' }, poolRadio('catalog', 'Whole catalog'), poolRadio('selection', 'Only my current selection'))),
      decider: h('section', { class: 'row-decider' }, rowLabel('Decision model', INFO.decider), deciders.el),
      extras: h('section', { class: 'row-extras' }, h('strong', {}, 'Very best extras'),
        h('div', { class: 'row wrap' }, extra('fusion', 'Fuse the answers', INFO.fusion), extra('judge', 'Judge marks the best answer', INFO.judge))),
      manual: h('section', { class: 'row-manual' }, rowLabel('Manual pool', MODE_INFO.manual[2]),
        h('div', { class: 'row wrap' }, choosePool, manualCount)),
      paid: h('section', { class: 'row-paid' }, h('span', { class: 'check' },
        h('label', { class: 'check' }, paid, ' Allow a paid decision model when no free one works'), info(INFO.paid))),
    };

    function sync() {
      const c = current();
      enabled.checked = c.enabled;
      dlg.querySelectorAll('input[name="router-mode"]').forEach((el) => { el.checked = el.value === c.mode; });
      dlg.querySelectorAll('.mode-card').forEach((el) => el.classList.toggle('selected', el.dataset.mode === c.mode));
      const native = c.mode === 'native';
      count.value = String(native ? 1 : c.count);
      count.disabled = native;
      down.disabled = native || c.count <= 1;
      up.disabled = native || c.count >= MAX_COUNT;
      rows.pool.hidden = c.mode === 'manual';
      rows.decider.hidden = native;
      rows.extras.hidden = c.mode !== 'best';
      rows.manual.hidden = c.mode !== 'manual';
      rows.paid.hidden = c.mode !== 'free';
      manualCount.textContent = `${c.manualPool.length} chosen`;
      body.classList.toggle('router-off', !c.enabled);
    }

    const body = h('div', { class: 'dialog-body router-panel' },
      h('header', { class: 'dialog-head' }, h('h2', {}, '🧭 Router'),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => closeDialog(dlg) }, '✕')),
      h('div', { class: 'router-scroll' },
        h('div', { class: 'router-switch' }, h('label', { class: 'check' }, enabled, ' ', h('strong', {}, 'Router')), info(INFO.router)),
        h('section', { class: 'row-mode' }, h('strong', {}, 'Mode'), h('div', { class: 'mode-cards', role: 'radiogroup', 'aria-label': 'Router mode' }, modeCards)),
        h('section', { class: 'row-count' }, rowLabel('How many models', INFO.count), h('div', { class: 'row' }, down, count, up)),
        rows.pool, rows.decider, rows.extras, rows.manual,
        h('section', { class: 'row-preview' }, h('span', { class: 'check' },
          h('label', { class: 'check' }, preview, ' Preview before sending'), info(INFO.preview))),
        rows.paid));
    dlg.append(body);
    view = { dlg, deciders };
    sync();
    openDialog(dlg);
  }

  // ---------- preview (spec §6.4) ----------
  // Shows the router's picks before sending. Resolves to
  // { action: 'send', picks } | { action: 'selection' } | null (cancelled).
  function preview(result) {
    const dlg = document.getElementById('route-preview-dialog');
    clear(dlg);
    const route = result.route;
    const pOf = new Map((route.picks || []).map((x) => [x.modelId, x.p]));
    let picks = result.picks.slice();
    // Native mode routes inside OpenRouter: there is nothing to add.
    const pool = route.method === 'native' ? [] : (route.candidates || []).map((id) => app().modelById(id)).filter(Boolean);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        dlg.oncancel = null;
        closeDialog(dlg);
        resolve(value);
      };
      dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
      const chips = h('div', { class: 'pick-chips', role: 'list' });
      const add = h('select', { class: 'pick-add', 'aria-label': 'Add from pool' });
      const send = h('button', { type: 'button', class: 'primary', onclick: () => { if (picks.length) finish({ action: 'send', picks: picks.slice() }); } }, 'Send');
      add.addEventListener('change', () => {
        const m = pool.find((x) => x.id === add.value);
        if (m && !picks.some((x) => x.id === m.id)) picks.push(m);
        render();
      });

      function render() {
        clear(chips);
        for (const m of picks) {
          const p = pOf.get(m.id);
          chips.append(h('span', { class: 'chip pick-chip', role: 'listitem', dataset: { id: m.id }, title: m.id },
            MC.dom.shortName(m.name),
            p == null ? null : h('span', { class: 'muted small' }, ' ' + Math.round(p * 100) + ' %'),
            h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + MC.dom.shortName(m.name),
              onclick: () => { picks = picks.filter((x) => x !== m); render(); } }, '✕')));
        }
        if (!picks.length) chips.append(h('span', { class: 'muted small' }, 'No models picked — add one from the pool.'));
        const rest = pool.filter((m) => !picks.some((x) => x.id === m.id));
        clear(add);
        append(add, [h('option', { value: '' }, '＋ Add from pool'), rest.map((m) => h('option', { value: m.id }, MC.dom.shortName(m.name)))]);
        add.value = '';
        add.hidden = !pool.length;
        add.disabled = !rest.length;
        send.disabled = !picks.length;
      }

      render();
      dlg.append(h('div', { class: 'dialog-body route-preview' },
        h('header', { class: 'dialog-head' }, h('h2', {}, '🧭 Router picks'),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => finish(null) }, '✕')),
        route.task ? h('p', { class: 'muted small route-task' }, 'task: ' + route.task) : null,
        route.note ? h('p', { class: 'muted small' }, route.note) : null,
        chips,
        add,
        h('footer', { class: 'dialog-foot' },
          h('button', { type: 'button', class: 'ghost', onclick: () => finish(null) }, 'Cancel'),
          h('button', { type: 'button', class: 'ghost', onclick: () => finish({ action: 'selection' }) }, 'Send to my selection instead'),
          send)));
      openDialog(dlg);
      send.focus();
    });
  }

  // Re-renders the decision model list when the panel is open (e.g. after a refresh).
  function update() { if (view && view.dlg.open) view.deciders.render(); }

  MC.ui = MC.ui || {};
  MC.ui.router = { open, label, placeholder, update, preview };
})(window.MC);
