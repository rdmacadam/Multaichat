/* MC.dom — tiny DOM helpers shared by the UI modules. */
(function (MC) {
  'use strict';

  // h('div', {class: 'x', onclick: fn, dataset: {id: 1}}, 'text', childEl, [more])
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'html') el.innerHTML = v; // only ever pass MC.md.render output
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function toast(msg, kind = 'info', ms = 4000) {
    let box = document.getElementById('toasts');
    if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(box); }
    const t = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, msg);
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function openDialog(el) { if (!el.open) el.showModal(); }
  function closeDialog(el) { if (el.open) el.close(); }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch (e) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (e2) { toast('Copy failed', 'error'); }
      ta.remove();
    }
  }

  function shortName(name) { return String(name || '').split(': ').pop(); }

  function isTyping(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  // Textarea grows with content up to a max height.
  function autoGrow(ta, max = 240) {
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, max) + 'px'; };
    ta.addEventListener('input', fit);
    return fit;
  }

  function download(filename, text) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  MC.dom = { h, append, clear, toast, openDialog, closeDialog, copyText, shortName, isTyping, autoGrow, download };
})(window.MC = window.MC || {});
