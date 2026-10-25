'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');
load('util');
const { render } = load('markdown');

test('raw HTML is escaped', () => {
  const out = render('<img src=x onerror=alert(1)> <script>x</script>');
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('<script'));
  assert.ok(out.includes('&lt;img'));
});

test('javascript: links are not linked', () => {
  const out = render('[x](javascript:alert(1))');
  assert.ok(!/href="javascript/i.test(out));
});

test('http links get safe attributes', () => {
  assert.ok(render('[site](https://example.com/a?b=1&c=2)').includes('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">site</a>'));
});

test('link text cannot break out of attributes', () => {
  const out = render('[a](https://x.com/"onmouseover="alert(1))');
  assert.ok(!out.includes('"onmouseover'));
});

test('inline formatting', () => {
  assert.equal(render('**b** and *i* and `c<d`'), '<p><strong>b</strong> and <em>i</em> and <code>c&lt;d</code></p>');
});

test('fenced code keeps content escaped, adds copy button', () => {
  const out = render('```js\nif (a < b) **x**\n```');
  assert.ok(out.includes('<pre><code class="lang-js">if (a &lt; b) **x**</code><button class="copy" data-copy>Copy</button></pre>'));
});

test('unterminated fence renders as code (streaming)', () => {
  const out = render('Text\n```py\nprint(1)');
  assert.ok(out.includes('<code class="lang-py">print(1)</code>'));
});

test('lists', () => {
  const ul = render('- a\n- b');
  assert.equal((ul.match(/<li>/g) || []).length, 2);
  assert.ok(ul.startsWith('<ul>'));
  assert.ok(render('1. a\n2. b').startsWith('<ol>'));
});

test('table', () => {
  const out = render('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>A</th>'));
  assert.ok(out.includes('<td>2</td>'));
});

test('headings capped at h4', () => {
  assert.equal(render('# H'), '<h1>H</h1>');
  assert.equal(render('###### H6'), '<h4>H6</h4>');
});

test('paragraphs and line breaks', () => {
  assert.equal(render('a\nb\n\nc'), '<p>a<br>b</p><p>c</p>');
});

test('blockquote', () => {
  assert.equal(render('> quoted'), '<blockquote><p>quoted</p></blockquote>');
});
