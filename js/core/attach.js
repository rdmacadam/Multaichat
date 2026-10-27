/* MC.attach — attachment rules: classification, limits, how each kind is
   sent to OpenRouter, and which lanes receive what. Pure. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.attach = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MB20 = 20 * 1024 * 1024;
  const LIMITS = Object.freeze({ maxFiles: 10, maxImageBytes: MB20, maxPdfBytes: MB20, maxTextBytes: 200 * 1024, maxImageSide: 2048 });
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const TEXT_EXT = ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'py',
    'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'toml', 'ini', 'log'];
  const SKIP_REASON = "can't read images";

  function ext(name) {
    const m = /\.([^.]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function classify({ name, type }) {
    if (IMAGE_TYPES.includes(type)) return 'image';
    if (type === 'application/pdf' || (!type && ext(name) === 'pdf')) return 'pdf';
    if ((type && type.startsWith('text/')) || TEXT_EXT.includes(ext(name))) return 'text';
    return null;
  }

  function validate(files) {
    if (files.length > LIMITS.maxFiles) return { ok: false, error: `Up to ${LIMITS.maxFiles} attachments per message` };
    for (const f of files) {
      const kind = classify(f);
      if (!kind) return { ok: false, error: `${f.name}: unsupported file type` };
      if ((kind === 'image' && f.size > LIMITS.maxImageBytes) || (kind === 'pdf' && f.size > LIMITS.maxPdfBytes)) {
        return { ok: false, error: `${f.name} is larger than 20 MB` };
      }
    }
    return { ok: true };
  }

  function textBlock(name, text) {
    let body = String(text == null ? '' : text);
    if (body.length > LIMITS.maxTextBytes) body = body.slice(0, LIMITS.maxTextBytes) + '\n…[truncated at 200 KB]';
    return `\n\n--- file: ${name} ---\n${body}\n--- end of ${name} ---`;
  }

  function toParts(refs, resolve) {
    const parts = [];
    for (const r of refs || []) {
      if (r.kind !== 'image' && r.kind !== 'pdf') continue;
      const url = resolve ? resolve(r.id) : null;
      if (!url) parts.push({ type: 'text', text: `[attachment unavailable: ${r.name}]` });
      else if (r.kind === 'image') parts.push({ type: 'image_url', image_url: { url } });
      else parts.push({ type: 'file', file: { filename: r.name, file_data: url } });
    }
    return parts;
  }

  const images = (refs) => (refs || []).filter((r) => r.kind === 'image');

  function omittedLines(refs) {
    return images(refs).map((r) => `[image omitted: ${r.name}]`).join('\n');
  }

  function summaryNote(refs) {
    const n = images(refs).length;
    const p = (refs || []).filter((r) => r.kind === 'pdf').length;
    const out = [];
    if (n) out.push(`[${n} image${n === 1 ? '' : 's'} attached]`);
    if (p) out.push(`[${p} PDF${p === 1 ? '' : 's'} attached]`);
    return out.join(' ');
  }

  function incapable(lanes, modelsById) {
    return lanes.filter((l) => !(modelsById[l.modelId] && modelsById[l.modelId].images)).map((l) => l.id);
  }

  function pdfEngine(model, pdfMode) {
    if (model && model.files) return 'native';
    return pdfMode === 'ocr' ? 'mistral-ocr' : 'pdf-text';
  }

  // Per-lane inputs for a message with attachments. Text files are inlined for
  // everyone; images/PDFs travel as parts (added later by buildMessages) to
  // 'full' lanes. Lanes that can't read images are skipped or sent text only.
  // textContents is keyed by attachment id (two files may share a name).
  function buildInputs({ text, refs, textContents, laneIds, incapableIds, choice }) {
    let body = String(text || '');
    for (const r of refs || []) if (r.kind === 'text') body += textBlock(r.name, (textContents || {})[r.id]);
    if (!String(text || '').trim()) body = body.replace(/^\n+/, '');
    const hasImages = images(refs).length > 0;
    const inputs = {};
    const delivery = {};
    const skipped = {};
    for (const id of laneIds) {
      const limited = hasImages && (incapableIds || []).includes(id);
      if (limited && choice === 'skip') { skipped[id] = SKIP_REASON; continue; }
      if (limited && choice === 'text') {
        inputs[id] = (body ? body + '\n\n' : '') + omittedLines(refs);
        delivery[id] = 'text';
        continue;
      }
      inputs[id] = body;
      delivery[id] = 'full';
    }
    return { inputs, delivery, skipped };
  }

  // MIME type for a stored record's blob URL. Stored data (user files, imports)
  // must never pick an active type like text/html: blob URLs run in our origin.
  function blobType(record) {
    if (record.kind === 'text') return 'text/plain;charset=utf-8';
    if (record.kind === 'pdf') return 'application/pdf';
    if (record.kind === 'image' && IMAGE_TYPES.includes(record.mime)) return record.mime;
    return 'application/octet-stream';
  }

  const DATA_URL = {
    image: /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]*$/,
    pdf: /^data:application\/pdf;base64,[A-Za-z0-9+/=]*$/,
  };

  // Shape check for records coming from imports.
  function validRecord(r) {
    if (!r || typeof r.id !== 'string' || !r.id || typeof r.name !== 'string') return false;
    if (r.kind === 'text') return typeof r.data === 'string';
    return !!DATA_URL[r.kind] && typeof r.data === 'string' && DATA_URL[r.kind].test(r.data);
  }

  return { LIMITS, TEXT_EXT, SKIP_REASON, blobType, validRecord, classify, validate, textBlock, toParts, omittedLines, summaryNote, incapable, pdfEngine, buildInputs };
});
