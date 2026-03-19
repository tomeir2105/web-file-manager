const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Proxy: MitmProxy } = require('http-mitm-proxy');

const router = express.Router();
const APP_ROOT = path.join(__dirname, '..');
const parseBoolean = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());

const PROXY_PORT = Number(process.env.PROXY_PORT || 3001);
const APP_PORT = Number(process.env.PORT || 3000);
const PROXY_BIND_HOST = process.env.PROXY_BIND_HOST || '0.0.0.0';
const PROXY_FORCE_SNI = parseBoolean(process.env.PROXY_FORCE_SNI);
const PROXY_WHITELIST_FILE =
  process.env.PROXY_WHITELIST_FILE || path.join(APP_ROOT, 'proxy-whitelist.txt');
const PROXY_LOG_FILTER_FILE =
  process.env.PROXY_LOG_FILTER_FILE || path.join(APP_ROOT, 'proxy-log-filter.txt');
const PROXY_LOG_FILE =
  process.env.PROXY_LOG_FILE || path.join(APP_ROOT, 'proxy-requests.log');
const PROXY_CA_DIR = process.env.PROXY_CA_DIR || path.join(APP_ROOT, 'proxy-ca');
const PROXY_CA_CERT_FILE = path.join(PROXY_CA_DIR, 'certs', 'ca.pem');
const TORRENT_CAPTURE_DIR =
  process.env.TORRENT_CAPTURE_DIR || path.join(APP_ROOT, 'torrent files');
const MAX_TORRENT_CAPTURE_BYTES = Number(process.env.MAX_TORRENT_CAPTURE_BYTES || 10 * 1024 * 1024);
const MAX_PROXY_LOG_LINES = Number(process.env.MAX_PROXY_LOG_LINES || 3000);
const PROXY_START_TIMEOUT_MS = Number(process.env.PROXY_START_TIMEOUT_MS || 15000);
const TRANSMISSION_CONFIG_FILE =
  process.env.TRANSMISSION_CONFIG_FILE || path.join(APP_ROOT, 'transmission.config.json');

function readTransmissionConfig() {
  try {
    return JSON.parse(fs.readFileSync(TRANSMISSION_CONFIG_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

const transmissionConfig = readTransmissionConfig();
const TRANSMISSION_RPC_URL =
  process.env.TRANSMISSION_RPC_URL ||
  transmissionConfig.rpcUrl ||
  'http://127.0.0.1:9091/transmission/rpc';
const TRANSMISSION_USERNAME =
  process.env.TRANSMISSION_USERNAME || transmissionConfig.username || 'user';
const TRANSMISSION_PASSWORD =
  process.env.TRANSMISSION_PASSWORD || transmissionConfig.password || 'user';
const TRANSMISSION_DOWNLOAD_DIR =
  process.env.TRANSMISSION_DOWNLOAD_DIR || transmissionConfig.downloadDir || '';

let proxyServer = null;
let startedAt = null;
let transmissionSessionId = '';
let proxyStarting = false;
let lastLoggedLine = '';
let hiddenLogCounts = Object.create(null);

function log(line) {
  const hiddenEntry = isFilteredLogHost(extractHostnameFromLogLine(line));
  if (hiddenEntry) {
    incrementHiddenLogCount(hiddenEntry);
  }

  if (line === lastLoggedLine) {
    return;
  }

  lastLoggedLine = line;
  const now = new Date();
  const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  const entry = `[${timestamp}] ${line}\n`;

  fs.appendFile(PROXY_LOG_FILE, entry, () => {
    fs.readFile(PROXY_LOG_FILE, 'utf8', (readError, contents) => {
      if (readError) {
        return;
      }

      const lines = contents.split(/\r?\n/).filter(Boolean);
      if (lines.length <= MAX_PROXY_LOG_LINES) {
        return;
      }

      const trimmed = `${lines.slice(-MAX_PROXY_LOG_LINES).join('\n')}\n`;
      fs.writeFile(PROXY_LOG_FILE, trimmed, () => {});
    });
  });
}

function getManagerHosts() {
  const hosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const machineHostName = String(os.hostname() || '').trim().toLowerCase();
  const preferredDisplayHost = String(getPreferredDisplayHost() || '').trim().toLowerCase();

  if (machineHostName) {
    hosts.add(machineHostName);
    hosts.add(`${machineHostName}.local`);
  }

  if (preferredDisplayHost) {
    hosts.add(preferredDisplayHost);
  }

  if (PROXY_BIND_HOST && PROXY_BIND_HOST !== '0.0.0.0' && PROXY_BIND_HOST !== '::') {
    hosts.add(String(PROXY_BIND_HOST).trim().toLowerCase());
  }

  const networkInterfaces = os.networkInterfaces();

  for (const addresses of Object.values(networkInterfaces)) {
    for (const addressInfo of addresses || []) {
      if (addressInfo.address) {
        hosts.add(addressInfo.address);
      }
    }
  }

  return hosts;
}

function getPreferredDisplayHost() {
  if (PROXY_BIND_HOST && PROXY_BIND_HOST !== '0.0.0.0' && PROXY_BIND_HOST !== '::') {
    return PROXY_BIND_HOST;
  }

  const networkInterfaces = os.networkInterfaces();

  for (const addresses of Object.values(networkInterfaces)) {
    for (const addressInfo of addresses || []) {
      if (addressInfo.internal) {
        continue;
      }

      if (addressInfo.family === 'IPv4' || addressInfo.family === 4) {
        return addressInfo.address;
      }
    }
  }

  return '127.0.0.1';
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();

  if (hostname.startsWith('www.') && hostname.length > 4) {
    return hostname.slice(4);
  }

  return hostname;
}

function createManagedEntry(value, isRegex) {
  const normalizedValue = String(value || '').trim();
  const normalizedRegexValue = normalizedValue;
  const normalizedExactValue = normalizeHostname(normalizedValue);
  const storedValue = isRegex ? normalizedRegexValue : normalizedExactValue;

  return {
    key: isRegex ? `regex:${storedValue}` : storedValue,
    value: storedValue,
    isRegex: Boolean(isRegex),
  };
}

function getManagedEntryLabel(entry) {
  return entry?.isRegex ? `regex:${entry.value}` : entry?.value || '';
}

function readManagedEntries(filePath) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        if (line.toLowerCase().startsWith('regex:')) {
          return createManagedEntry(line.slice(6), true);
        }

        return createManagedEntry(line, false);
      });
  } catch (_) {
    return [];
  }
}

