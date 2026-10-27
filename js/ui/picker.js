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
      m.images ? h('span', { class: 'badge img', title: 'Accepts images' }, '🖼') : null,
      m.files ? h('span', { class: 'badge file', title: 'Accepts files (PDF)' }, '📄') : null,
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
    const ui = { query: '', showAllFree: false, showAllOpen: false, sort: 'newest', freeOnly: false, openOnly: false, active: 0 };
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
        const res = applyFilters(MC.models.search(models, ui.query, now()));
        body.append(res.length ? section(`Results (${res.length})`, res) : noMatch());
      } else {
        const raw = MC.models.sections(models, now());
        const s = { top: applyFilters(raw.top), free: applyFilters(raw.free), open: applyFilters(raw.open), all: applyFilters(raw.all) };
        const more = (flag, n, label) => (n > 12 ? h('button', { class: 'link', onclick: () => { ui[flag] = !ui[flag]; render(); } }, ui[flag] ? 'Show fewer' : `${label} (${n})`) : null);
        let all = MC.models.filter(MC.models.sortBy(s.all, ui.sort), { freeOnly: ui.freeOnly, openOnly: ui.openOnly });
        const allTools = h('div', { class: 'row wrap all-tools' },
          h('select', { 'aria-label': 'Sort models', onchange: (e) => { ui.sort = e.target.value; render(); } },
            [['newest', 'Newest'], ['price', 'Cheapest'], ['context', 'Largest context']].map(([v, l]) => h('option', { value: v, selected: ui.sort === v }, l))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.freeOnly, onchange: (e) => { ui.freeOnly = e.target.checked; render(); } }), ' Free only'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.openOnly, onchange: (e) => { ui.openOnly = e.target.checked; render(); } }), ' Open-weight only'));
        if (!s.all.length) body.append(noMatch());
        else body.append(
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

    // ---------- shared filters (persisted in settings.pickerFilters) ----------
    const filters = Object.assign({}, MC.storage.DEFAULT_SETTINGS.pickerFilters, app.state.settings.get().pickerFilters);
    function applyFilters(list) { return MC.models.filter(list, filters); }
    const fCount = h('span', { class: 'filter-count muted small' });
    const fMaxIn = h('input', { type: 'number', min: '0', step: '0.5', class: 'num filter-max-in', 'aria-label': 'Max input price per million tokens', placeholder: 'any' });
    const fMaxOut = h('input', { type: 'number', min: '0', step: '0.5', class: 'num filter-max-out', 'aria-label': 'Max output price per million tokens', placeholder: 'any' });
    const fCtx = h('select', { class: 'filter-context', 'aria-label': 'Minimum context length' },
      [['', 'Any'], ['32000', '32k+'], ['128000', '128k+'], ['200000', '200k+'], ['1000000', '1M+']].map(([v, l]) => h('option', { value: v }, l)));
    const fImg = h('input', { type: 'checkbox', class: 'filter-images' });
    const fFile = h('input', { type: 'checkbox', class: 'filter-files' });
    function syncFilterInputs() {
      fMaxIn.value = filters.maxIn; fMaxOut.value = filters.maxOut; fCtx.value = String(filters.minContext || '');
      fImg.checked = !!filters.images; fFile.checked = !!filters.files;
      const n = MC.models.activeFilterCount(filters);
      fCount.textContent = n ? `Filters (${n})` : 'Filters';
      clearLink.hidden = !n;
    }
    function setFilter(k, v) {
      filters[k] = v;
      app.state.settings.set({ pickerFilters: Object.assign({}, filters) });
      syncFilterInputs();
      ui.active = 0;
      render();
    }
    function clearFilters() {
      Object.assign(filters, MC.storage.DEFAULT_SETTINGS.pickerFilters);
      app.state.settings.set({ pickerFilters: Object.assign({}, filters) });
      syncFilterInputs();
      render();
    }
    function noMatch() {
      return MC.models.activeFilterCount(filters)
        ? h('div', { class: 'muted empty' }, 'No models match these filters. ', h('button', { class: 'link', onclick: clearFilters }, 'Clear filters'))
        : h('p', { class: 'muted empty' }, 'No models match.');
    }
    fMaxIn.addEventListener('change', () => setFilter('maxIn', fMaxIn.value));
    fMaxOut.addEventListener('change', () => setFilter('maxOut', fMaxOut.value));
    fCtx.addEventListener('change', () => setFilter('minContext', fCtx.value));
    fImg.addEventListener('change', () => setFilter('images', fImg.checked));
    fFile.addEventListener('change', () => setFilter('files', fFile.checked));
    const clearLink = h('button', { class: 'link small', onclick: clearFilters }, 'Clear filters');
    const filterBar = h('div', { class: 'filter-bar row wrap' },
      fCount,
      h('label', { class: 'check' }, 'Max in $/M ', fMaxIn),
      h('label', { class: 'check' }, 'Max out $/M ', fMaxOut),
      h('label', { class: 'check' }, 'Min context ', fCtx),
      h('label', { class: 'check' }, fImg, ' 🖼 Images'),
      h('label', { class: 'check' }, fFile, ' 📄 Files'),
      clearLink);

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
      if (e.target.tagName === 'SELECT' || e.target.type === 'number' || e.target.type === 'checkbox') return;
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
      filterBar,
      mode === 'select' ? h('div', { class: 'row spread picker-tools' }, count, freeBtn) : null,
      body,
      mode === 'select' ? h('footer', { class: 'dialog-foot' }, h('button', { class: 'primary', onclick: () => finish(true) }, 'Done')) : null));
    syncFilterInputs();
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
      items = MC.models.filter(pool, app.state.settings.get().pickerFilters).filter((m) => !have.has(m.id)).slice(0, 8);
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
