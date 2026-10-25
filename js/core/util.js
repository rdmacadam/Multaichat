/* MC.util — small shared helpers. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.util = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function uid(prefix = '') {
    let s = '';
    while (s.length < 10) s += Math.random().toString(36).slice(2);
    return prefix + s.slice(0, 10);
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Leading call immediately, then at most one trailing call per window.
  function throttle(fn, ms) {
    let last = -Infinity;
    let timer = null;
    let pending = null;
    return function (...args) {
      const now = Date.now();
      const wait = ms - (now - last);
      if (wait <= 0 && !timer) {
        last = now;
        fn.apply(this, args);
        return;
      }
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          const a = pending;
          pending = null;
          fn.apply(this, a);
        }, Math.max(wait, 0));
      }
    };
  }

  function formatCost(usd) {
    if (usd == null || isNaN(usd)) return '';
    if (usd < 0.0001) return '<$0.0001';
    if (usd >= 1) return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(4);
  }

  function formatTokens(n) {
    if (n == null) return '';
    if (n < 1000) return String(n);
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
  }

  // OpenRouter prices are USD per token as strings; convert to USD per million.
  function pricePerM(perToken) {
    if (perToken == null || perToken === '') return null;
    const n = Number(perToken);
    if (isNaN(n) || n < 0) return null;
    return Math.round(n * 1e6 * 1e6) / 1e6;
  }

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  return { uid, escapeHtml, debounce, throttle, formatCost, formatTokens, pricePerM, isFileProtocol };
});
