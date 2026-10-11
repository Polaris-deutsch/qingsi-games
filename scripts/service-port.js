'use strict';

// The service keeps port 3000 in normal use. Only lifecycle test children
// explicitly opt into an isolated port; PORT is not a controller setting.
function getServicePort(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.QINGSI_GAMES_TEST_PORT === undefined) return 3000;
  const value = env.QINGSI_GAMES_TEST_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535 || port === 3000) {
    throw new Error('QINGSI_GAMES_TEST_PORT must be an isolated TCP port (1-65535, excluding 3000).');
  }
  return port;
}

module.exports = { getServicePort };
