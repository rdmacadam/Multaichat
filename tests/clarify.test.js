'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const { detect } = load('clarify');

test('question in last paragraph', () => {
  assert.deepEqual(detect('Here is a plan.\n\nDay 1...\n\nWhat month are you going?'), { asks: true, question: 'What month are you going?' });
});

test('only the question sentence is extracted', () => {
  const r = detect('Happy to help! Before I plan: what month? And do you prefer cities or nature?');
  assert.equal(r.asks, true);
  assert.equal(r.question, 'Before I plan: what month? And do you prefer cities or nature?');
});

test('question not in last paragraph is ignored', () => {
  assert.equal(detect("Is it hard? Not really. Here's how:\n\n1. Do X").asks, false);
});

test('question mark inside trailing code block is ignored', () => {
  assert.equal(detect('Use a ternary:\n\n```js\nconst x = a ? b : c;\n```').asks, false);
});

test('phrases count as asking', () => {
  const r = detect('Here you go.\n\nLet me know if you want more detail.');
  assert.equal(r.asks, true);
  assert.equal(r.question, 'Let me know if you want more detail.');
  assert.equal(detect('Done.\n\nPlease specify the target platform.').asks, true);
});

test('list-like ending with questions', () => {
  const r = detect('Quick questions:\n- Budget?\n- First visit?');
  assert.equal(r.asks, true);
  assert.match(r.question, /Budget\?/);
  assert.match(r.question, /First visit\?/);
});

test('empty and plain statements', () => {
  assert.deepEqual(detect(''), { asks: false, question: '' });
  assert.equal(detect('All done. Enjoy the trip.').asks, false);
});

test('question capped at 300 chars', () => {
  const r = detect('x'.repeat(400) + '?');
  assert.ok(r.question.length <= 300);
});