function readWhitelistHosts() {
  return readManagedEntries(PROXY_WHITELIST_FILE);
}

function readLogFilterHosts() {
  return readManagedEntries(PROXY_LOG_FILTER_FILE);
}

function normalizeManagedEntry(value, isRegex, emptyMessage = 'Enter a URL or hostname.') {
  const rawTrimmed = String(value || '').trim();
  const trimmed = rawTrimmed.toLowerCase();
  if (!rawTrimmed) {
    const error = new Error(emptyMessage);
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (isRegex) {
    try {
      new RegExp(rawTrimmed, 'i');
    } catch (_) {
      const error = new Error('Enter a valid regular expression.');
      error.status = 400;
      error.expose = true;
      throw error;
    }

    return createManagedEntry(rawTrimmed, true);
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    const error = new Error('Enter a valid URL or hostname.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (!parsed.hostname) {
    const error = new Error('Enter a valid hostname.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  if (parsed.username || parsed.password) {
    const error = new Error('Whitelist entries cannot include credentials.');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  return createManagedEntry(parsed.hostname, false);
}

function getCustomWhitelistHosts() {
  return dedupeManagedEntries(readWhitelistHosts());
}

function getCustomLogFilterHosts() {
  return dedupeManagedEntries(readLogFilterHosts());
}

function dedupeManagedEntries(entries) {
  const byKey = new Map();

  for (const entry of entries || []) {
    const normalizedEntry = normalizeManagedEntry(
      entry?.value ?? entry,
      Boolean(entry?.isRegex),
      'Enter a URL or hostname.'
    );
    byKey.set(normalizedEntry.key, normalizedEntry);
  }

  return Array.from(byKey.values()).sort((left, right) =>
    getManagedEntryLabel(left).localeCompare(getManagedEntryLabel(right))
  );
}

function writeManagedHosts(filePath, hosts) {
  const uniqueHosts = dedupeManagedEntries(hosts);
  const existingContents = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
  const preservedComments = existingContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#'));
  const nextContents = [...preservedComments, ...uniqueHosts.map((entry) => getManagedEntryLabel(entry))].join('\n');

  fs.writeFileSync(filePath, nextContents ? `${nextContents}\n` : '');
  return uniqueHosts;
}

function writeWhitelistHosts(hosts) {
  return writeManagedHosts(PROXY_WHITELIST_FILE, hosts);
}

function writeLogFilterHosts(hosts) {
  return writeManagedHosts(PROXY_LOG_FILTER_FILE, hosts);
}

function getAllowedHosts() {
  return getCustomWhitelistHosts();
}

function getLogFilterHosts() {
  return getCustomLogFilterHosts();
}

function getHiddenLogCounts() {
  const entries = {};

  for (const host of getCustomLogFilterHosts()) {
    entries[host.key] = Number(hiddenLogCounts[host.key] || 0);
  }

  return entries;
}

function incrementHiddenLogCount(entry) {
  const key = entry?.key;
  if (!key) {
    return;
  }

  hiddenLogCounts[key] = Number(hiddenLogCounts[key] || 0) + 1;
}

function resetHiddenLogCounts() {
  hiddenLogCounts = Object.create(null);
}

function parseHostHeader(hostHeader, isSSL) {
  const rawHost = String(hostHeader || '').trim();

  if (!rawHost) {
    return {
      hostname: '',
      port: isSSL ? 443 : 80,
    };
  }

  try {
    const parsed = new URL(`${isSSL ? 'https' : 'http'}://${rawHost}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: Number(parsed.port) || (isSSL ? 443 : 80),
    };
  } catch (_) {
    return {
      hostname: rawHost.toLowerCase(),
      port: isSSL ? 443 : 80,
    };
  }
}

function isManagerRequest(hostname, port) {
  return getManagerHosts().has(hostname) && (port === APP_PORT || port === PROXY_PORT);
}

function isAllowedProxyHost(hostname) {
  return Boolean(findMatchingManagedEntry(getAllowedHosts(), hostname));
}

function isFilteredLogHost(hostname) {
  return findMatchingManagedEntry(getLogFilterHosts(), hostname);
}

function findMatchingManagedEntry(entries, hostname) {
  const normalizedHost = normalizeHostname(hostname);
  if (!normalizedHost) {
    return null;
  }

  for (const entry of entries || []) {
    if (entry.isRegex) {
      try {
        if (new RegExp(entry.value, 'i').test(normalizedHost)) {
          return entry;
        }
      } catch (_) {
        continue;
      }
      continue;
    }

    if (entry.value === normalizedHost) {
      return entry;
    }
  }

  return null;
}

function shouldLogProxyRequest(targetUrl, port) {
  if (!targetUrl) {
    return true;
  }

  if (
    isManagerRequest(targetUrl.hostname, port) &&
    String(targetUrl.pathname || '').startsWith('/api/proxy/')
  ) {
    return false;
  }

  return true;
}

function getRequestUrl(ctx) {
  const { hostname, port } = parseHostHeader(
    ctx.clientToProxyRequest.headers.host,
    ctx.isSSL
  );
  const protocol = ctx.isSSL ? 'https' : 'http';
  const rawUrl = ctx.clientToProxyRequest.url || '/';

  try {
    return new URL(rawUrl);
  } catch (_) {
    const defaultPort = ctx.isSSL ? 443 : 80;
    const authority = port === defaultPort ? hostname : `${hostname}:${port}`;
    return new URL(rawUrl, `${protocol}://${authority}`);
  }
}

function sanitizeCaptureFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeMaybeEncoded(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function isGenericTorrentName(name) {
  const normalized = sanitizeCaptureFileName(name).toLowerCase();
  return (
    !normalized ||
    normalized === 'download' ||
    normalized === 'download.torrent' ||
    normalized === 'torrent' ||
    normalized === 'torrent.torrent' ||
    normalized === '.torrent'
  );
}

function getTorrentFileName(targetUrl, headers) {
  const contentDisposition = String(headers['content-disposition'] || '');
  const filenameMatch =
    contentDisposition.match(/filename\*=UTF-8''([^;]+)/i) ||
    contentDisposition.match(/filename="?([^"]+)"?/i);

  if (filenameMatch && filenameMatch[1]) {
    const headerName = decodeMaybeEncoded(filenameMatch[1]);
    if (!isGenericTorrentName(headerName)) {
      return headerName;
    }
  }

  const queryParamCandidates = ['title', 'name', 'filename', 'file', 'download', 'dn'];
  for (const key of queryParamCandidates) {
    const value = targetUrl.searchParams.get(key);
    if (value && !isGenericTorrentName(value)) {
      return decodeMaybeEncoded(value);
    }
  }

  const pathnameBase = decodeMaybeEncoded(path.basename(targetUrl.pathname || '').trim());
  if (pathnameBase && !isGenericTorrentName(pathnameBase)) {
    return pathnameBase;
  }

  return `${targetUrl.hostname.replace(/[^a-z0-9.-]/gi, '_')}-${Date.now()}.torrent`;
}

function shouldCaptureTorrent(targetUrl, headers) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const contentDisposition = String(headers['content-disposition'] || '').toLowerCase();
  const pathname = String(targetUrl.pathname || '').toLowerCase();

  if (pathname.endsWith('.ts')) {
    return false;
  }

  return (
    pathname.endsWith('.torrent') ||
    contentDisposition.includes('.torrent') ||
    contentType.includes('application/x-bittorrent') ||
    contentType.includes('application/octet-stream')
  );
}

function shouldLogStream(targetUrl) {
  const pathname = String(targetUrl.pathname || '').toLowerCase();
  return pathname.endsWith('.ts');
}

function getUniqueCapturePath(fileName) {
  const sanitizedBaseName = sanitizeCaptureFileName(fileName) || `torrent-${Date.now()}.torrent`;
  const parsed = path.parse(
    sanitizedBaseName.endsWith('.torrent') ? sanitizedBaseName : `${sanitizedBaseName}.torrent`
  );
  let candidatePath = path.join(TORRENT_CAPTURE_DIR, `${parsed.name}${parsed.ext || '.torrent'}`);
  let suffix = 1;

  while (fs.existsSync(candidatePath)) {
    candidatePath = path.join(
      TORRENT_CAPTURE_DIR,
      `${parsed.name}-${suffix}${parsed.ext || '.torrent'}`
    );
    suffix += 1;
  }

  return candidatePath;
}

function saveCapturedTorrent(targetUrl, headers, chunks) {
  try {
    fs.mkdirSync(TORRENT_CAPTURE_DIR, { recursive: true });
    const fileName = getTorrentFileName(targetUrl, headers);
    const capturePath = getUniqueCapturePath(fileName);

    fs.writeFileSync(capturePath, Buffer.concat(chunks));
    log(`TORRENT  saved ${path.basename(capturePath)} from ${targetUrl.hostname}${targetUrl.pathname}`);
    void sendTorrentToTransmission(capturePath);
  } catch (error) {
    log(`ERROR    torrent capture failed for ${targetUrl.hostname}${targetUrl.pathname}  ${error.message}`);
  }
}

function buildTransmissionHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (transmissionSessionId) {
    headers['X-Transmission-Session-Id'] = transmissionSessionId;
  }

  if (TRANSMISSION_USERNAME || TRANSMISSION_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(
      `${TRANSMISSION_USERNAME}:${TRANSMISSION_PASSWORD}`
    ).toString('base64')}`;
  }

  return headers;
}

async function postToTransmission(payload, allowRetry = true) {
  const response = await fetch(TRANSMISSION_RPC_URL, {
    method: 'POST',
    headers: buildTransmissionHeaders(),
    body: JSON.stringify(payload),
  });

  if (response.status === 409 && allowRetry) {
    transmissionSessionId = response.headers.get('X-Transmission-Session-Id') || '';
    return postToTransmission(payload, false);
  }

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(responseBody.result || `Transmission RPC failed with status ${response.status}`);
  }

  if (responseBody.result !== 'success') {
    throw new Error(responseBody.result || 'Transmission RPC returned an unexpected result');
  }

  return responseBody;
}

async function sendTorrentToTransmission(torrentPath) {
  try {
    const metainfo = fs.readFileSync(torrentPath).toString('base64');
    const args = {
      metainfo,
      paused: false,
    };

    if (TRANSMISSION_DOWNLOAD_DIR.trim()) {
      args['download-dir'] = TRANSMISSION_DOWNLOAD_DIR.trim();
    }

    const response = await postToTransmission({
      method: 'torrent-add',
      arguments: args,
    });

    const addedTorrent =
      response.arguments?.['torrent-added'] || response.arguments?.['torrent-duplicate'] || null;

    log(
      `TRANSMISSION  added ${path.basename(torrentPath)}${
        addedTorrent?.name ? ` as "${addedTorrent.name}"` : ''
      }`
    );
  } catch (error) {
    log(`ERROR    transmission add failed for ${path.basename(torrentPath)}  ${error.message}`);
  }
}

function createProxyServer() {
  const proxy = new MitmProxy();

  proxy.use(MitmProxy.wildcard);

  proxy.onError((ctx, err, errorKind) => {
    const targetUrl = ctx ? getRequestUrl(ctx) : null;
    const target = targetUrl ? `${targetUrl.hostname}${targetUrl.pathname}` : 'unknown';
    log(`ERROR    ${errorKind} ${target}  ${err.message}`);
  });

  proxy.onRequest((ctx, callback) => {
    const targetUrl = getRequestUrl(ctx);
    const targetPort = Number(targetUrl.port) || (ctx.isSSL ? 443 : 80);
    const hostname = targetUrl.hostname.toLowerCase();

    ctx.tags = ctx.tags || {};
    ctx.tags.targetUrl = targetUrl;
    ctx.tags.hostname = hostname;
    ctx.tags.captureTorrent = false;
    ctx.tags.torrentChunks = [];
    ctx.tags.torrentBytes = 0;

    if (!isAllowedProxyHost(hostname) && !isManagerRequest(hostname, targetPort)) {
      ctx.proxyToClientResponse.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      ctx.proxyToClientResponse.end('Blocked by proxy policy');
      log(`BLOCKED  ${ctx.isSSL ? 'https' : 'http'}://${hostname}:${targetPort}${targetUrl.pathname}${targetUrl.search}`);
      return;
    }

    if (shouldLogProxyRequest(targetUrl, targetPort)) {
      log(`REQUEST  ${ctx.clientToProxyRequest.method} ${ctx.isSSL ? 'https' : 'http'}://${hostname}:${targetPort}${targetUrl.pathname}${targetUrl.search}`);
    }
    return callback();
  });

  proxy.onResponse((ctx, callback) => {
    const targetUrl = ctx.tags?.targetUrl || getRequestUrl(ctx);
    const headers = ctx.serverToProxyResponse?.headers || {};
    const statusCode = ctx.serverToProxyResponse?.statusCode || 0;

    const targetPort = Number(targetUrl.port) || (ctx.isSSL ? 443 : 80);

    if (shouldLogProxyRequest(targetUrl, targetPort)) {
      log(
        `HTTP     ${ctx.clientToProxyRequest.method} ${targetUrl.hostname}:${targetPort}${targetUrl.pathname}${targetUrl.search} -> ${statusCode}`
      );
    }

    if (shouldCaptureTorrent(targetUrl, headers)) {
      ctx.tags.captureTorrent = true;
      ctx.tags.torrentChunks = [];
      ctx.tags.torrentBytes = 0;
      log(
        `TORRENT  detected ${ctx.clientToProxyRequest.method} ${targetUrl.hostname}${targetUrl.pathname}${targetUrl.search}`
      );
    } else if (shouldLogStream(targetUrl)) {
      log(
        `STREAM   ${ctx.clientToProxyRequest.method} ${targetUrl.hostname}${targetUrl.pathname}${targetUrl.search} -> ${statusCode}`
      );
    }

    return callback();
  });

  proxy.onResponseData((ctx, chunk, callback) => {
    if (ctx.tags?.captureTorrent) {
      ctx.tags.torrentBytes += chunk.length;

      if (ctx.tags.torrentBytes > MAX_TORRENT_CAPTURE_BYTES) {
        ctx.tags.captureTorrent = false;
        ctx.tags.torrentChunks = [];
        log(`ERROR    torrent capture too large for ${ctx.tags.targetUrl.hostname}${ctx.tags.targetUrl.pathname}`);
      } else {
        ctx.tags.torrentChunks.push(Buffer.from(chunk));
      }
    }

    return callback(null, chunk);
  });

  proxy.onResponseEnd((ctx, callback) => {
    if (ctx.tags?.captureTorrent && ctx.tags.torrentChunks?.length) {
      saveCapturedTorrent(
        ctx.tags.targetUrl,
        ctx.serverToProxyResponse?.headers || {},
        ctx.tags.torrentChunks
      );
    }

    return callback();
  });

  return proxy;
}

