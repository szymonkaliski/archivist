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
      (filename, next) => {
        const inputPath = path.join(options.directory, filename);
        const outputName = path.parse(filename).name + ".jpg";
        const outputPath = path.join(THUMBS_PATH, outputName);

        const alreadyExists = fs.existsSync(outputPath);
        const shouldMakeThumbnail = FORCE_RECREATE_THUMBS || !alreadyExists;

        if (shouldMakeThumbnail) {
          console.log(
            "[archivist-screenshot]",
            `making thumbnail for ${inputPath} -> ${outputPath}`
          );

          sharp(inputPath)
            .resize(THUMB_SIZE)
            .png()
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
