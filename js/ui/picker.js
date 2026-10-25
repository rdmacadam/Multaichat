/* Model picker dialog (search + suggestion sections) and the header
   quick-add combobox. */
(function (MC) {
  'use strict';
  const { h, clear, openDialog, closeDialog, shortName, toast } = MC.dom;
  const U = MC.util;

  function price(m) {
    if (m.free) return h('span', { class: 'badge free' }, 'FREE');
    if (m.priceIn == null) return h('span', { class: 'muted' }, '—');
    const f = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2).replace(/\.?0+$/, '') : n.toFixed(3).replace(/\.?0+$/, ''));
    return h('span', { class: 'price', title: 'USD per million tokens: input / output' }, `$${f(m.priceIn)} / $${f(m.priceOut)}`);
  }

  function badges(m, now) {
    return [
      m.isNew(now) ? h('span', { class: 'badge new', title: 'Released in the last 30 days' }, '🆕') : null,
      m.open ? h('span', { class: 'badge open', title: 'Open-weight model' }, 'OPEN') : null,
    ];
  }

  function row(m, selected, onToggle, now) {
    const el = h('div', {
      class: 'model-row' + (selected ? ' selected' : ''), role: 'option', 'aria-selected': String(!!selected), tabindex: '-1',
      dataset: { id: m.id }, onclick: () => onToggle(m.id),
    },
      h('span', { class: 'tick', 'aria-hidden': 'true' }, selected ? '✓' : ''),
      h('span', { class: 'model-main' },
        h('span', { class: 'model-name' }, shortName(m.name)),
        h('span', { class: 'model-sub' }, m.provider, ' · ', U.formatTokens(m.context), ' ctx')),
      h('span', { class: 'model-meta' }, badges(m, now), price(m)));
    return el;
  }

  function open({ mode = 'select', selected = [], onDone }) {
    const dlg = document.getElementById('picker-dialog');
    const app = MC.app;
    const sel = new Set(selected);
    const ui = { query: '', showAllFree: false, showAllOpen: false, sort: 'newest', freeOnly: false, openOnly: false, maxPrice: '', active: 0 };
    let finished = false;
    clear(dlg);

    const search = h('input', { type: 'search', class: 'picker-search', placeholder: 'Search models — try "free llama", "open coder", "new"', 'aria-label': 'Search models', autocomplete: 'off' });
    const body = h('div', { class: 'picker-body', role: 'listbox', 'aria-multiselectable': String(mode === 'select') });
    const count = h('span', { class: 'muted small' });
    const stale = h('span', { class: 'muted small' });

    const finish = (apply) => {
      if (finished) return;
      finished = true;
      closeDialog(dlg);
      if (apply && onDone) onDone([...sel]);
    };

    const toggle = (id) => {
      if (mode === 'single') { sel.clear(); sel.add(id); finish(true); return; }
      sel.has(id) ? sel.delete(id) : sel.add(id);
      render();
    };

    function section(title, list, extra) {
      if (!list.length) return null;
      return h('div', { class: 'picker-section' }, h('h3', {}, title), list.map((m) => row(m, sel.has(m.id), toggle, now())), extra || null);
    }

    const now = () => Date.now();

    function render() {
      const models = app.state.models;
      const keepScroll = body.scrollTop;
      clear(body);
      if (ui.query.trim()) {
        const res = MC.models.search(models, ui.query, now());
        body.append(res.length ? section(`Results (${res.length})`, res) : h('p', { class: 'muted empty' }, 'No models match.'));
      } else {
        const s = MC.models.sections(models, now());
        const more = (flag, n, label) => (n > 12 ? h('button', { class: 'link', onclick: () => { ui[flag] = !ui[flag]; render(); } }, ui[flag] ? 'Show fewer' : `${label} (${n})`) : null);
        let all = MC.models.filter(MC.models.sortBy(s.all, ui.sort), { freeOnly: ui.freeOnly, openOnly: ui.openOnly, maxPrice: ui.maxPrice === '' ? null : ui.maxPrice });
        const allTools = h('div', { class: 'row wrap all-tools' },
          h('select', { 'aria-label': 'Sort models', onchange: (e) => { ui.sort = e.target.value; render(); } },
            [['newest', 'Newest'], ['price', 'Cheapest'], ['context', 'Largest context']].map(([v, l]) => h('option', { value: v, selected: ui.sort === v }, l))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.freeOnly, onchange: (e) => { ui.freeOnly = e.target.checked; render(); } }), ' Free only'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.openOnly, onchange: (e) => { ui.openOnly = e.target.checked; render(); } }), ' Open-weight only'),
          h('label', { class: 'check' }, 'Max $/M out ', h('input', { type: 'number', min: '0', step: '0.5', class: 'num', value: ui.maxPrice, onchange: (e) => { ui.maxPrice = e.target.value; render(); } })));
        body.append(
          section('Top picks', s.top),
          section('Free', ui.showAllFree ? s.free : s.free.slice(0, 12), more('showAllFree', s.free.length, 'Show all free')),
          section('Open-weight: new & powerful', ui.showAllOpen ? MC.models.filter(MC.models.sortBy(s.all, 'newest'), { openOnly: true }) : s.open,
            h('button', { class: 'link', onclick: () => { ui.showAllOpen = !ui.showAllOpen; render(); } }, ui.showAllOpen ? 'Show fewer' : `Show all open-weight (${s.all.filter((m) => m.open).length})`)),
          h('div', { class: 'picker-section' }, h('h3', {}, `All models (${all.length})`), allTools, all.map((m) => row(m, sel.has(m.id), toggle, now()))));
      }
      body.scrollTop = keepScroll;
      count.textContent = mode === 'select' ? `${sel.size} selected` : '';
      const info = app.state.modelsInfo;
      stale.textContent = info && info.stale ? (info.source === 'fallback' ? 'Offline list' : 'Cached list (offline)') : '';
      highlight(Math.min(ui.active, rows().length - 1));
    }

    const rows = () => [...body.querySelectorAll('.model-row')];
    function highlight(i) {
      const rs = rows();
      rs.forEach((r) => r.classList.remove('active'));
      if (!rs.length) return;
      ui.active = Math.max(0, Math.min(i, rs.length - 1));
      rs[ui.active].classList.add('active');
    }

    search.addEventListener('input', U.debounce(() => { ui.query = search.value; ui.active = 0; body.scrollTop = 0; render(); }, 100));
    dlg.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT' || (e.target.type === 'number')) return;
      const rs = rows();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        highlight(ui.active + (e.key === 'ArrowDown' ? 1 : -1));
        const r = rows()[ui.active];
        if (r) r.scrollIntoView({ block: 'nearest' });
      } else if ((e.key === 'Enter' || (e.key === ' ' && e.target !== search)) && rs[ui.active] && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        toggle(rs[ui.active].dataset.id);
      }
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(mode === 'select'); }, { once: true });

    const freeBtn = h('button', {
      class: 'ghost small', title: 'Select the three newest free models',
      onclick: () => {
        const free = MC.models.sections(app.state.models, now()).free.slice(0, 3);
        if (!free.length) { toast('No free models available', 'warn'); return; }
        sel.clear(); free.forEach((m) => sel.add(m.id)); render();
      },
    }, 'Try with free models');
    const refreshBtn = h('button', {
      class: 'icon small', title: 'Refresh model list', 'aria-label': 'Refresh model list',
      onclick: async () => { refreshBtn.disabled = true; await app.refreshModels(true); refreshBtn.disabled = false; render(); },
    }, '🔄');

    dlg.append(h('div', { class: 'dialog-body picker' },
      h('header', { class: 'dialog-head' },
        h('h2', {}, mode === 'single' ? 'Choose a model' : 'Choose models'),
        h('div', { class: 'row' }, stale, refreshBtn, h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => finish(mode === 'select') }, '✕'))),
      search,
      mode === 'select' ? h('div', { class: 'row spread picker-tools' }, count, freeBtn) : null,
      body,
      mode === 'select' ? h('footer', { class: 'dialog-foot' }, h('button', { class: 'primary', onclick: () => finish(true) }, 'Done')) : null));
    render();
    openDialog(dlg);
    search.focus();
  }

  function mountQuickAdd(container, onPick) {
    const input = h('input', { type: 'search', class: 'quick-input', placeholder: '+ Add model', 'aria-label': 'Add a model', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false' });
    const list = h('div', { class: 'quick-list', role: 'listbox', hidden: true });
    let items = [];
    let active = 0;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const pick = (m) => { input.value = ''; close(); onPick(m.id); };
    const fill = () => {
      const app = MC.app;
      const have = new Set(app.state.conv ? app.state.conv.lanes.filter((l) => l.active).map((l) => l.modelId) : app.state.settings.get().selected);
      const pool = input.value.trim() ? MC.models.search(app.state.models, input.value) : MC.models.sections(app.state.models).top;
      items = pool.filter((m) => !have.has(m.id)).slice(0, 8);
      active = 0;
      clear(list);
      items.forEach((m, i) => list.appendChild(h('div', {
        class: 'quick-item' + (i === 0 ? ' active' : ''), role: 'option',
        onmousedown: (e) => { e.preventDefault(); pick(m); },
      }, h('span', {}, shortName(m.name)), h('span', { class: 'muted small' }, m.free ? 'FREE' : m.provider))));
      list.hidden = !items.length;
      input.setAttribute('aria-expanded', String(!list.hidden));
    };
    input.addEventListener('focus', fill);
    input.addEventListener('input', U.debounce(fill, 100));
    input.addEventListener('blur', () => setTimeout(close, 100));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
        [...list.children].forEach((c, i) => c.classList.toggle('active', i === active));
      } else if (e.key === 'Enter' && items[active]) { e.preventDefault(); pick(items[active]); }
      else if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
    });
    container.append(input, list);
  }

  MC.ui = MC.ui || {};
  MC.ui.picker = { open, mountQuickAdd };
})(window.MC);
