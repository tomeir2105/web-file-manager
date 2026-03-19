const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_ROOT = '/mnt/storage/jellyfin/media';
const APP_CONFIG_FILE = process.env.APP_CONFIG_FILE || path.join(APP_ROOT, 'app.config.json');

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfigFile(config) {
  fs.writeFileSync(APP_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function getConfiguredRoot() {
  const config = readConfigFile();
  const configuredRoot = config.fileManagerRoot || process.env.FILE_MANAGER_ROOT || DEFAULT_ROOT;
  return path.resolve(configuredRoot);
}

function setConfiguredRoot(nextRoot) {
  const resolvedRoot = path.resolve(String(nextRoot || '').trim());
  const stats = fs.statSync(resolvedRoot);

  if (!stats.isDirectory()) {
    const error = new Error('Root path must point to an existing directory');
    error.status = 400;
    error.expose = true;
    throw error;
  }

  const currentConfig = readConfigFile();
  currentConfig.fileManagerRoot = resolvedRoot;
  writeConfigFile(currentConfig);

  return resolvedRoot;
}

module.exports = {
  APP_CONFIG_FILE,
  DEFAULT_ROOT,
  getConfiguredRoot,
  setConfiguredRoot,
};
