'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
load('util');
const A = load('attach');
const MB = 1024 * 1024;

test('limits', () => {
  assert.deepEqual(A.LIMITS, { maxFiles: 10, maxImageBytes: 20971520, maxPdfBytes: 20971520, maxTextBytes: 204800, maxImageSide: 2048 });
});

test('classify by MIME and extension', () => {
  assert.equal(A.classify({ name: 'a.png', type: 'image/png' }), 'image');
  assert.equal(A.classify({ name: 'a.jpg', type: 'image/jpeg' }), 'image');
  assert.equal(A.classify({ name: 'a.webp', type: 'image/webp' }), 'image');
  assert.equal(A.classify({ name: 'a.gif', type: 'image/gif' }), 'image');
  assert.equal(A.classify({ name: 'a.svg', type: 'image/svg+xml' }), null);
  assert.equal(A.classify({ name: 'doc.pdf', type: 'application/pdf' }), 'pdf');
  assert.equal(A.classify({ name: 'notes.md', type: '' }), 'text');
  assert.equal(A.classify({ name: 'x.csv', type: 'text/csv' }), 'text');
  assert.equal(A.classify({ name: 'main.RS', type: '' }), 'text');
  assert.equal(A.classify({ name: 'setup.exe', type: 'application/octet-stream' }), null);
});

test('validate counts, sizes and types', () => {
  const f = (name, type, size) => ({ name, type, size });
  assert.deepEqual(A.validate([f('a.png', 'image/png', 10)]), { ok: true });
  assert.deepEqual(A.validate(Array.from({ length: 11 }, (_, i) => f(i + '.png', 'image/png', 1))), { ok: false, error: 'Up to 10 attachments per message' });
  assert.deepEqual(A.validate([f('big.pdf', 'application/pdf', 21 * MB)]), { ok: false, error: 'big.pdf is larger than 20 MB' });
  assert.deepEqual(A.validate([f('big.png', 'image/png', 21 * MB)]), { ok: false, error: 'big.png is larger than 20 MB' });
  assert.deepEqual(A.validate([f('setup.exe', '', 5)]), { ok: false, error: 'setup.exe: unsupported file type' });
  assert.deepEqual(A.validate([f('huge.txt', 'text/plain', 5 * MB)]), { ok: true });
});

test('textBlock format and truncation', () => {
  assert.equal(A.textBlock('n.md', 'hi'), '\n\n--- file: n.md ---\nhi\n--- end of n.md ---');
  const long = 'x'.repeat(204801);
  const b = A.textBlock('l.txt', long);
  assert.ok(b.includes('x'.repeat(204800) + '\n…[truncated at 200 KB]\n--- end of l.txt ---'));
  assert.ok(!b.includes('x'.repeat(204801)));
});

const refs = [
  { id: 'i1', kind: 'image', name: 'tiny.png', mime: 'image/png', size: 1 },
  { id: 'p1', kind: 'pdf', name: 'doc.pdf', mime: 'application/pdf', size: 2 },
  { id: 't1', kind: 'text', name: 'notes.md', mime: 'text/markdown', size: 3 },
];

test('toParts per kind, text skipped, missing resolves to unavailable', () => {
  const parts = A.toParts(refs, (id) => ({ i1: 'data:image/png;base64,AA', p1: 'data:application/pdf;base64,BB' })[id]);
  assert.deepEqual(parts, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,BB' } },
  ]);
  assert.deepEqual(A.toParts(refs.slice(0, 1), () => null), [{ type: 'text', text: '[attachment unavailable: tiny.png]' }]);
});

test('omittedLines and summaryNote', () => {
  const two = [refs[0], Object.assign({}, refs[0], { id: 'i2', name: 'b.jpg' })];
  assert.equal(A.omittedLines(two), '[image omitted: tiny.png]\n[image omitted: b.jpg]');
  assert.equal(A.summaryNote(refs), '[1 image attached] [1 PDF attached]');
  assert.equal(A.summaryNote(two.concat([refs[1], refs[1]])), '[2 images attached] [2 PDFs attached]');
  assert.equal(A.summaryNote([refs[2]]), '');
  assert.equal(A.summaryNote(undefined), '');
});

test('incapable lanes include unknown models', () => {
  const lanes = [{ id: 'L1', modelId: 'a/vision' }, { id: 'L2', modelId: 'b/text' }, { id: 'L3', modelId: 'c/gone' }];
  const byId = { 'a/vision': { images: true }, 'b/text': { images: false } };
  assert.deepEqual(A.incapable(lanes, byId), ['L2', 'L3']);
});

