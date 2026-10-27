/* Presets dialog, preset save/edit form, the chat's system-prompt chip and
   its editor. */
(function (MC) {
  'use strict';
  const { h, clear, toast, openDialog, closeDialog, shortName } = MC.dom;
  const app = () => MC.app;
  const store = () => MC.app.state.presets;
  const modelName = (id) => shortName((app().modelById(id) || { name: id }).name);

  function currentModels() {
    const s = app().state;
    return s.conv ? s.conv.lanes.filter((l) => l.active).map((l) => l.modelId) : s.settings.get().selected;
  }

  function head(title, dlg) {
    return h('header', { class: 'dialog-head' }, h('h2', {}, title),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: () => closeDialog(dlg) }, '✕'));
  }

  // ---------- list ----------
  function open() {
    const dlg = document.getElementById('presets-dialog');
    clear(dlg);
    const parts = (p) => [p.systemPrompt ? '📝 system prompt' : null, p.template ? '💬 template' : null,
      p.models ? `🤖 ${p.models.length} model${p.models.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    const rows = store().list().map((p) => h('div', { class: 'preset-row', dataset: { id: p.id } },
      h('div', { class: 'preset-main' },
        h('strong', {}, p.name), p.builtIn ? h('span', { class: 'badge' }, 'built-in') : null,
        h('div', { class: 'muted small' }, parts(p))),
      h('div', { class: 'row' },
        h('button', { class: 'primary small', onclick: () => { closeDialog(dlg); app().applyPreset(p.id); } }, 'Apply'),
        p.builtIn ? null : h('button', { class: 'ghost small', onclick: () => openForm(Object.assign({}, p, { include: includeAll(p) })) }, 'Edit'),
        h('button', { class: 'ghost small', onclick: () => { store().duplicate(p.id); open(); } }, 'Duplicate'),
        p.builtIn ? null : h('button', {
          class: 'ghost small', onclick: () => { if (confirm(`Delete preset "${p.name}"?`)) { store().remove(p.id); open(); app().refresh(); } },
        }, 'Delete'))));
    dlg.append(h('div', { class: 'dialog-body' },
      head('Presets', dlg),
      h('div', { class: 'row wrap' },
        h('button', { class: 'ghost small', onclick: () => openForm({ name: '', systemPrompt: '', template: '', models: [], include: { systemPrompt: true, models: false, template: true } }) }, '＋ New preset'),
        h('button', { class: 'ghost small', onclick: () => saveCurrent() }, 'Save current as preset')),
      h('div', { class: 'preset-list' }, rows)));
    openDialog(dlg);
  }

  const includeAll = (p) => ({ systemPrompt: !!p.systemPrompt, models: !!(p.models && p.models.length), template: !!p.template });

  function saveCurrent(systemPrompt) {
    const holder = app().promptHolder();
    openForm(MC.presets.fromCurrent({
      systemPrompt: systemPrompt != null ? systemPrompt : holder.systemPrompt || '',
      models: currentModels(),
      template: MC.ui.composer.getText(),
    }));
  }

  // ---------- save / edit form ----------
  function openForm(initial) {
    const dlg = document.getElementById('preset-save-dialog');
    clear(dlg);
    let models = (initial.models || []).slice();
    const name = h('input', { type: 'text', name: 'name', placeholder: 'Preset name', value: initial.name || '', required: true });
    const incSys = h('input', { type: 'checkbox', checked: initial.include.systemPrompt });
    const incModels = h('input', { type: 'checkbox', checked: initial.include.models });
    const incTpl = h('input', { type: 'checkbox', checked: initial.include.template });
    const sys = h('textarea', { name: 'systemPrompt', rows: 4, placeholder: 'Instructions every model gets' });
    sys.value = initial.systemPrompt || '';
    const tpl = h('textarea', { name: 'template', rows: 3, placeholder: 'Text inserted into the message box' });
    tpl.value = initial.template || '';
    const modelList = h('div', { class: 'chips' });
    const showModels = () => {
      clear(modelList).append(...(models.length ? models.map((m) => h('span', { class: 'chip small', title: m }, modelName(m))) : [h('span', { class: 'muted small' }, 'No models')]));
    };
    showModels();
    const pick = h('button', {
      type: 'button', class: 'ghost small',
      onclick: () => MC.ui.picker.open({ mode: 'select', selected: models, onDone: (ids) => { models = ids; incModels.checked = ids.length > 0; showModels(); } }),
    }, 'Choose models');

    const submit = (e) => {
      e.preventDefault();
      const p = {
        id: initial.id, name: name.value,
        systemPrompt: incSys.checked ? sys.value : '',
        template: incTpl.checked ? tpl.value : '',
        models: incModels.checked ? models : [],
      };
      if (!p.systemPrompt.trim() && !p.template.trim() && !p.models.length) { toast('Keep at least one part: system prompt, models or template', 'warn'); return; }
      try {
        const saved = store().save(p);
        closeDialog(dlg);
        toast(`Saved preset "${saved.name}"`);
        if (document.getElementById('presets-dialog').open) open();
        app().refresh();
      } catch (err) { toast(err.message, 'warn'); name.focus(); }
    };

    dlg.append(h('form', { class: 'dialog-body', onsubmit: submit },
      head(initial.id ? 'Edit preset' : 'Save preset', dlg),
      h('label', {}, 'Name'), name,
      h('section', {}, h('label', { class: 'check' }, incSys, ' System prompt'), sys),
      h('section', {}, h('label', { class: 'check' }, incModels, ' Models'), h('div', { class: 'row wrap' }, modelList, pick)),
      h('section', {}, h('label', { class: 'check' }, incTpl, ' Message template'), tpl),
      h('footer', { class: 'dialog-foot' },
        h('button', { type: 'button', class: 'ghost', onclick: () => closeDialog(dlg) }, 'Cancel'),
        h('button', { type: 'submit', class: 'primary' }, 'Save preset'))));
    openDialog(dlg);
    name.focus();
  }

  // ---------- system prompt editor ----------
  function openSystemPrompt() {
    const dlg = document.getElementById('sysprompt-dialog');
    clear(dlg);
    const holder = app().promptHolder();
    const preset = holder.presetId ? store().get(holder.presetId) : null;
    const ta = h('textarea', { rows: 8, placeholder: 'Instructions every model in this chat gets, e.g. "Answer in German."' });
    ta.value = holder.systemPrompt || '';
    const edited = preset && MC.presets.isEdited(holder, preset);
    const apply = () => { app().setChatSystemPrompt(ta.value, holder.presetId); closeDialog(dlg); };
    dlg.append(h('form', { class: 'dialog-body', onsubmit: (e) => { e.preventDefault(); apply(); } },
      head('System prompt for this chat', dlg),
      preset ? h('p', { class: 'muted small' }, `From preset "${preset.name}"${edited ? ' (edited)' : ''}. Changes apply from the next message.`) :
        h('p', { class: 'muted small' }, 'Sent to every model in this chat. Changes apply from the next message.'),
      ta,
      h('footer', { class: 'dialog-foot' },
        h('button', { type: 'button', class: 'ghost', onclick: () => { app().setChatSystemPrompt(''); closeDialog(dlg); } }, 'Clear'),
        edited && !preset.builtIn ? h('button', {
          type: 'button', class: 'ghost',
          onclick: () => {
            store().save(Object.assign({}, preset, { systemPrompt: ta.value }));
            app().setChatSystemPrompt(ta.value, preset.id);
            closeDialog(dlg);
            toast(`Updated preset "${preset.name}"`);
          },
        }, 'Update preset') : null,
        h('button', { type: 'button', class: 'ghost', onclick: () => { closeDialog(dlg); saveCurrent(ta.value); } }, edited ? 'Save as new preset' : 'Save as preset'),
        h('button', { type: 'submit', class: 'primary' }, 'Save'))));
    openDialog(dlg);
    ta.focus();
  }

  // ---------- chip ----------
  function chip() {
    const label = MC.presets.presetLabel(app().promptHolder(), store());
    return h('div', { class: 'sys-bar' }, label
      ? h('button', { class: 'sys-chip', title: 'Edit this chat\'s system prompt', onclick: openSystemPrompt }, '📝 ' + label)
      : h('button', { class: 'link small sys-add', onclick: openSystemPrompt }, '＋ System prompt'));
  }

  MC.ui = MC.ui || {};
  MC.ui.presets = { open, openForm, openSystemPrompt, saveCurrent, chip };
})(window.MC);
