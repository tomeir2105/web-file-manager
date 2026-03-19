const path = require('path');

const { getConfiguredRoot } = require('./appConfig');

function createPathError(message) {
  const error = new Error(message);
  error.status = 400;
  error.expose = true;
  return error;
}

function assertString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw createPathError('Invalid path');
  }

  return value;
}

function sanitizeRelativePath(inputPath = '') {
  const rawPath = assertString(inputPath).trim();

  if (!rawPath) {
    return '';
  }

  if (rawPath.includes('\0')) {
    throw createPathError('Invalid path');
  }

  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw createPathError('Absolute paths are not allowed');
  }

  const segments = normalized.split('/').filter(Boolean);

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw createPathError('Path traversal is not allowed');
    }
  }

  return segments.join(path.sep);
}

function sanitizeFileName(name) {
  const value = assertString(name).trim();

  if (!value) {
    throw createPathError('Name is required');
  }

  if (value.includes('\0')) {
    throw createPathError('Invalid name');
  }

  if (/[\\/]/.test(value) || value === '.' || value === '..') {
    throw createPathError('Invalid name');
  }

  return value;
}

function resolveSafePath(inputPath = '') {
  const baseDir = getConfiguredRoot();
  const relativePath = sanitizeRelativePath(inputPath);
  const resolved = path.resolve(baseDir, relativePath || '.');

  if (resolved !== baseDir && !resolved.startsWith(`${baseDir}${path.sep}`)) {
    throw createPathError('Path escapes the allowed directory');
  }

  return resolved;
}

function getRelativePath(absolutePath) {
  const baseDir = getConfiguredRoot();
  const relativePath = path.relative(baseDir, absolutePath);

  if (!relativePath) {
    return '';
  }

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw createPathError('Path escapes the allowed directory');
  }

  return relativePath;
}

function toApiPath(relativePath) {
  return relativePath ? relativePath.split(path.sep).join('/') : '';
}

module.exports = {
  getRelativePath,
  getBaseDir: getConfiguredRoot,
  resolveSafePath,
  sanitizeFileName,
  sanitizeRelativePath,
  toApiPath,
};
