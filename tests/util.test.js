'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
const util = load('util');

test('uid has prefix and 10 base36 chars, unique', () => {
  const a = util.uid('c_');
  assert.match(a, /^c_[a-z0-9]{10}$/);
  assert.notEqual(a, util.uid('c_'));
});

test('escapeHtml escapes all special chars', () => {
  assert.equal(util.escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('formatCost', () => {
  assert.equal(util.formatCost(0.00001), '<$0.0001');
  assert.equal(util.formatCost(0.00123), '$0.0012');
  assert.equal(util.formatCost(1.5), '$1.50');
});

test('formatTokens', () => {
  assert.equal(util.formatTokens(1234), '1.2k');
  assert.equal(util.formatTokens(999), '999');
  assert.equal(util.formatTokens(200000), '200k');
});

test('pricePerM', () => {
  assert.equal(util.pricePerM('0.000003'), 3);
  assert.equal(util.pricePerM('0'), 0);
  assert.equal(util.pricePerM('-1'), null);
  assert.equal(util.pricePerM(undefined), null);
});

test('throttle runs leading and a single trailing call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const f = util.throttle((x) => calls.push(x), 1000);
  f(1); f(2); f(3);
  assert.deepEqual(calls, [1]);
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [1, 3]);
});
