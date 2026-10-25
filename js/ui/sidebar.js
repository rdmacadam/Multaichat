/* Sidebar: conversation list (forks nested under parents), search,
   rename/delete, export/import. */
(function (MC) {
  'use strict';
  const { h, clear, toast, download } = MC.dom;
  let filter = '';
  const state = { metas: [], currentId: null, fill: () => {} };

  function tree(metas) {
    const ids = new Set(metas.map((m) => m.id));
    const kids = {};
    const roots = [];
    for (const m of metas) {
      if (m.parentId && ids.has(m.parentId)) (kids[m.parentId] = kids[m.parentId] || []).push(m);
      else roots.push(m);
    }
    const out = [];
    const walk = (m, depth) => { out.push({ m, depth }); (kids[m.id] || []).forEach((k) => walk(k, depth + 1)); };
    roots.forEach((r) => walk(r, 0));
    return out;
  }

  function item(m, depth, currentId) {
    const app = MC.app;
    const title = h('span', { class: 'conv-title', title: m.title }, m.title || 'Untitled');
    const startRename = () => {
      const input = h('input', { class: 'rename', value: m.title });
      const done = async (commit) => {
        if (commit && input.value.trim()) await app.renameConversation(m.id, input.value.trim());
        else render(app.state.metas, app.state.conv && app.state.conv.id);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
      title.replaceWith(input);
      input.focus(); input.select();
    };
    return h('li', { class: 'conv' + (m.id === currentId ? ' current' : ''), style: `--depth:${depth}`, dataset: { id: m.id } },
      h('button', { class: 'conv-open', onclick: () => app.openConversation(m.id), ondblclick: startRename },
        depth ? h('span', { class: 'fork-mark', 'aria-hidden': 'true' }, '↳ ') : null, title),
      h('button', { class: 'icon small', title: 'Rename', 'aria-label': 'Rename', onclick: startRename }, '✎'),
      h('button', {
        class: 'icon small', title: 'Delete', 'aria-label': 'Delete',
        onclick: () => { if (confirm(`Delete "${m.title}"?`)) app.deleteConversation(m.id); },
      }, '🗑'));
  }

  function render(metas, currentId) {
    const app = MC.app;
    const root = document.getElementById('sidebar');
    clear(root);
    const search = h('input', { type: 'search', class: 'conv-search', placeholder: 'Search chats', value: filter, 'aria-label': 'Search chats' });
    const list = h('ul', { class: 'conv-list' });
    state.metas = metas;
    state.currentId = currentId;
    const fill = () => {
      const metas = state.metas;
      const currentId = state.currentId;
      clear(list);
      const q = filter.toLowerCase();
      const rows = q ? metas.filter((m) => (m.title || '').toLowerCase().includes(q)).map((m) => ({ m, depth: 0 })) : tree(metas);
      rows.forEach(({ m, depth }) => list.appendChild(item(m, depth, currentId)));
      if (!rows.length) list.appendChild(h('li', { class: 'muted small empty' }, q ? 'No matches' : 'No conversations yet'));
    };
    state.fill = fill;
    search.addEventListener('input', () => { filter = search.value; fill(); });
    fill();

    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try {
        const n = await app.importConversations(await f.text());
        toast(`Imported ${n} conversation${n === 1 ? '' : 's'}`);
      } catch (e) { toast(e.message, 'error'); }
      fileInput.value = '';
    });
    const stamp = () => new Date().toISOString().slice(0, 10);

    root.append(
      h('div', { class: 'side-head' },
        h('button', { class: 'primary block', onclick: () => app.newChat() }, '+ New chat'),
        search),
      list,
      h('div', { class: 'side-foot' },
        h('button', { class: 'ghost small', dataset: { exportCurrent: '1' }, disabled: !app.state.conv, onclick: () => download(`multaichat-${stamp()}.json`, MC.storage.exportJson([app.state.conv])) }, 'Export chat'),
        h('button', { class: 'ghost small', onclick: async () => download(`multaichat-all-${stamp()}.json`, MC.storage.exportJson(await app.state.store.all())) }, 'Export all'),
        h('button', { class: 'ghost small', onclick: () => fileInput.click() }, 'Import'),
        fileInput));
  }

  MC.ui = MC.ui || {};
  // Background refresh: rebuild only the list, and leave it alone while a
  // conversation is being renamed. The search box keeps its focus.
  function update(metas, currentId) {
    const root = document.getElementById('sidebar');
    const list = root.querySelector('.conv-list');
    if (!list || root.querySelector('.rename')) return;
    state.metas = metas;
    state.currentId = currentId;
    state.fill();
    const exp = root.querySelector('[data-export-current]');
    if (exp) exp.disabled = !MC.app.state.conv;
  }

  MC.ui.sidebar = { render, update };
})(window.MC);
