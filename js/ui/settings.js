/* Settings dialog: API key, summary/fusion models, auto-run, theme, data. */
(function (MC) {
  'use strict';
  const { h, clear, toast, openDialog, closeDialog, shortName } = MC.dom;

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  function modelLabel(id) {
    const m = MC.app.modelById(id);
    return m ? shortName(m.name) : id || 'Not set';
  }

  function open() {
    const app = MC.app;
    const cfg = app.state.settings.get();
    const dlg = document.getElementById('settings-dialog');
    clear(dlg);

    const keyInput = h('input', { type: 'password', id: 'set-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-or-v1-…', value: app.state.settings.getKey() });
    const showBtn = h('button', { type: 'button', class: 'ghost', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; showBtn.textContent = keyInput.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const keyStatus = h('span', { class: 'muted small' });
    const testBtn = h('button', {
      type: 'button', class: 'ghost',
      onclick: async () => {
        keyStatus.textContent = 'Checking…';
        const r = await MC.api.testKey({ key: MC.storage.normalizeKey(keyInput.value) });
        keyStatus.textContent = r.ok ? '✓ Key works' + (r.label ? ' (' + r.label + ')' : '') : '✗ Key rejected';
      },
    }, 'Test key');
    const remember = h('input', { type: 'checkbox', id: 'set-remember', checked: cfg.rememberKey });

    const picks = { summaryModel: cfg.summaryModel, fusionModel: cfg.fusionModel };
    const pickBtn = (field) => {
      const b = h('button', {
        type: 'button', class: 'ghost model-pick', dataset: { field },
        onclick: () => MC.ui.picker.open({
          mode: 'single', selected: [picks[field]].filter(Boolean),
          onDone: (ids) => { if (ids[0]) { picks[field] = ids[0]; b.textContent = modelLabel(ids[0]); } openDialog(dlg); },
        }),
      }, modelLabel(picks[field]));
      return b;
    };

    const autoTldr = h('input', { type: 'checkbox', checked: cfg.autoTldr });
    const autoFusion = h('input', { type: 'checkbox', checked: cfg.autoFusion });
    const theme = h('select', {}, ['system', 'light', 'dark'].map((t) => h('option', { value: t, selected: cfg.theme === t }, t[0].toUpperCase() + t.slice(1))));

    const save = () => {
      app.state.settings.set({
        rememberKey: remember.checked, summaryModel: picks.summaryModel, fusionModel: picks.fusionModel,
        autoTldr: autoTldr.checked, autoFusion: autoFusion.checked, theme: theme.value,
      });
      app.state.settings.setKey(keyInput.value, remember.checked);
      applyTheme(theme.value);
      closeDialog(dlg);
      app.refresh();
      toast('Settings saved');
    };

    const clearAll = async () => {
      if (!confirm('Delete your API key, settings and ALL conversations stored in this browser?')) return;
      for (const c of await app.state.store.all()) await app.state.store.delete(c.id);
      app.state.settings.clearAll();
      location.reload();
    };

    dlg.append(
      h('form', { method: 'dialog', class: 'dialog-body', onsubmit: (e) => { e.preventDefault(); save(); } },
        h('header', { class: 'dialog-head' }, h('h2', {}, 'Settings'), h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => closeDialog(dlg) }, '✕')),
        h('section', {},
          h('label', { for: 'set-key' }, 'OpenRouter API key'),
          h('div', { class: 'row' }, keyInput, showBtn, testBtn),
          h('div', { class: 'row' }, h('label', { class: 'check' }, remember, ' Remember on this device'), keyStatus),
          h('p', { class: 'muted small' }, 'Get a key at ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener noreferrer' }, 'openrouter.ai/keys'),
            '. It is stored only in this browser and sent only to OpenRouter.')),
        h('section', {},
          h('div', { class: 'row spread' }, h('span', {}, 'Summary model (TL;DR)'), pickBtn('summaryModel')),
          h('div', { class: 'row spread' }, h('span', {}, 'Fusion model'), pickBtn('fusionModel')),
          h('label', { class: 'check' }, autoTldr, ' Auto-run TL;DR when all answers finish'),
          h('label', { class: 'check' }, autoFusion, ' Auto-run Fusion when all answers finish')),
        h('section', {}, h('div', { class: 'row spread' }, h('span', {}, 'Theme'), theme)),
        h('section', {},
          h('p', { class: 'muted small' }, 'Conversations are saved in this browser only. Opening the app from a file and from a website keeps separate histories. Use Export in the sidebar for backups.'),
          h('button', { type: 'button', class: 'danger', onclick: clearAll }, 'Clear all local data')),
        h('footer', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'ghost', onclick: () => closeDialog(dlg) }, 'Cancel'), h('button', { type: 'submit', class: 'primary' }, 'Save'))));
    openDialog(dlg);
    keyInput.focus();
  }

  MC.ui = MC.ui || {};
  MC.ui.settings = { open, applyTheme };
})(window.MC);
