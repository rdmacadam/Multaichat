'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
load('util');
load('attach');
const C = load('conversation');
const F = load('fusion');

function convWithAnswers() {
  const conv = C.create([{ id: 'a/one', name: 'One' }, { id: 'b/two', name: 'Two' }]);
  const [A, B] = conv.lanes.map((l) => l.id);
  const t = C.addTurn(conv, 'broadcast', C.broadcastInputs(conv, 'Why is the sky blue?'));
  Object.assign(t.responses[A], { status: 'done', content: 'Rayleigh scattering of sunlight.' });
  Object.assign(t.responses[B], { status: 'done', content: 'Because   of Rayleigh\nscattering, mostly.' });
  return { conv, t };
}

test('tldrMessages has system rules, the question and per-model headings', () => {
  const { conv, t } = convWithAnswers();
  const m = F.tldrMessages(conv, t);
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, /3–6 bullet points/);
  assert.match(m[1].content, /Why is the sky blue\?/);
  assert.match(m[1].content, /### One\nRayleigh scattering of sunlight\./);
  assert.match(m[1].content, /### Two\n/);
});

test('fusionMessages lists model ids and requests JSON only', () => {
  const { conv, t } = convWithAnswers();
  const m = F.fusionMessages(conv, t);
  assert.match(m[0].content, /"topics"/);
  assert.match(m[0].content, /JSON/);
  assert.match(m[1].content, /model id: a\/one/);
  assert.match(m[1].content, /model id: b\/two/);
});

const answers = { 'a/one': 'Rayleigh scattering of sunlight.', 'b/two': 'Because   of Rayleigh\nscattering, mostly.' };

test('parse handles fences and prose, defaults optional fields', () => {
  const text = 'Sure! Here it is:\n```json\n{"topics":[{"title":"Cause","merged":"Rayleigh.","models":["a/one","b/two"],"excerpts":[{"model":"b/two","quote":"because of rayleigh scattering"}]}]}\n```\nHope that helps';
  const r = F.parse(text, answers);
  assert.equal(r.ok, true);
  assert.equal(r.data.overview, '');
  assert.deepEqual(r.data.disagreements, []);
  assert.deepEqual(r.data.unique, []);
  assert.equal(r.data.topics[0].excerpts[0].verified, true);
});

test('parse rejects invalid JSON and missing topics', () => {
  assert.deepEqual(F.parse('not json at all', answers), { ok: false, raw: 'not json at all' });
  assert.equal(F.parse('{"overview":"x"}', answers).ok, false);
});

test('parse drops unknown model ids everywhere', () => {
  const obj = {
    overview: 'o',
    topics: [{ title: 'T', merged: 'm', models: ['a/one', 'ghost/x'], excerpts: [{ model: 'ghost/x', quote: 'q' }, { model: 'a/one', quote: 'Rayleigh scattering' }] }],
    disagreements: [{ point: 'p', positions: [{ model: 'ghost/x', position: 'no' }, { model: 'b/two', position: 'yes' }] }],
    unique: [{ model: 'ghost/x', point: 'u' }, { model: 'a/one', point: 'sunlight' }],
  };
  const r = F.parse(JSON.stringify(obj), answers);
  assert.deepEqual(r.data.topics[0].models, ['a/one']);
  assert.deepEqual(r.data.topics[0].excerpts.map((e) => e.model), ['a/one']);
  assert.deepEqual(r.data.disagreements[0].positions.map((p) => p.model), ['b/two']);
  assert.deepEqual(r.data.unique.map((u) => u.model), ['a/one']);
});

test('invented quotes are marked unverified', () => {
  const obj = { topics: [{ title: 'T', merged: 'm', models: ['a/one'], excerpts: [{ model: 'a/one', quote: 'the ocean reflects' }] }] };
  assert.equal(F.parse(JSON.stringify(obj), answers).data.topics[0].excerpts[0].verified, false);
});

test('answersByModel builds model-id map from a turn', () => {
  const { conv, t } = convWithAnswers();
  assert.deepEqual(Object.keys(F.answersByModel(conv, t)), ['a/one', 'b/two']);
});

test('tldr mentions attachments', () => {
  const { conv, t } = convWithAnswers();
  t.attachments = [{ id: 'i1', kind: 'image', name: 'a.png' }, { id: 'p1', kind: 'pdf', name: 'd.pdf' }];
  assert.match(F.tldrMessages(conv, t)[1].content, /\[1 image attached\] \[1 PDF attached\]/);
  assert.match(F.fusionMessages(conv, t)[1].content, /\[1 image attached\]/);
});
