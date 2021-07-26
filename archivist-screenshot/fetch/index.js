const async = require("async");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const { THUMBS_PATH } = require("../consts");

const FORCE_RECREATE_THUMBS = false;
const THUMB_SIZE = 400;

// TODO: remove thumbnails if original file doesn't exist anymore
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
        const shouldMakeThumbnail = FORCE_RECREATE_THUMBS || !alreadyExists;

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
