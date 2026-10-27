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

  // ⓘ button with a tooltip: hover (600 ms), focus, click toggles; leave, blur, Escape hide.
  let infoSeq = 0;
  function info(text) {
    const id = 'tip-' + (++infoSeq);
    const tip = h('span', { role: 'tooltip', id, class: 'tip', hidden: true }, text);
    const btn = h('button', { type: 'button', class: 'info', 'aria-label': 'More info', 'aria-describedby': id }, 'ⓘ');
    let timer = null;
    const place = () => {
      const r = btn.getBoundingClientRect();
      const w = tip.offsetWidth, ht = tip.offsetHeight;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
      const top = r.top - ht - 6 < 8 ? r.bottom + 6 : r.top - ht - 6;
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    };
    const show = () => { clearTimeout(timer); tip.hidden = false; place(); };
    const hide = () => { clearTimeout(timer); tip.hidden = true; };
    btn.addEventListener('mouseenter', () => { clearTimeout(timer); timer = setTimeout(show, 600); });
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('focus', show);
    btn.addEventListener('blur', hide);
    // A press that moves focus onto the button has already shown the tip; its click must not hide it again.
    let pressFocused = false;
    btn.addEventListener('pointerdown', () => { pressFocused = document.activeElement !== btn; });
    btn.addEventListener('click', () => {
      if (pressFocused) { pressFocused = false; if (!tip.hidden) return; }
      if (tip.hidden) show(); else hide();
    });
    btn.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tip.hidden) { e.stopPropagation(); hide(); } });
    return h('span', { class: 'info-wrap' }, btn, tip);
  }

  MC.dom = { info, h, append, clear, toast, openDialog, closeDialog, copyText, shortName, isTyping, autoGrow, download };
})(window.MC = window.MC || {});
