const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'jfm-uploads');
const DEFAULT_UPLOAD_MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
const DEFAULT_APP_UPDATE_MAX_BYTES = Number(
  process.env.MAX_APP_UPDATE_BYTES || 250 * 1024 * 1024
);

fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });

function createUploader(maxBytes) {
  return multer({
    dest: UPLOAD_TEMP_DIR,
    limits: {
      fileSize: maxBytes,
      files: 1,
    },
  });
}

const uploadFile = createUploader(DEFAULT_UPLOAD_MAX_BYTES);
const uploadAppUpdate = createUploader(DEFAULT_APP_UPDATE_MAX_BYTES);

async function removeUploadedFile(file) {
  if (!file || !file.path) {
    return;
  }

  await fs.promises.rm(file.path, { force: true }).catch(() => {});
}

module.exports = {
  DEFAULT_APP_UPDATE_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  removeUploadedFile,
  uploadAppUpdate,
  uploadFile,
};
