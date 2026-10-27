'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const Cost = load('cost');

test('summary adds every part', () => {
  const conv = { turns: [{ responses: {
      l1: { status: 'done', usage: { cost: 0.001 }, previous: [{ usage: { cost: 0.0005 } }] },
      l2: { status: 'done', usage: { cost: 0 }, previous: [] } },
    route: { usage: { cost: 0.00002 } }, tldr: { usage: { cost: 0.0001 } }, fusion: { usage: { cost: 0.0002 } },
    judge: { usage: { cost: 0.00003 } }, spentReplaced: { derived: 0.0004, judge: 0.00001 } }] };
  const s = Cost.summary(conv);
  assert.deepEqual(s.parts, { answers: 0.001, earlier: 0.0005, router: 0.00002, derived: 0.0007, judge: 0.00004 });
  assert.equal(Math.round(s.total * 1e8), Math.round(0.00226 * 1e8));
  assert.equal(s.unknown, 0);
});

test('summary counts finished answers without cost as unknown', () => {
  const conv = { turns: [{ responses: {
    l1: { status: 'done', usage: { cost: null }, previous: [{ usage: {} }] },
    l2: { status: 'done', usage: { cost: 0.5 } } } }] };
  const s = Cost.summary(conv);
  assert.equal(s.unknown, 2);
  assert.equal(s.total, 0.5);
});

test('summary ignores streaming and errors without usage', () => {
  const conv = { turns: [{ responses: {
    l1: { status: 'streaming' }, l2: { status: 'error' }, l3: { status: 'streaming', usage: { cost: 1 } } } }] };
  const s = Cost.summary(conv);
  assert.equal(s.total, 0);
  assert.equal(s.unknown, 0);
});

test('summary of null and of an old chat without new fields', () => {
  assert.deepEqual(Cost.summary(null), { total: 0, unknown: 0, parts: { answers: 0, earlier: 0, router: 0, derived: 0, judge: 0 } });
  const old = { turns: [{ id: 't', responses: { a: { status: 'done', content: 'x' } } }, { responses: {} }] };
  const s = Cost.summary(old);
  assert.equal(s.total, 0);
  assert.equal(s.unknown, 0);
});

test('summary counts unknown on route, tldr, fusion and judge usage', () => {
  const s = Cost.summary({ turns: [{ route: { usage: {} }, tldr: { usage: { cost: null } }, fusion: { usage: { cost: 0.1 } }, judge: { usage: {} } }] });
  assert.equal(s.unknown, 3);
  assert.equal(s.total, 0.1);
});

test('addReplaced adds lazily and ignores non-numeric cost', () => {
  const turn = {};
  Cost.addReplaced(turn, 'derived', undefined);
  Cost.addReplaced(turn, 'derived', { cost: null });
  Cost.addReplaced(turn, 'derived', {});
  assert.equal(turn.spentReplaced, undefined);
  Cost.addReplaced(turn, 'derived', { cost: 0.1 });
  Cost.addReplaced(turn, 'judge', { cost: 0.2 });
  Cost.addReplaced(turn, 'derived', { cost: 0.3 });
  assert.deepEqual(turn.spentReplaced, { derived: 0.4, judge: 0.2 });
  assert.ok(Number.isFinite(turn.spentReplaced.derived));
});