function getStatus() {
  return {
    running: Boolean(proxyServer) && !proxyStarting,
    starting: proxyStarting,
    port: PROXY_PORT,
    bindHost: PROXY_BIND_HOST,
    displayHost: getPreferredDisplayHost(),
    allowedHost: getAllowedHosts().map((entry) => getManagedEntryLabel(entry)).join(', '),
    startedAt,
    mitmEnabled: true,
    forceSNI: PROXY_FORCE_SNI,
    caCertPath: PROXY_CA_CERT_FILE,
    caCertAvailable: fs.existsSync(PROXY_CA_CERT_FILE),
  };
}

function getWhitelistResponse() {
  return {
    entries: getCustomWhitelistHosts(),
    builtInEntries: [],
    ...getStatus(),
  };
}

function getLogFilterResponse() {
  return {
    entries: getCustomLogFilterHosts(),
    counts: getHiddenLogCounts(),
    ...getStatus(),
  };
}

function extractHostnameFromLogLine(line) {
  const rawLine = String(line || '').replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').trim();
  if (!rawLine) {
    return '';
  }

  const absoluteUrlMatch = rawLine.match(/https?:\/\/([^/:\s]+)/i);
  if (absoluteUrlMatch?.[1]) {
    return normalizeHostname(absoluteUrlMatch[1]);
  }

  const hostWithPortMatch = rawLine.match(/\b([a-z0-9.-]+):(\d+)\b/i);
  if (hostWithPortMatch?.[1]) {
    return normalizeHostname(hostWithPortMatch[1]);
  }

  const bareHostMatch = rawLine.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i);
  if (bareHostMatch?.[1]) {
    return normalizeHostname(bareHostMatch[1]);
  }

  return '';
}

