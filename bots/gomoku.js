// Gomoku bot identity stays server-side; decision logic is shared with local solo.
const { botName } = require('./lib/bot-name');
const AI = require('../public/js/core/gomoku-ai');
exports.name = 'gomoku';
exports.createBot = playerIndex => ({
  name: botName(playerIndex, 'zh'), playerIndex,
  getMove: state => AI.getMove(state, playerIndex),
});
