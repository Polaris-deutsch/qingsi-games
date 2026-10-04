// Shared public activity protocol constants for Node and plain browser JavaScript.
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ActivityProtocol = api;
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  var DEFAULT_REACTIONS = Object.freeze(['😂','🤣','😎','😭','😱','🤔','😏','👍','👏','🔥','💀','❤️']);
  function normalizeChat(text) { return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''; }
  return Object.freeze({VERSION:1, MAX_ITEMS:500, CHAT_MAX_LENGTH:120, CHAT_GAP_MS:800,
    DEFAULT_REACTIONS:DEFAULT_REACTIONS, normalizeChat:normalizeChat});
});
