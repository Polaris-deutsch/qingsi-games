// Public activity only. Callers must project game events to public information
// before pushing, or supply projectData(type, data). Never pass private state.
const Protocol = require('../../public/js/activity-protocol');
const internal = new WeakMap();
const defaults = Object.freeze({maxItems:Protocol.MAX_ITEMS, chatMaxLength:Protocol.CHAT_MAX_LENGTH,
  chatGapMs:Protocol.CHAT_GAP_MS, reactions:Protocol.DEFAULT_REACTIONS});

function settings(state, options = {}) {
  let meta = internal.get(state);
  if (!meta) { meta = {options:{...defaults}, socialAt:new Map()}; internal.set(state, meta); }
  for (const key of ['maxItems','chatMaxLength','chatGapMs']) {
    if (options[key] === undefined) continue;
    const value = options[key];
    if (!Number.isSafeInteger(value) || value < (key === 'chatGapMs' ? 0 : 1)) throw new RangeError('Invalid activity ' + key);
    meta.options[key] = value;
  }
  if (options.reactions !== undefined) {
    if (!Array.isArray(options.reactions) || options.reactions.some(value => typeof value !== 'string' || !value)) throw new TypeError('Invalid activity reactions');
    meta.options.reactions = Object.freeze([...new Set(options.reactions)]);
  }
  if (options.projectData !== undefined) {
    if (typeof options.projectData !== 'function') throw new TypeError('Invalid activity projector');
    meta.options.projectData = options.projectData;
  }
  return meta;
}

function init(state, options) {
  settings(state, options);
  if (!state.activity || state.activity.version !== Protocol.VERSION || !Array.isArray(state.activity.items) ||
      !Number.isSafeInteger(state.activity.seq) || state.activity.seq < 0) {
    state.activity = {version:Protocol.VERSION, seq:0, items:[]};
  }
  return state.activity;
}
function reset(state, options) {
  const config = {...(internal.get(state)?.options || defaults)};
  internal.delete(state);
  settings(state, {...config, ...options});
  state.activity = {version:Protocol.VERSION, seq:0, items:[]};
  return state.activity;
}
function copyData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  try { return JSON.parse(JSON.stringify(data)); } catch { return null; }
}
function project(type, data, config) {
  if (type === 'chat') return {text:Protocol.normalizeChat(data.text)};
  if (type === 'reaction') return config.reactions.includes(data.emoji) ? {emoji:data.emoji} : null;
  return config.projectData ? config.projectData(type, data) : data;
}
function push(state, event, options) {
  const activity = init(state, options), config = settings(state).options;
  if (!event || typeof event.type !== 'string' || !event.type.trim()) return null;
  if (event.player != null && (!Number.isSafeInteger(event.player) || event.player < 0)) return null;
  const data = copyData(project(event.type, event.data || {}, config));
  if (!data) return null;
  const item = {seq:activity.seq+1, type:event.type, player:event.player ?? null, time:Date.now(), data};
  activity.seq = item.seq;
  activity.items.push(item);
  if (activity.items.length > config.maxItems) activity.items.splice(0, activity.items.length-config.maxItems);
  return item;
}
function socialType(data) {
  // Only the two previous action names are accepted as an upgrade compatibility path.
  if (data && (data.action === 'activity_chat' || data.action === 'chat')) return 'chat';
  if (data && (data.action === 'activity_reaction' || data.action === 'reaction')) return 'reaction';
  return null;
}
function isSocialAction(data) { return socialType(data) !== null; }
function handleSocialAction(data, state, playerIndex, options = {}) {
  const type = socialType(data);
  if (!type) return {handled:false};
  const fail = error => ({handled:true, error});
  if (!state || options.enabled === false) return fail('activity_unavailable');
  if (!Number.isSafeInteger(playerIndex) || playerIndex < 0 ||
      (options.playerCount !== undefined && playerIndex >= options.playerCount)) return fail('activity_bad_player');
  const meta = settings(state, options), config = meta.options;
  let content;
  if (type === 'chat') {
    content = Protocol.normalizeChat(data.text);
    if (!content) return fail('activity_chat_empty');
    if (Array.from(content).length > config.chatMaxLength) return fail('activity_chat_too_long');
  } else {
    if (!config.reactions.includes(data.emoji)) return fail('activity_invalid_reaction');
    content = data.emoji;
  }
  const now = Date.now();
  if (meta.socialAt.has(playerIndex) && now-meta.socialAt.get(playerIndex) < config.chatGapMs) return fail('activity_chat_fast');
  push(state, {type, player:playerIndex, data:type === 'chat' ? {text:content} : {emoji:content}});
  meta.socialAt.set(playerIndex, now);
  return {handled:true, error:null};
}
function publicView(state, options) {
  const config = settings(state, options).options, activity = init(state);
  return {version:Protocol.VERSION, seq:activity.seq, items:activity.items.map(item => {
    if (!item || !Number.isSafeInteger(item.seq) || item.seq < 1 || typeof item.type !== 'string' || !Number.isFinite(item.time)) return null;
    const data = copyData(project(item.type, item.data || {}, config));
    if (!data) return null;
    return {seq:item.seq, type:item.type, player:Number.isSafeInteger(item.player) && item.player >= 0 ? item.player : null, time:item.time, data};
  }).filter(Boolean)};
}
module.exports = {init, reset, push, handleSocialAction, isSocialAction, publicView,
  DEFAULT_REACTIONS:Protocol.DEFAULT_REACTIONS, getDefaultReactions:() => Protocol.DEFAULT_REACTIONS};
