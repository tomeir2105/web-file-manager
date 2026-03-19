const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_BOOTSTRAP_PASSWORD = 'change-me';
const DEFAULT_AUTH_CONFIG_FILE = path.join(
  path.dirname(process.env.APP_CONFIG_FILE || path.join(APP_ROOT, 'app.config.json')),
  'auth.config.json'
);
const AUTH_CONFIG_FILE = process.env.AUTH_CONFIG_FILE || DEFAULT_AUTH_CONFIG_FILE;

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').trim().toLowerCase());
}

function readAuthConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_CONFIG_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeAuthConfigFile(config) {
  fs.mkdirSync(path.dirname(AUTH_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(AUTH_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function createSecurityConfig() {
  const bindHost = process.env.HOST || process.env.APP_BIND_HOST || '127.0.0.1';
  const storedAuthConfig = readAuthConfigFile();
  const username = storedAuthConfig.username || process.env.FILE_MANAGER_USERNAME || '';
  const password = storedAuthConfig.password || process.env.FILE_MANAGER_PASSWORD || '';
  const apiToken = process.env.FILE_MANAGER_API_TOKEN || '';
  const allowUnauthenticated = parseBoolean(process.env.ALLOW_UNAUTHENTICATED);
  const hasBasicAuth = Boolean(username && password);
  const hasTokenAuth = Boolean(apiToken);
  const authEnabled = hasBasicAuth || hasTokenAuth;

  if (!authEnabled && !allowUnauthenticated && !isLoopbackHost(bindHost)) {
    throw new Error(
      'Refusing to start without authentication on a non-loopback host. Set FILE_MANAGER_USERNAME and FILE_MANAGER_PASSWORD, set FILE_MANAGER_API_TOKEN, or explicitly set ALLOW_UNAUTHENTICATED=true.'
    );
  }

  return {
    bindHost,
    authEnabled,
    hasBasicAuth,
    hasTokenAuth,
    username,
    password,
    apiToken,
    allowUnauthenticated,
    authConfigFile: AUTH_CONFIG_FILE,
    defaultBootstrapPassword: DEFAULT_BOOTSTRAP_PASSWORD,
    passwordChangeRequired: hasBasicAuth && password === DEFAULT_BOOTSTRAP_PASSWORD,
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function unauthorized(res, challenge = 'Basic realm="Jellyfin File Manager"') {
  res.set('WWW-Authenticate', challenge);
  return res.status(401).send('Authentication required');
}

function createAuthMiddleware(config) {
  return function authMiddleware(req, res, next) {
    if (!config.authEnabled) {
      return next();
    }

    const authHeader = String(req.headers.authorization || '');

    if (config.hasBasicAuth && authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const separatorIndex = decoded.indexOf(':');
        const suppliedUsername = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
        const suppliedPassword = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

        if (safeEqual(suppliedUsername, config.username) && safeEqual(suppliedPassword, config.password)) {
          return next();
        }
      } catch (_) {
        return unauthorized(res);
      }
    }

    if (config.hasTokenAuth) {
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token : '';
      const headerToken = typeof req.headers['x-api-token'] === 'string' ? req.headers['x-api-token'] : '';
      const suppliedToken = bearerToken || headerToken || queryToken;

      if (suppliedToken && safeEqual(suppliedToken, config.apiToken)) {
        return next();
      }
    }

    return unauthorized(res);
  };
}

function applySecurityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' https://unpkg.com",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  next();
}

function getAuthStatus(config) {
  return {
    authEnabled: Boolean(config.authEnabled),
    hasBasicAuth: Boolean(config.hasBasicAuth),
    hasTokenAuth: Boolean(config.hasTokenAuth),
    username: config.username || '',
    passwordChangeRequired: Boolean(config.passwordChangeRequired),
  };
}

function updateBasicPassword(config, nextPassword) {
  const password = String(nextPassword || '');

  if (!config.hasBasicAuth) {
    const error = new Error('Password changes are only available when Basic authentication is enabled.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (!config.passwordChangeRequired) {
    const error = new Error('Password setup has already been completed.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (!password.trim()) {
    const error = new Error('Enter a new password.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (password.length < 8) {
    const error = new Error('Use at least 8 characters for the new password.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (password === config.defaultBootstrapPassword) {
    const error = new Error('Choose a password other than the default bootstrap password.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  writeAuthConfigFile({
    username: config.username,
    password,
    updatedAt: new Date().toISOString(),
  });

  config.password = password;
  config.passwordChangeRequired = false;

  return getAuthStatus(config);
}

module.exports = {
  applySecurityHeaders,
  createAuthMiddleware,
  createSecurityConfig,
  getAuthStatus,
  updateBasicPassword,
};
