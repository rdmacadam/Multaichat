/* MC.clarify — heuristic: does an answer end by asking the user something?
   Drives the ❓ badge and the "Answer together" banner; never blocks anything. */
(function (root, factory) {
  const mod = factory(root.MC || (root.MC = {}));
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MC.clarify = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHRASES = /could you clarify|let me know|do you want|would you like|can you tell me|please specify/i;

  function stripCode(text) {
    return text
      .replace(/```[\s\S]*?(```|$)/g, '\n\n')
      .replace(/`[^`\n]*`/g, '');
  }

  function detect(text) {
    const body = stripCode(String(text || '')).trim();
    if (!body) return { asks: false, question: '' };
    const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const last = paragraphs[paragraphs.length - 1] || '';
    const sentences = last
      .split(/\n+|(?<=[.?!])\s+/)
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
    const asking = sentences.filter((s) => s.includes('?') || PHRASES.test(s));
    if (!asking.length) return { asks: false, question: '' };
    return { asks: true, question: asking.join(' ').slice(0, 300) };
  }

  return { detect };
});
