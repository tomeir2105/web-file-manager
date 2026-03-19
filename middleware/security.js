const crypto = require('crypto');

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').trim().toLowerCase());
}

function createSecurityConfig() {
  const bindHost = process.env.HOST || process.env.APP_BIND_HOST || '127.0.0.1';
  const username = process.env.FILE_MANAGER_USERNAME || '';
  const password = process.env.FILE_MANAGER_PASSWORD || '';
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

module.exports = {
  applySecurityHeaders,
  createAuthMiddleware,
  createSecurityConfig,
};
