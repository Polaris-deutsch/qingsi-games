// Canonical origin for room invites. The browser's live WebSocket connection
// continues to use the origin of the page it actually loaded.
function getPublicBaseUrl(value) {
  if (value == null || String(value).trim() === '') return null;

  const input = String(value).trim();
  let url;
  try {
    if (!/^https?:\/\//i.test(input)) throw new Error('expected http:// or https://');
    url = new URL(input);
  } catch (err) {
    throw new Error('Invalid PUBLIC_BASE_URL: expected an absolute http:// or https:// origin');
  }

  if (url.username || url.password || !/^\/*$/.test(url.pathname) || input.includes('?') || input.includes('#')) {
    throw new Error('Invalid PUBLIC_BASE_URL: use an origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

function buildRoomShareUrl(roomId, { publicBaseUrl = null, requestHost, forwardedProto, getShareableLanIP, port } = {}) {
  let baseUrl = publicBaseUrl;
  if (!baseUrl) {
    // Preserve GameNest's LAN QR behavior, including its localhost-to-LAN
    // fallback and the existing proxy-protocol handling.
    let host = requestHost || 'localhost:3000';
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      const lanIP = getShareableLanIP && getShareableLanIP();
      if (lanIP) host = `${lanIP}:${port}`;
    }
    const proto = forwardedProto === 'https' ? 'https' : 'http';
    baseUrl = `${proto}://${host}`;
  }
  const url = new URL('/', baseUrl);
  url.searchParams.set('room', roomId);
  return url.toString();
}

module.exports = { getPublicBaseUrl, buildRoomShareUrl };
