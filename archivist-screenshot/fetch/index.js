const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const path = require("path");
const sharp = require("sharp");

const DATA_PATH = envPaths("archivist-screenshots").data;
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

mkdirp(THUMBS_PATH);

const FORCE_RECREATE = false;
const THUMB_SIZE = 400;

module.exports = (options) => {
  const files = fs
    .readdirSync(options.directory)
    .filter((f) => f.endsWith(".png"));

  return new Promise((resolve) => {
    async.eachLimit(
      files,
      10,
      (fileName, next) => {
        const inputPath = path.join(options.directory, fileName);
        const outputPath = path.join(THUMBS_PATH, fileName);

        const alreadyExists = fs.existsSync(outputPath);
        const shouldMakeThumbnail = FORCE_RECREATE || !alreadyExists;

        if (shouldMakeThumbnail) {
          sharp(inputPath)
            .resize(THUMB_SIZE)
            .toFile(outputPath, () => {
              next();
            });
        } else {
          next();
        }
      },
      () => {
        resolve();
      }
    );
  });
};
