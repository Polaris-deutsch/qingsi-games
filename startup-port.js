function isRecoverablePortError(error) {
  return !!error && (error.code === 'EADDRINUSE' || error.code === 'EACCES');
}

function getNextPort(errorCode, port) {
  if (errorCode === 'EADDRINUSE') {
    return port + 1;
  }
  if (errorCode === 'EACCES') {
    return Math.floor(port / 100) * 100 + 100;
  }
  return null;
}

module.exports = {
  getListenConfig,
  getNextPort,
  isRecoverablePortError,
};
const net = require('node:net');

function getListenConfig(env = process.env) {
  const explicitPort = Object.hasOwn(env, 'PORT');
  const port = explicitPort ? Number(env.PORT) : 3000;
  if (explicitPort && (!/^\d+$/.test(env.PORT) || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Invalid PORT: expected an integer from 1 to 65535');
  }
  const host = env.HOST || '0.0.0.0';
  if (!net.isIP(host)) throw new Error('Invalid HOST: expected an IP address');
  return { port, host };
}
