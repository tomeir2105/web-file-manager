const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const extract = require('extract-zip');

const {
  getRelativePath,
  getBaseDir,
  resolveSafePath,
  sanitizeFileName,
  toApiPath,
} = require('../utils/safePath');
const { APP_CONFIG_FILE, setConfiguredRoot } = require('../utils/appConfig');
const {
  DEFAULT_APP_UPDATE_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  removeUploadedFile,
  uploadAppUpdate,
  uploadFile,
} = require('../utils/uploads');

const router = express.Router();
const execFileAsync = promisify(execFile);

const VIDEO_EXTENSION = '.mp4';
const SUBTITLE_EXTENSION = '.srt';
const ZIP_EXTENSION = '.zip';
const APP_UPDATE_TARGET_DIR =
  process.env.APP_UPDATE_TARGET_DIR || '/home/user/jellyfin-file-manager';
const APP_UPDATE_SERVICE_NAME = process.env.APP_UPDATE_SERVICE_NAME || 'jellyfin-file-manager';
const APP_UPDATE_RESTART_CMD = process.env.APP_UPDATE_RESTART_CMD || '';
const APP_UPDATE_RECOVERY_WAIT_MS = Number(process.env.APP_UPDATE_RECOVERY_WAIT_MS || 8000);
const APP_UPDATE_RECOVERY_POLL_MS = Number(process.env.APP_UPDATE_RECOVERY_POLL_MS || 500);
const NOISE_TOKENS = new Set([
  '1080p',
  '2160p',
  '480p',
  '720p',
  'bluray',
  'brrip',
  'dvdrip',
  'webrip',
  'web-dl',
  'webdl',
  'hdrip',
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'aac',
  'ac3',
  'dts',
  'yify',
  'yts',
  'ytslt',
  'ytsmx',
  'proper',
  'repack',
  'extended',
  'remastered',
  'multi',
  '51',
]);
const LANGUAGE_SUFFIXES = new Set([
  'ara',
  'ar',
  'eng',
  'en',
  'fre',
  'fr',
  'ger',
  'de',
  'heb',
  'he',
  'hin',
  'hi',
  'ita',
  'it',
  'jpn',
  'ja',
  'kor',
  'ko',
  'por',
  'pt',
  'rus',
  'ru',
  'spa',
  'es',
  'sub',
]);

function createHttpError(status, message, expose = true) {
  const error = new Error(message);
  error.status = status;
  error.expose = expose;
  return error;
}

async function statSafe(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw createHttpError(404, 'Path not found');
    }
    throw error;
  }
}

async function cleanupSafe(targetPath) {
  if (!targetPath) {
    return;
  }

  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
}

