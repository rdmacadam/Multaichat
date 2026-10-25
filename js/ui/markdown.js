/* MC.md — small, safe Markdown renderer. The whole source is HTML-escaped
   first; formatting is applied to the escaped text, so model output can never
   inject markup. Tolerates unterminated code fences (streaming). */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.md = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MC) {
  'use strict';

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
      /^https?:\/\//i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
  }

  const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));

  function blocks(lines) {
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = /^\s*```\s*([\w+-]*)/.exec(line))) {
        flush();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        const cls = m[1] ? ` class="lang-${m[1]}"` : '';
        out.push(`<pre><code${cls}>${code.join('\n')}</code><button class="copy" data-copy>Copy</button></pre>`);
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush();
        const n = Math.min(m[1].length, 4);
        out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      } else if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        i--;
        out.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        out.push('<hr>');
      } else if ((m = LIST.exec(line))) {
        flush();
        const ordered = /\d/.test(m[1]);
        const items = [];
        while (i < lines.length && (m = LIST.exec(lines[i]))) { items.push(inline(m[2])); i++; }
        i--;
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>` + items.map((it) => `<li>${it}</li>`).join('') + `</${tag}>`);
      } else if (/^&gt;\s?/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) q.push(lines[i++].replace(/^&gt;\s?/, ''));
        i--;
        out.push('<blockquote>' + blocks(q) + '</blockquote>');
      } else if (!line.trim()) {
        flush();
      } else {
        para.push(line);
      }
    }
    flush();
    return out.join('');
  }

  function render(src) {
    return blocks(MC.util.escapeHtml(String(src || '')).replace(/\r\n?/g, '\n').split('\n'));
  }

  return { render };
});
