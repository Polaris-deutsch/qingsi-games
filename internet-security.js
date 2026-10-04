const net = require('node:net');

const DEFAULTS = {
  MAX_ROOMS: 200,
  MAX_CONNECTIONS: 500,
  WS_MAX_PAYLOAD: 4 * 1024 * 1024,
};

function readLimit(env, name, min, max) {
  const raw = env[name];
  if (raw == null || raw === '') return DEFAULTS[name];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected an integer from ${min} to ${max}`);
  }
  return value;
}

function getSecurityConfig(env = process.env) {
  return {
    maxRooms: readLimit(env, 'MAX_ROOMS', 1, 5000),
    maxConnections: readLimit(env, 'MAX_CONNECTIONS', 1, 10000),
    wsMaxPayload: readLimit(env, 'WS_MAX_PAYLOAD', 65536, 16 * 1024 * 1024),
  };
}

function isPrivateHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 127 || parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254);
  }
  if (net.isIP(host) === 6) {
    return host === '::1' || /^::ffff:/.test(host) && isPrivateHost(host.slice(7)) ||
      /^(fc|fd|fe[89ab])/.test(host);
  }
  return false;
}

function parseHost(value) {
  if (typeof value !== 'string' || !value || /[\s/?#@]/.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    return url.hostname ? url : null;
  } catch (err) {
    return null;
  }
}

function isAllowedWebSocketOrigin(request, publicBaseUrl) {
  const host = parseHost(request.headers.host);
  if (!host) return false;
  const rawOrigin = request.headers.origin;
  const privateHost = isPrivateHost(host.hostname);
  const privatePeer = isPrivateHost(request.socket.remoteAddress);

  // Browser WebSocket handshakes include Origin. Node/non-browser LAN clients
  // may omit it; permit those only on a private Host from a private peer.
  if (rawOrigin == null) return privateHost && privatePeer;
  if (typeof rawOrigin !== 'string' || !/^https?:\/\//.test(rawOrigin)) return false;
  let origin;
  try { origin = new URL(rawOrigin); } catch (err) { return false; }
  if (origin.origin !== rawOrigin || origin.username || origin.password) return false;

  if (publicBaseUrl && origin.origin === publicBaseUrl) {
    return host.host === new URL(publicBaseUrl).host;
  }
  return origin.protocol === 'http:' && privateHost && privatePeer &&
    isPrivateHost(origin.hostname) && origin.host === host.host;
}

function createTokenBucket(capacity, refillPerSecond, now = () => Date.now()) {
  let tokens = capacity;
  let last = now();
  return function take() {
    const current = now();
    tokens = Math.min(capacity, tokens + Math.max(0, current - last) * refillPerSecond / 1000);
    last = current;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const ROOM_ID = /^[A-HJ-NP-Z2-9]{3,4}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OPTION_KEYS = new Set([
  'roundTime', 'maxRounds', 'requireBreak', 'bidMode', 'firstCaller',
  'allowDouble', 'allowShowHand', 'playTimeLimit', 'totalRounds', 'sameBoard',
  'enabledDecks', 'customTruths', 'customDares', 'mode', 'categories',
  'drawTime', 'guessTime', 'wordChoices', 'customWords', 'boardSize', 'difficulty',
  'mahjongMode', 'mj_bloodBattle', 'mj_multiWinner', 'mj_rain',
  'mj_checkFlowerPig', 'mj_checkBigCall', 'mj_lastFourAutoWin',
  'mj_swapThree', 'mj_buyTiles', 'mj_wildcard', 'mj_maxFan', 'mj_minFan',
]);
const BOOLEAN_OPTIONS = new Set([
  'requireBreak', 'allowDouble', 'allowShowHand', 'sameBoard',
  'mj_bloodBattle', 'mj_multiWinner', 'mj_rain', 'mj_checkFlowerPig',
  'mj_checkBigCall', 'mj_lastFourAutoWin', 'mj_swapThree', 'mj_buyTiles',
  'mj_wildcard',
]);
const NUMBER_OPTIONS = new Set([
  'roundTime', 'maxRounds', 'playTimeLimit', 'totalRounds', 'drawTime',
  'guessTime', 'wordChoices', 'boardSize', 'mj_maxFan', 'mj_minFan',
]);
const ENUM_OPTIONS = {
  bidMode: ['rob', 'score'],
  firstCaller: ['random', 'winner'],
  mode: ['stage', 'whisper'],
  difficulty: ['easy', 'normal', 'hard'],
  mahjongMode: ['sichuan', 'cantonese'],
};
const ARRAY_OPTIONS = {
  enabledDecks: new Set(['icebreaker', 'party', 'deep', 'challenge', 'custom']),
  categories: new Set(['animal', 'food', 'daily', 'action', 'place', 'idiom', 'movie', 'internet']),
};

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function boundedJson(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > 100000 || item.depth > 20) return false;
    const next = item.value;
    if (typeof next === 'string') {
      if (next.length > 8192) return false;
    } else if (typeof next === 'number') {
      if (!Number.isFinite(next)) return false;
    } else if (next === null || typeof next === 'boolean') {
      continue;
    } else if (Array.isArray(next)) {
      if (next.length > 30000) return false;
      for (const child of next) pending.push({ value: child, depth: item.depth + 1 });
    } else if (plainObject(next)) {
      const entries = Object.entries(next);
      if (entries.length > 256) return false;
      for (const [key, child] of entries) {
        if (key.length > 64 || DANGEROUS_KEYS.has(key)) return false;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else {
      return false;
    }
  }
  return true;
}

function validOption(key, value) {
  if (BOOLEAN_OPTIONS.has(key)) return typeof value === 'boolean';
  if (NUMBER_OPTIONS.has(key)) return Number.isInteger(value) && value >= 0 && value <= 120;
  if (Object.hasOwn(ENUM_OPTIONS, key)) return ENUM_OPTIONS[key].includes(value);
  if (Object.hasOwn(ARRAY_OPTIONS, key)) {
    return Array.isArray(value) && value.length <= ARRAY_OPTIONS[key].size &&
      value.every(item => ARRAY_OPTIONS[key].has(item));
  }
  if (key === 'customTruths' || key === 'customDares' || key === 'customWords') {
    return typeof value === 'string' && value.length <= 8192;
  }
  return false;
}

function validName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 8 &&
    !/[<>\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validAvatar(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4 &&
    !/[<>\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < 100;
}

function validateClientMessage(message) {
  if (!plainObject(message) || typeof message.type !== 'string' ||
      message.type.length === 0 || message.type.length > 40) return false;
  const data = message.data;
  if (data !== undefined && (!plainObject(data) || !boundedJson(data))) return false;
  switch (message.type) {
    case 'create_room':
      return plainObject(data) && typeof data.game === 'string' && data.game.length <= 64 &&
        (data.lang === undefined || data.lang === 'zh' || data.lang === 'en');
    case 'join_room':
      return plainObject(data) && ROOM_ID.test(data.roomId) &&
        (data.resumeToken === undefined || typeof data.resumeToken === 'string' && data.resumeToken.length <= 128) &&
        (data.lang === undefined || data.lang === 'zh' || data.lang === 'en');
    case 'set_option':
      return plainObject(data) && OPTION_KEYS.has(data.key) && validOption(data.key, data.value);
    case 'set_name': return plainObject(data) && validName(data.name);
    case 'set_avatar': return plainObject(data) && validAvatar(data.avatar);
    case 'remove_bot': return plainObject(data) && validIndex(data.botIndex);
    case 'kick_player': return plainObject(data) && validIndex(data.playerIndex);
    case 'swap_seat': return plainObject(data) && validIndex(data.fromIndex) && validIndex(data.toIndex);
    case 'game_move':
      return plainObject(data) &&
        (!Object.hasOwn(data, 'text') || typeof data.text === 'string' && data.text.length <= 256) &&
        (!Object.hasOwn(data, 'content') || typeof data.content !== 'string' || data.content.length <= 256) &&
        (!Object.hasOwn(data, 'expression') || typeof data.expression === 'string' && data.expression.length <= 256);
    default: return true;
  }
}

module.exports = {
  getSecurityConfig, isAllowedWebSocketOrigin, isPrivateHost, createTokenBucket,
  validateClientMessage, validName, validAvatar, ROOM_ID,
};