async function resolveUpdateSourceRoot(extractedPath) {
  const entries = await fs.readdir(extractedPath, { withFileTypes: true });
  const relevantEntries = entries.filter(
    (entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store'
  );

  const topLevelDirectories = relevantEntries.filter((entry) => entry.isDirectory());
  const topLevelFiles = relevantEntries.filter((entry) => entry.isFile());

  if (topLevelDirectories.length === 1 && topLevelFiles.length === 0) {
    return path.join(extractedPath, topLevelDirectories[0].name);
  }

  return extractedPath;
}

async function restartUpdatedService() {
  try {
    if (APP_UPDATE_RESTART_CMD.trim()) {
      return await execFileAsync('sh', ['-lc', APP_UPDATE_RESTART_CMD], {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
    }

    return await execFileAsync(
      'systemctl',
      ['restart', APP_UPDATE_SERVICE_NAME],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      }
    );
  } catch (error) {
    const details = [error.stderr, error.stdout, error.message]
      .filter(Boolean)
      .join(' ')
      .trim();
    const permissionHint = /permission denied|access denied|interactive authentication|required/i.test(
      details
    )
      ? ' Check the service user permissions or set APP_UPDATE_RESTART_CMD to a restart command that has the needed privileges.'
      : '';

    throw createHttpError(
      500,
      `Files were updated, but restarting "${APP_UPDATE_SERVICE_NAME}" failed.${permissionHint}${
        details ? ` Details: ${details}` : ''
      }`
    );
  }
}

async function getServiceStatus() {
  try {
    if (APP_UPDATE_RESTART_CMD.trim()) {
      await execFileAsync('systemctl', ['is-active', '--quiet', APP_UPDATE_SERVICE_NAME], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
    } else {
      await execFileAsync('systemctl', ['is-active', '--quiet', APP_UPDATE_SERVICE_NAME], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
    }

    return {
      service: APP_UPDATE_SERVICE_NAME,
      status: 'online',
    };
  } catch (error) {
    const details = [error.stderr, error.stdout, error.message]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();

    if (
      error.code === 3 ||
      /inactive|failed|unknown|could not be found|not loaded|not-found/i.test(details)
    ) {
      return {
        service: APP_UPDATE_SERVICE_NAME,
        status: 'offline',
      };
    }

    return {
      service: APP_UPDATE_SERVICE_NAME,
      status: 'offline',
      detail: details || 'status check failed',
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServiceOnline(timeoutMs = APP_UPDATE_RECOVERY_WAIT_MS) {
  const deadline = Date.now() + Math.max(timeoutMs, 0);

  while (Date.now() <= deadline) {
    const status = await getServiceStatus();

    if (status.status === 'online') {
      return status;
    }

    if (Date.now() >= deadline) {
      return status;
    }

    await delay(APP_UPDATE_RECOVERY_POLL_MS);
  }

  return getServiceStatus();
}

function scheduleServiceRestart() {
  setTimeout(async () => {
    try {
      await restartUpdatedService();
    } catch (error) {
      // The updated files are already in place, so keep the failure non-fatal.
      console.error(error.message || error);
      return;
    }

    const statusAfterRecovery = await waitForServiceOnline().catch(() => ({
      status: 'offline',
    }));

    if (statusAfterRecovery.status !== 'online') {
      console.error(`Service "${APP_UPDATE_SERVICE_NAME}" did not come back online after update restart`);
    }
  }, 250);
}

async function buildDirectoryListing(currentPath, searchTerm = '') {
  const baseDir = getBaseDir();
  const directoryPath = resolveSafePath(currentPath);
  const directoryStat = await statSafe(directoryPath);

  if (!directoryStat.isDirectory()) {
    throw createHttpError(400, 'Requested path is not a directory');
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const normalizedSearch = searchTerm.trim().toLowerCase();

  const items = await Promise.all(
    entries
      .filter((entry) => !normalizedSearch || entry.name.toLowerCase().includes(normalizedSearch))
      .map(async (entry) => {
        const absoluteChildPath = path.join(directoryPath, entry.name);
        const childStat = await fs.stat(absoluteChildPath);
        const relativeChildPath = getRelativePath(absoluteChildPath);

        return {
          name: entry.name,
          path: toApiPath(relativeChildPath),
          type: entry.isDirectory() ? 'folder' : 'file',
          size: entry.isDirectory() ? 0 : childStat.size,
          modified: childStat.mtime.toISOString(),
        };
      })
  );

  items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'folder' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  const folderCount = items.filter((item) => item.type === 'folder').length;
  const fileCount = items.length - folderCount;
  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const normalizedCurrent = toApiPath(getRelativePath(directoryPath));
  const parentPath = normalizedCurrent
    ? toApiPath(path.dirname(normalizedCurrent).replace(/\\/g, '/'))
    : null;

  return {
    basePath: baseDir,
    currentPath: normalizedCurrent,
    parentPath: parentPath === '.' ? '' : parentPath,
    items,
    stats: {
      fileCount,
      folderCount,
      totalSize,
    },
  };
}

function cleanMediaBaseName(fileName) {
  const extension = path.extname(fileName);
  const rawBaseName = path.basename(fileName, extension);

  const withoutBrackets = rawBaseName
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*]/g, ' ')
    .replace(/\{[^}]*}/g, ' ')
    .replace(/\baac\s*5(?:[._\s]?1)?\b/gi, ' ');

  const normalized = withoutBrackets
    .replace(/[._]+/g, ' ')
    .replace(/['’]/g, '')
    .replace(/\s+-\s+/g, ' ')
    .replace(/-/g, ' ');

  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^(19|20)\d{2}$/.test(token))
    .filter((token) => !NOISE_TOKENS.has(token.toLowerCase().replace(/[^a-z0-9]/g, '')));

  let cleaned = tokens.join(' ').replace(/\s+/g, ' ').trim();

  if (tokens.length > 1) {
    const lastToken = tokens[tokens.length - 1].toLowerCase();

    if (LANGUAGE_SUFFIXES.has(lastToken)) {
      const baseTokens = tokens.slice(0, -1);
      const baseName = baseTokens.join(' ').replace(/\s+/g, ' ').trim();

      if (baseName) {
        cleaned = `${baseName}.${tokens[tokens.length - 1]}`;
      }
    }
  }

  return cleaned || rawBaseName.trim();
}

function splitLanguageSuffix(cleanedBaseName) {
  const match = cleanedBaseName.match(/^(.*)\.([^.]+)$/);
  if (!match) {
    return {
      titleBaseName: cleanedBaseName,
      languageSuffix: '',
    };
  }

  const suffix = match[2].toLowerCase();
  if (!LANGUAGE_SUFFIXES.has(suffix)) {
    return {
      titleBaseName: cleanedBaseName,
      languageSuffix: '',
    };
  }

  return {
    titleBaseName: match[1],
    languageSuffix: match[2],
  };
}

function detectSubtitleSuffix(fileName) {
  const loweredName = fileName.toLowerCase();

  if (/\b(heb|hebrew)\b/i.test(loweredName)) {
    return 'forced.heb';
  }

  if (/\b(eng|english)\b/i.test(loweredName)) {
    return 'forced.eng';
  }

  return 'forced';
}

function createCandidate(fileName, directoryRelativePath) {
  const cleanedBaseName = cleanMediaBaseName(fileName);
  const { titleBaseName, languageSuffix } = splitLanguageSuffix(cleanedBaseName);

  const extension = path.extname(fileName).toLowerCase();
  return {
    name: fileName,
    extension,
    path: toApiPath(path.join(directoryRelativePath, fileName)),
    cleanedBaseName,
    titleBaseName,
    languageSuffix,
  };
}

async function collectMediaRenameSuggestions() {
  const baseDir = getBaseDir();
  const suggestions = [];

  async function readSubtitleCandidates(absoluteDirectoryPath, relativeDirectoryPath) {
    const entries = await fs.readdir(absoluteDirectoryPath, { withFileTypes: true });
    const subtitles = [];

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== SUBTITLE_EXTENSION) {
        continue;
      }

      subtitles.push(createCandidate(entry.name, relativeDirectoryPath));
    }

    return subtitles;
  }

  async function walkDirectory(absoluteDirectoryPath) {
    const entries = await fs.readdir(absoluteDirectoryPath, { withFileTypes: true });
    const relativeDirectoryPath = getRelativePath(absoluteDirectoryPath);
    const videos = [];
    const localSubtitles = [];
    let subsDirectory = null;

    for (const entry of entries) {
      const entryPath = path.join(absoluteDirectoryPath, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'subs') {
          subsDirectory = {
            absolutePath: entryPath,
            relativePath: getRelativePath(entryPath),
          };
        }

        await walkDirectory(entryPath);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (extension === VIDEO_EXTENSION) {
        videos.push(createCandidate(entry.name, relativeDirectoryPath));
      }

      if (extension === SUBTITLE_EXTENSION) {
        localSubtitles.push(createCandidate(entry.name, relativeDirectoryPath));
      }
    }

    const subsFolderSubtitles = subsDirectory
      ? await readSubtitleCandidates(subsDirectory.absolutePath, subsDirectory.relativePath)
      : [];
    const subtitles = [...localSubtitles, ...subsFolderSubtitles];

    if (!subtitles.length || !videos.length) {
      return;
    }

    const usedSubtitlePaths = new Set();

    for (const video of videos) {
      let matchedSubtitle = subtitles.find(
        (subtitle) =>
          !usedSubtitlePaths.has(subtitle.path) && subtitle.titleBaseName === video.titleBaseName
      );

      if (!matchedSubtitle && subtitles.length === 1 && videos.length === 1) {
        matchedSubtitle = subtitles[0];
      }

      if (!matchedSubtitle) {
        continue;
      }

      usedSubtitlePaths.add(matchedSubtitle.path);

      const videoBaseName = video.titleBaseName || video.cleanedBaseName;
      const subtitleSuffix = detectSubtitleSuffix(matchedSubtitle.name);
      const subtitleBaseName = `${videoBaseName}.${subtitleSuffix}`;
      const videoSuggestedName = `${videoBaseName}${VIDEO_EXTENSION}`;
      const subtitleSuggestedName = `${subtitleBaseName}${SUBTITLE_EXTENSION}`;

      if (video.name !== videoSuggestedName || matchedSubtitle.name !== subtitleSuggestedName) {
        suggestions.push({
          folderPath: toApiPath(relativeDirectoryPath),
          suggestedBaseName: videoBaseName,
          subtitleSuffix,
          video: {
            path: video.path,
            oldName: video.name,
            suggestedName: videoSuggestedName,
          },
          subtitle: {
            path: matchedSubtitle.path,
            oldName: matchedSubtitle.name,
            suggestedName: subtitleSuggestedName,
            folderPath: matchedSubtitle.path.includes('/')
              ? matchedSubtitle.path.split('/').slice(0, -1).join('/')
              : '',
          },
        });
      }
    }
  }

  await walkDirectory(baseDir);

  suggestions.sort((left, right) => {
    const folderCompare = left.folderPath.localeCompare(right.folderPath);
    if (folderCompare !== 0) {
      return folderCompare;
    }

    return left.video.oldName.localeCompare(right.video.oldName);
  });

  return suggestions;
}

router.get('/', async (req, res, next) => {
  try {
    const listing = await buildDirectoryListing(req.query.path || '', req.query.search || '');
    res.json(listing);
  } catch (error) {
    next(error);
  }
});

router.get('/service-status', async (req, res, next) => {
  try {
    const payload = await getServiceStatus();
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get('/root', async (req, res, next) => {
  try {
    const basePath = getBaseDir();
    const rootStat = await statSafe(basePath);

    res.json({
      basePath,
      configFile: APP_CONFIG_FILE,
      exists: true,
      writable: Boolean(rootStat.mode),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/root', async (req, res, next) => {
  try {
    const requestedPath = String(req.body.path || '').trim();

    if (!requestedPath) {
      throw createHttpError(400, 'An absolute root path is required');
    }

    if (!path.isAbsolute(requestedPath)) {
      throw createHttpError(400, 'Root path must be absolute');
    }

    const nextBasePath = setConfiguredRoot(requestedPath);
    const listing = await buildDirectoryListing('');

    res.json({
      message: `Root folder updated to ${nextBasePath}`,
      ...listing,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return next(createHttpError(400, 'Root path does not exist'));
    }

    next(error);
  }
});

router.post('/upload', uploadFile.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw createHttpError(400, 'A file is required');
    }

    const currentPath = req.body.path || '';
    const directoryPath = resolveSafePath(currentPath);
    const fileName = sanitizeFileName(req.file.originalname);
    const destinationPath = path.join(directoryPath, fileName);

    const directoryStat = await statSafe(directoryPath);
    if (!directoryStat.isDirectory()) {
      throw createHttpError(400, 'Upload target must be a directory');
    }

    try {
      await fs.access(destinationPath);
      throw createHttpError(409, 'A file or folder with that name already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.rename(req.file.path, destinationPath);
    res.status(201).json({ message: 'File uploaded' });
  } catch (error) {
    next(error);
  } finally {
    await removeUploadedFile(req.file);
  }
});

router.post('/app-update', uploadAppUpdate.single('file'), async (req, res, next) => {
  let tempDirectory = '';

  try {
    if (!req.file) {
      throw createHttpError(400, 'A zip file is required');
    }

    const fileName = req.file.originalname || '';
    if (path.extname(fileName).toLowerCase() !== ZIP_EXTENSION) {
      throw createHttpError(400, 'Only .zip update files are supported');
    }

    const targetStat = await statSafe(APP_UPDATE_TARGET_DIR);
    if (!targetStat.isDirectory()) {
      throw createHttpError(400, 'The update target must be an existing directory');
    }

    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'jfm-update-'));
    const extractedPath = path.join(tempDirectory, 'extracted');

    await fs.mkdir(extractedPath);
    await extract(req.file.path, { dir: extractedPath });

    const updateSourceRoot = await resolveUpdateSourceRoot(extractedPath);
    await fs.cp(updateSourceRoot, APP_UPDATE_TARGET_DIR, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });

    res.json({
      message: `Update applied to ${APP_UPDATE_TARGET_DIR}. Restarting ${APP_UPDATE_SERVICE_NAME}...`,
    });

    scheduleServiceRestart();
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return next(
        createHttpError(
          500,
          `Update failed because the server process does not have enough permissions to overwrite files in ${APP_UPDATE_TARGET_DIR} or restart ${APP_UPDATE_SERVICE_NAME}`
        )
      );
    }

    next(error);
  } finally {
    await removeUploadedFile(req.file);
    await cleanupSafe(tempDirectory);
  }
});

router.get('/download', async (req, res, next) => {
  try {
    const absolutePath = resolveSafePath(req.query.path || '');
    const fileStat = await statSafe(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();

    if (!fileStat.isFile()) {
      throw createHttpError(400, 'Only files can be downloaded');
    }

    if (extension === SUBTITLE_EXTENSION) {
      throw createHttpError(400, 'SRT files are shown inline as text and cannot be downloaded');
    }

    return res.download(absolutePath, path.basename(absolutePath));
  } catch (error) {
    next(error);
  }
});

router.get('/show', async (req, res, next) => {
  try {
    const absolutePath = resolveSafePath(req.query.path || '');
    const fileStat = await statSafe(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();

    if (!fileStat.isFile()) {
      throw createHttpError(400, 'Only files can be shown');
    }

    if (extension === SUBTITLE_EXTENSION) {
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(absolutePath)}"`);
      res.type('text/plain; charset=utf-8');
      return res.send(await fs.readFile(absolutePath, 'utf8'));
    }

    res.setHeader('Content-Disposition', `inline; filename="${path.basename(absolutePath)}"`);
    return res.sendFile(absolutePath);
  } catch (error) {
    next(error);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const baseDir = getBaseDir();
    const absolutePath = resolveSafePath(req.body.path || '');

    if (absolutePath === baseDir) {
      throw createHttpError(400, 'The root folder cannot be deleted');
    }

    await statSafe(absolutePath);
    await fs.rm(absolutePath, { recursive: true, force: false });
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    next(error);
  }
});

router.post('/folder', async (req, res, next) => {
  try {
    const currentPath = req.body.path || '';
    const folderName = sanitizeFileName(req.body.name || '');
    const parentDirectory = resolveSafePath(currentPath);
    const targetPath = path.join(parentDirectory, folderName);

    const parentStat = await statSafe(parentDirectory);
    if (!parentStat.isDirectory()) {
      throw createHttpError(400, 'Folder can only be created inside a directory');
    }

    await fs.mkdir(targetPath);
    res.status(201).json({ message: 'Folder created' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return next(createHttpError(409, 'A file or folder with that name already exists'));
    }
    next(error);
  }
});

router.post('/rename', async (req, res, next) => {
  try {
    const baseDir = getBaseDir();
    const sourcePath = resolveSafePath(req.body.path || '');
    const newName = sanitizeFileName(req.body.newName || '');

    if (sourcePath === baseDir) {
      throw createHttpError(400, 'The root folder cannot be renamed');
    }

    await statSafe(sourcePath);

    const destinationPath = path.join(path.dirname(sourcePath), newName);

    try {
      await fs.access(destinationPath);
      throw createHttpError(409, 'A file or folder with that name already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.rename(sourcePath, destinationPath);
    res.json({ message: 'Renamed successfully' });
  } catch (error) {
    next(error);
  }
});

router.post('/media-rename/scan', async (req, res, next) => {
  try {
    const suggestions = await collectMediaRenameSuggestions();
    res.json({
      suggestions,
      count: suggestions.length,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/media-rename/apply', async (req, res, next) => {
  try {
    const renames = Array.isArray(req.body.renames) ? req.body.renames : null;

    if (!renames || renames.length === 0) {
      throw createHttpError(400, 'At least one rename is required');
    }

    const seenDestinations = new Set();
    const results = [];

    for (const rename of renames) {
      const sourcePath = resolveSafePath(rename.path || '');
      const newName = sanitizeFileName(rename.newName || '');
      const destinationPath = path.join(path.dirname(sourcePath), newName);
      const destinationKey = destinationPath.toLowerCase();

      await statSafe(sourcePath);

      if (sourcePath === destinationPath) {
        results.push({ path: rename.path, status: 'skipped' });
        continue;
      }

      if (seenDestinations.has(destinationKey)) {
        throw createHttpError(409, `Duplicate rename target: ${newName}`);
      }

      seenDestinations.add(destinationKey);

      try {
        await fs.access(destinationPath);
        throw createHttpError(409, `A file already exists with the name "${newName}"`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    for (const rename of renames) {
      const sourcePath = resolveSafePath(rename.path || '');
      const newName = sanitizeFileName(rename.newName || '');
      const destinationPath = path.join(path.dirname(sourcePath), newName);

      if (sourcePath === destinationPath) {
        continue;
      }

      await fs.rename(sourcePath, destinationPath);
      results.push({ path: rename.path, status: 'renamed', newName });
    }

    res.json({
      message: 'Rename batch complete',
      renamed: results.filter((item) => item.status === 'renamed').length,
      results,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
