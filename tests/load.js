'use strict';
// Loads browser-style UMD modules into Node and registers them on globalThis.MC
// so modules that use other modules (MC.util, MC.conv, ...) resolve them.
const path = require('path');

const NAMES = {
  util: ['core/util', 'util'],
  storage: ['core/storage', 'storage'],
  openrouter: ['core/openrouter', 'api'],
  models: ['core/models', 'models'],
  conversation: ['core/conversation', 'conv'],
  clarify: ['core/clarify', 'clarify'],
  fusion: ['core/fusion', 'fusion'],
  runner: ['core/runner', 'runner'],
  presets: ['core/presets', 'presets'],
  attach: ['core/attach', 'attach'],
  markdown: ['ui/markdown', 'md'],
};

globalThis.MC = globalThis.MC || {};

function load(name) {
  const [file, key] = NAMES[name];
  const mod = require(path.join(__dirname, '..', 'js', file + '.js'));
  globalThis.MC[key] = mod;
  return mod;
}

module.exports = { load };