test('pdfEngine per model and mode', () => {
  assert.equal(A.pdfEngine({ files: true }, 'auto'), 'native');
  assert.equal(A.pdfEngine({ files: true }, 'ocr'), 'native');
  assert.equal(A.pdfEngine({ files: false }, 'auto'), 'pdf-text');
  assert.equal(A.pdfEngine(undefined, 'auto'), 'pdf-text');
  assert.equal(A.pdfEngine({ files: false }, 'ocr'), 'mistral-ocr');
});

test('buildInputs skip', () => {
  const r = A.buildInputs({ text: 'Look', refs, textContents: { t1: 'N' }, laneIds: ['L1', 'L2'], incapableIds: ['L2'], choice: 'skip' });
  const body = 'Look\n\n--- file: notes.md ---\nN\n--- end of notes.md ---';
  assert.deepEqual(r, { inputs: { L1: body }, delivery: { L1: 'full' }, skipped: { L2: "can't read images" } });
});

test('buildInputs text only', () => {
  const r = A.buildInputs({ text: 'Look', refs: refs.slice(0, 1), textContents: {}, laneIds: ['L1', 'L2'], incapableIds: ['L2'], choice: 'text' });
  assert.deepEqual(r, { inputs: { L1: 'Look', L2: 'Look\n\n[image omitted: tiny.png]' }, delivery: { L1: 'full', L2: 'text' }, skipped: {} });
});

test('buildInputs without images ignores choice', () => {
  const r = A.buildInputs({ text: '', refs: refs.slice(1), textContents: { t1: 'N' }, laneIds: ['L1', 'L2'], incapableIds: ['L2'], choice: 'skip' });
  assert.deepEqual(Object.keys(r.inputs), ['L1', 'L2']);
  assert.deepEqual(r.delivery, { L1: 'full', L2: 'full' });
  assert.ok(r.inputs.L1.startsWith('--- file: notes.md ---'), 'no leading blank lines when text is empty');
});

test('buildInputs keys text contents by attachment id (same names stay distinct)', () => {
  const two = [{ id: 'tA', kind: 'text', name: 'README.md' }, { id: 'tB', kind: 'text', name: 'README.md' }];
  const r = A.buildInputs({ text: 'Compare', refs: two, textContents: { tA: 'first', tB: 'second' }, laneIds: ['L1'], incapableIds: [], choice: null });
  assert.ok(r.inputs.L1.includes('README.md ---\nfirst\n'));
  assert.ok(r.inputs.L1.includes('README.md ---\nsecond\n'));
});

test('blobType never lets stored data pick an active type', () => {
  assert.equal(A.blobType({ kind: 'text', mime: 'text/html' }), 'text/plain;charset=utf-8');
  assert.equal(A.blobType({ kind: 'pdf', mime: 'text/html' }), 'application/pdf');
  assert.equal(A.blobType({ kind: 'image', mime: 'image/webp' }), 'image/webp');
  assert.equal(A.blobType({ kind: 'image', mime: 'text/html' }), 'application/octet-stream');
  assert.equal(A.blobType({ kind: 'image', mime: 'image/svg+xml' }), 'application/octet-stream');
  assert.equal(A.blobType({ kind: 'html', mime: 'text/html' }), 'application/octet-stream');
});

test('validRecord accepts only well-formed records', () => {
  const ok = (r) => A.validRecord(Object.assign({ id: 'a1', name: 'x' }, r));
  assert.equal(ok({ kind: 'image', data: 'data:image/png;base64,AA' }), true);
  assert.equal(ok({ kind: 'image', data: 'data:text/html;base64,PHNjcmlwdD4=' }), false);
  assert.equal(ok({ kind: 'image', data: 'data:image/svg+xml;base64,AA' }), false);
  assert.equal(ok({ kind: 'pdf', data: 'data:application/pdf;base64,AA' }), true);
  assert.equal(ok({ kind: 'pdf', data: 'data:text/html;base64,AA' }), false);
  assert.equal(ok({ kind: 'text', data: '<script>x</script>' }), true);
  assert.equal(ok({ kind: 'text', data: 5 }), false);
  assert.equal(ok({ kind: 'html', data: 'x' }), false);
  assert.equal(A.validRecord(null), false);
  assert.equal(A.validRecord({ kind: 'text', data: 'x', name: 'n' }), false, 'needs id');
});
