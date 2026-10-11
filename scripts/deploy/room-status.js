'use strict';

// Read only server-owned room state. Never serialize rooms, player identities,
// hands, resume tokens, or client-supplied claims about whether a game is live.
const COUNTS = ['totalRooms', 'waitingRooms', 'activeGames', 'completedRooms', 'expiredRooms', 'unknownRooms',
  'blockingRooms', 'playingRooms', 'connectedPlayers', 'reconnectingPlayers'];

function unknownRoomSummary() {
  return { roomStatus: 'UNKNOWN', ...Object.fromEntries(COUNTS.map(key => [key, null])) };
}

function summarizeRooms(rooms, initialized = true) {
  if (!initialized || !(rooms instanceof Map)) return unknownRoomSummary();
  const result = { roomStatus: 'EMPTY', ...Object.fromEntries(COUNTS.map(key => [key, 0])) };
  try {
    for (const room of rooms.values()) {
      result.totalRooms++;
      let category;
      if (!room || !(room.players instanceof Map) || !['lobby', 'ready', 'playing'].includes(room.phase)) {
        result.unknownRooms++; continue;
      }
      let validPlayers = true;
      for (const [client, info] of room.players) {
        if (!client || ![0, 1, 2, 3].includes(client.readyState) || !info ||
            info.disconnectedAt != null && (!Number.isFinite(info.disconnectedAt) || info.disconnectedAt <= 0)) {
          validPlayers = false; continue;
        }
        if (client.readyState === 1 && !info.disconnectedAt) result.connectedPlayers++;
        else result.reconnectingPlayers++;
      }
      if (!validPlayers) category = 'unknownRooms';
      // A retained room without human seats is expired, but still blocks a
      // restart until the server actually removes it. Disconnect grace is not
      // expiration: its retained seats continue to count, even with zero WS.
      else if (room.players.size === 0) category = 'expiredRooms';
      else if (room.phase === 'lobby' || room.phase === 'ready') category = 'waitingRooms';
      else if (!room.state || typeof room.state !== 'object' || Array.isArray(room.state)) category = 'unknownRooms';
      // These are the terminal signals already used by the server. A partial
      // winners[] or round_end/round_result does not end the whole game.
      else if (room.state.phase === 'over' || room.state.winner != null) category = 'completedRooms';
      else category = 'activeGames';
      result[category]++;
    }
    result.blockingRooms = result.totalRooms;
    result.playingRooms = result.activeGames; // Compatibility alias for admin consumers.
    result.roomStatus = result.unknownRooms ? 'UNKNOWN' : result.totalRooms ? 'ACTIVE' : 'EMPTY';
    if (COUNTS.some(key => !Number.isSafeInteger(result[key]))) return unknownRoomSummary();
    return result;
  } catch { return unknownRoomSummary(); }
}

function isKnownRoomSummary(value) {
  if (!value || !['EMPTY', 'ACTIVE'].includes(value.roomStatus) ||
      COUNTS.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) || value.unknownRooms !== 0) return false;
  return value.totalRooms === value.waitingRooms + value.activeGames + value.completedRooms + value.expiredRooms &&
    value.blockingRooms === value.totalRooms && value.playingRooms === value.activeGames &&
    value.roomStatus === (value.totalRooms ? 'ACTIVE' : 'EMPTY') &&
    (value.totalRooms > 0 || value.connectedPlayers + value.reconnectingPlayers === 0);
}

module.exports = { summarizeRooms, unknownRoomSummary, isKnownRoomSummary };
