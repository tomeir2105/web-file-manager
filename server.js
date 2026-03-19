const express = require('express');
const path = require('path');

const filesRouter = require('./routes/files');
const {
  applySecurityHeaders,
  createAuthMiddleware,
  createSecurityConfig,
  getAuthStatus,
  updateBasicPassword,
} = require('./middleware/security');
const proxyRouter = require('./routes/proxy');
const { autoStartProxy } = require('./routes/proxy');

const app = express();
const PORT = process.env.PORT || 3000;
const securityConfig = createSecurityConfig();
const APP_BIND_HOST = securityConfig.bindHost;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(applySecurityHeaders);
app.use(express.json({ limit: process.env.MAX_JSON_BODY_BYTES || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_FORM_BODY_BYTES || '1mb' }));
app.use(createAuthMiddleware(securityConfig));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/api/auth/status', (req, res) => {
  res.json(getAuthStatus(securityConfig));
});

app.post('/api/auth/bootstrap-password', (req, res, next) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmPassword = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : '';

    if (password !== confirmPassword) {
      const error = new Error('The passwords do not match.');
      error.status = 400;
      error.expose = true;
      throw error;
    }

    updateBasicPassword(securityConfig, password);

    res.json({
      message: 'Password updated. Sign in again with the new password.',
      reauthenticate: true,
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api/files', filesRouter);
app.use('/api/proxy', proxyRouter);

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/proxy', (req, res) => {
  res.render('index');
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    err.status = 413;
    err.expose = true;
    err.message = 'Uploaded file exceeds the configured size limit';
  }

  console.error('Unhandled request error:', {
    path: req.path,
    method: req.method,
    message: err && err.message,
    stack: err && err.stack,
  });

  const status = err.status || 500;
  const message = err.expose ? err.message : 'Internal server error';

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message });
  }

  return res.status(status).send(message);
});

app.listen(PORT, APP_BIND_HOST, () => {
  console.log(`File manager running on http://${APP_BIND_HOST}:${PORT}`);
  if (!securityConfig.authEnabled) {
    console.warn('Authentication is disabled. Access is only considered safe while bound to loopback.');
  }
  // Auto-start the proxy on service startup
  autoStartProxy();
});
