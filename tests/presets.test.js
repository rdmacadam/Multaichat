'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { memoryStorage } = require('./helpers');
load('util');
const P = load('presets');

test('built-ins are listed first and cannot be deleted', () => {
  const store = P.createPresetStore(memoryStorage());
  const list = store.list();
  assert.deepEqual(list.map((p) => p.id), ['builtin-concise', 'builtin-code-review', 'builtin-simple']);
  assert.equal(list[1].name, 'Code reviewer');
  assert.equal(list[1].template, 'Review this code:\n\n');
  assert.match(list[0].systemPrompt, /^You are a concise expert\./);
  assert.equal(store.remove('builtin-concise'), false);
  assert.equal(store.list().length, 3);
});

test('save assigns id, trims, drops empty parts, rejects blank name', () => {
  const ls = memoryStorage();
  const store = P.createPresetStore(ls);
  const p = store.save({ name: '  Mine ', systemPrompt: 'Be brief', template: '', models: [] });
  assert.match(p.id, /^p_/);
  assert.equal(p.name, 'Mine');
  assert.equal('template' in p, false);
  assert.equal('models' in p, false);
  assert.deepEqual(P.createPresetStore(ls).get(p.id), p);
  assert.throws(() => store.save({ name: '  ', systemPrompt: 'x' }), /Name required/);
});

test('save with a built-in id creates a new preset', () => {
  const store = P.createPresetStore(memoryStorage());
  const p = store.save({ id: 'builtin-simple', name: 'Simpler', systemPrompt: 'x' });
  assert.notEqual(p.id, 'builtin-simple');
  assert.equal(store.get('builtin-simple').name, 'Explain simply');
});

test('save updates an existing user preset in place', () => {
  const store = P.createPresetStore(memoryStorage());
  const p = store.save({ name: 'A', systemPrompt: 'one' });
  store.save(Object.assign({}, p, { systemPrompt: 'two' }));
  assert.equal(store.get(p.id).systemPrompt, 'two');
  assert.equal(store.userPresets().length, 1);
});

test('duplicate makes an editable copy', () => {
  const store = P.createPresetStore(memoryStorage());
  const d = store.duplicate('builtin-code-review');
  assert.equal(d.name, 'Code reviewer (copy)');
  assert.equal(d.builtIn, undefined);
  assert.equal(d.template, 'Review this code:\n\n');
  assert.equal(store.remove(d.id), true);
});

test('corrupt storage yields built-ins only', () => {
  const ls = memoryStorage();
  ls.setItem('mc.presets', '{bad');
  assert.equal(P.createPresetStore(ls).list().length, 3);
});

test('importMany adds user presets and skips built-ins', () => {
  const store = P.createPresetStore(memoryStorage());
  const n = store.importMany([{ id: 'p_x', name: 'X', systemPrompt: 's' }, { id: 'builtin-concise', name: 'hack', builtIn: true }]);
  assert.equal(n, 1);
  assert.equal(store.get('p_x').name, 'X');
  assert.match(store.get('builtin-concise').systemPrompt, /concise expert/);
});

const conv = (models, turns = 0) => ({ lanes: models.map((m, i) => ({ id: 'l' + i, modelId: m, active: true })), turns: Array.from({ length: turns }, () => ({})) });

test('applyPlan for no chat, empty chat and mid-chat', () => {
  const preset = { id: 'p1', name: 'P', systemPrompt: 'S', template: 'T', models: ['a/x', 'b/y'] };
  assert.deepEqual(P.applyPlan(preset, null), { models: ['a/x', 'b/y'], systemPrompt: 'S', presetId: 'p1', template: 'T', confirmModels: false });
  assert.equal(P.applyPlan(preset, conv(['c/z'])).confirmModels, false);
  assert.equal(P.applyPlan(preset, conv(['b/y', 'a/x'], 2)).confirmModels, false);
  assert.equal(P.applyPlan(preset, conv(['c/z'], 2)).confirmModels, true);
  const bare = P.applyPlan({ id: 'p2', name: 'Q', systemPrompt: 'S' }, conv(['c/z'], 1));
  assert.deepEqual([bare.models, bare.template, bare.confirmModels], [null, null, false]);
});

test('fromCurrent include flags', () => {
  assert.deepEqual(P.fromCurrent({ systemPrompt: 'S', models: ['a'], template: '  ' }),
    { name: '', systemPrompt: 'S', models: ['a'], template: '  ', include: { systemPrompt: true, models: true, template: false } });
  assert.deepEqual(P.fromCurrent({ systemPrompt: '', models: [], template: 'Hi' }).include, { systemPrompt: false, models: false, template: true });
});

test('isEdited compares system prompts', () => {
  assert.equal(P.isEdited({ systemPrompt: 'a' }, { systemPrompt: 'a' }), false);
  assert.equal(P.isEdited({ systemPrompt: 'b' }, { systemPrompt: 'a' }), true);
  assert.equal(P.isEdited({ systemPrompt: 'b' }, null), false);
});

test('presetLabel missing preset', () => {
  const store = P.createPresetStore(memoryStorage());
  assert.equal(P.presetLabel({ presetId: 'p_gone', systemPrompt: 'x' }, store), 'Custom');
  assert.equal(P.presetLabel({ systemPrompt: 'x' }, store), 'Custom');
  assert.equal(P.presetLabel({}, store), null);
  const concise = store.get('builtin-concise');
  assert.equal(P.presetLabel({ presetId: concise.id, systemPrompt: concise.systemPrompt }, store), 'Concise expert');
  assert.equal(P.presetLabel({ presetId: concise.id, systemPrompt: 'changed' }, store), 'Concise expert (edited)');
});