function shouldIncludeLogLine(line) {
  const hostname = extractHostnameFromLogLine(line);
  if (!hostname) {
    return true;
  }

  return !isFilteredLogHost(hostname);
}

function readRawLogEntries() {
  try {
    const contents = fs.readFileSync(PROXY_LOG_FILE, 'utf8');
    return contents.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function readRecentLogEntries(limit = MAX_PROXY_LOG_LINES) {
  const lines = readRawLogEntries().filter(shouldIncludeLogLine);
  return lines.slice(-Math.max(1, limit));
}

router.get('/status', (_req, res) => {
  res.json(getStatus());
});

router.get('/whitelist', (_req, res) => {
  res.json(getWhitelistResponse());
});

router.get('/log-filters', (_req, res) => {
  res.json(getLogFilterResponse());
});

router.post('/whitelist', (req, res, next) => {
  try {
    const entry = normalizeManagedEntry(
      req.body?.value || req.body?.host,
      Boolean(req.body?.isRegex),
      'Enter a URL or hostname to whitelist.'
    );
    const customHosts = getCustomWhitelistHosts();

    if (customHosts.some((host) => host.key === entry.key)) {
      return res.json({
        message: `${getManagedEntryLabel(entry)} is already whitelisted`,
        ...getWhitelistResponse(),
      });
    }

    writeWhitelistHosts([...customHosts, entry]);
    log(`WHITELIST  added ${getManagedEntryLabel(entry)}`);
    return res.json({
      message: `${getManagedEntryLabel(entry)} added to proxy whitelist`,
      ...getWhitelistResponse(),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete('/whitelist', (req, res, next) => {
  try {
    const entry = normalizeManagedEntry(
      req.body?.value || req.body?.host,
      Boolean(req.body?.isRegex),
      'Enter a URL or hostname to whitelist.'
    );
    const customHosts = getCustomWhitelistHosts();
    if (!customHosts.some((host) => host.key === entry.key)) {
      const error = new Error(`${getManagedEntryLabel(entry)} is not in the custom proxy whitelist.`);
      error.status = 404;
      error.expose = true;
      throw error;
    }

    writeWhitelistHosts(customHosts.filter((host) => host.key !== entry.key));
    log(`WHITELIST  removed ${getManagedEntryLabel(entry)}`);
    return res.json({
      message: `${getManagedEntryLabel(entry)} removed from proxy whitelist`,
      ...getWhitelistResponse(),
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/whitelist', (req, res, next) => {
  try {
    const currentEntry = normalizeManagedEntry(
      req.body?.currentValue || req.body?.currentHost,
      Boolean(req.body?.currentIsRegex),
      'Enter a URL or hostname to whitelist.'
    );
    const nextEntry = normalizeManagedEntry(
      req.body?.value || req.body?.newValue || req.body?.host,
      Boolean(req.body?.isRegex),
      'Enter a URL or hostname to whitelist.'
    );
    const customHosts = getCustomWhitelistHosts();

    if (!customHosts.some((host) => host.key === currentEntry.key)) {
      const error = new Error(`${getManagedEntryLabel(currentEntry)} is not in the proxy whitelist.`);
      error.status = 404;
      error.expose = true;
      throw error;
    }

    const nextHosts = customHosts
      .filter((host) => host.key !== currentEntry.key)
      .concat(nextEntry);

    writeWhitelistHosts(nextHosts);
    log(`WHITELIST  updated ${getManagedEntryLabel(currentEntry)} -> ${getManagedEntryLabel(nextEntry)}`);
    return res.json({
      message: `${getManagedEntryLabel(currentEntry)} updated to ${getManagedEntryLabel(nextEntry)}`,
      ...getWhitelistResponse(),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/log-filters', (req, res, next) => {
  try {
    const entry = normalizeManagedEntry(
      req.body?.value || req.body?.host,
      Boolean(req.body?.isRegex),
      'Enter a URL or hostname to hide from the log.'
    );
    const customHosts = getCustomLogFilterHosts();

    if (customHosts.some((host) => host.key === entry.key)) {
      return res.json({
        message: `${getManagedEntryLabel(entry)} is already in the proxy log filter`,
        ...getLogFilterResponse(),
      });
    }

    writeLogFilterHosts([...customHosts, entry]);
    log(`LOGFILTER  added ${getManagedEntryLabel(entry)}`);
    return res.json({
      message: `${getManagedEntryLabel(entry)} added to proxy log filter`,
      ...getLogFilterResponse(),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete('/log-filters', (req, res, next) => {
  try {
    const entry = normalizeManagedEntry(
      req.body?.value || req.body?.host,
      Boolean(req.body?.isRegex),
      'Enter a URL or hostname to hide from the log.'
    );
    const customHosts = getCustomLogFilterHosts();
    if (!customHosts.some((host) => host.key === entry.key)) {
      const error = new Error(`${getManagedEntryLabel(entry)} is not in the proxy log filter.`);
      error.status = 404;
      error.expose = true;
      throw error;
    }

    writeLogFilterHosts(customHosts.filter((host) => host.key !== entry.key));
    log(`LOGFILTER  removed ${getManagedEntryLabel(entry)}`);
    return res.json({
      message: `${getManagedEntryLabel(entry)} removed from proxy log filter`,
      ...getLogFilterResponse(),
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/log-filters', (req, res, next) => {
  try {
    const currentEntry = normalizeManagedEntry(
      req.body?.currentValue || req.body?.currentHost,
      Boolean(req.body?.currentIsRegex),
      'Enter a URL or hostname to hide from the log.'
    );
    const nextEntry = normalizeManagedEntry(
      req.body?.value || req.body?.newValue || req.body?.host,
      Boolean(req.body?.isRegex),
      'Enter a URL or hostname to hide from the log.'
    );
    const customHosts = getCustomLogFilterHosts();

    if (!customHosts.some((host) => host.key === currentEntry.key)) {
      const error = new Error(`${getManagedEntryLabel(currentEntry)} is not in the proxy log filter.`);
      error.status = 404;
      error.expose = true;
      throw error;
    }

    const nextHosts = customHosts
      .filter((host) => host.key !== currentEntry.key)
      .concat(nextEntry);

    writeLogFilterHosts(nextHosts);
    log(`LOGFILTER  updated ${getManagedEntryLabel(currentEntry)} -> ${getManagedEntryLabel(nextEntry)}`);
    return res.json({
      message: `${getManagedEntryLabel(currentEntry)} updated to ${getManagedEntryLabel(nextEntry)}`,
      ...getLogFilterResponse(),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/log-filters/reset-counts', (_req, res) => {
  resetHiddenLogCounts();
  res.json({
    message: 'Log filter counters reset',
    ...getLogFilterResponse(),
  });
});

router.get('/logs', (req, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit || MAX_PROXY_LOG_LINES);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
      : MAX_PROXY_LOG_LINES;
    const entries = readRecentLogEntries(limit);

    res.json({
      entries,
      count: entries.length,
      limit,
      ...getStatus(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/logs/text', (req, res, next) => {
  try {
    const contents = fs.existsSync(PROXY_LOG_FILE)
      ? fs.readFileSync(PROXY_LOG_FILE, 'utf8')
      : '';

    res.type('text/plain; charset=utf-8');
    res.send(contents);
  } catch (error) {
    next(error);
  }
});

router.get('/ca-cert', (_req, res, next) => {
  try {
    if (!fs.existsSync(PROXY_CA_CERT_FILE)) {
      const error = new Error('Proxy CA certificate is not available yet. Start the proxy first.');
      error.status = 404;
      error.expose = true;
      throw error;
    }

    return res.download(PROXY_CA_CERT_FILE, 'proxy-ca.pem');
  } catch (error) {
    return next(error);
  }
});

router.post('/refresh-whitelist', (_req, res) => {
  const status = getStatus();

  log('REFRESH  whitelist host updated');
  res.json({
    message: 'Proxy whitelist refreshed',
    ...status,
  });
});

router.post('/clear-logs', (_req, res, next) => {
  try {
    fs.writeFileSync(PROXY_LOG_FILE, '');
    lastLoggedLine = '';
    hiddenLogCounts = Object.create(null);
    res.json({
      message: 'Proxy logs cleared',
      ...getStatus(),
    });
  } catch (error) {
    next(error);
  }
});

function autoStartProxy() {
  try {
    if (proxyServer || proxyStarting) {
      return;
    }

    fs.mkdirSync(PROXY_CA_DIR, { recursive: true });
    proxyStarting = true;
    proxyServer = createProxyServer();
    let handled = false;
    let startTimeout = null;

    const clearStartTimeout = () => {
      if (startTimeout) {
        clearTimeout(startTimeout);
        startTimeout = null;
      }
    };

    const handleStartError = (error) => {
      if (handled) {
        return;
      }

      handled = true;
      clearStartTimeout();
      proxyStarting = false;
      proxyServer = null;
      startedAt = null;
      log(`ERROR    proxy auto-start failed  ${error.message}`);
    };

    const handleStartSuccess = () => {
      if (handled) {
        return;
      }

      handled = true;
      clearStartTimeout();
      proxyStarting = false;
      startedAt = new Date().toISOString();
      log(`STARTED  ${PROXY_BIND_HOST}:${PROXY_PORT}  mitm=true forceSNI=${PROXY_FORCE_SNI}`);
    };

    startTimeout = setTimeout(() => {
      handleStartError(new Error(`Timed out after ${PROXY_START_TIMEOUT_MS}ms while auto-starting the proxy`));
    }, PROXY_START_TIMEOUT_MS);

    proxyServer.listen(
      {
        port: PROXY_PORT,
        host: PROXY_BIND_HOST,
        sslCaDir: PROXY_CA_DIR,
        forceSNI: PROXY_FORCE_SNI,
      },
      (error) => {
        if (error) {
          handleStartError(error);
          return;
        }

        handleStartSuccess();
      }
    );
  } catch (error) {
    proxyStarting = false;
    proxyServer = null;
    startedAt = null;
    log(`ERROR    proxy auto-start threw  ${error.message}`);
  }
}

router.post('/start', (_req, res) => {
  try {
    if (proxyServer || proxyStarting) {
      return res.json({
        message: proxyStarting ? 'Proxy is still starting' : 'Proxy is already running',
        ...getStatus(),
      });
    }

    let handled = false;

    const originalProxyStarting = proxyStarting;
    const startCheckInterval = setInterval(() => {
      if (!proxyStarting && !originalProxyStarting && proxyServer) {
        clearInterval(startCheckInterval);
        handled = true;
        res.json({
          message: 'Proxy started',
          ...getStatus(),
        });
      }
    }, 100);

    setTimeout(() => {
      if (!handled) {
        clearInterval(startCheckInterval);
        handled = true;
        if (proxyServer) {
          res.json({
            message: 'Proxy started',
            ...getStatus(),
          });
        } else {
          res.status(500).json({
            error: 'Proxy start timed out',
            ...getStatus(),
          });
        }
      }
    }, PROXY_START_TIMEOUT_MS + 1000);

    autoStartProxy();
    return undefined;
  } catch (error) {
    return res.status(500).json({
      error: `Proxy start failed: ${error.message}`,
      ...getStatus(),
    });
  }
});

router.post('/stop', (_req, res) => {
  if (proxyStarting) {
    return res.status(409).json({
      error: 'Proxy is still starting. Please wait a moment and try again.',
      ...getStatus(),
    });
  }

  if (!proxyServer) {
    return res.json({
      message: 'Proxy is already stopped',
      ...getStatus(),
    });
  }

  const serverToStop = proxyServer;
  const previousStartedAt = startedAt;
  proxyServer = null;
  startedAt = null;

  try {
    serverToStop.close();
  } catch (error) {
    proxyServer = serverToStop;
    startedAt = previousStartedAt;
    return res.status(500).json({
      error: `Proxy stop failed: ${error.message}`,
      ...getStatus(),
    });
  }

  log(`STOPPED  ${PROXY_BIND_HOST}:${PROXY_PORT}`);
  return res.json({
    message: 'Proxy stopped',
    ...getStatus(),
  });
});

module.exports = router;
module.exports.autoStartProxy = autoStartProxy;
