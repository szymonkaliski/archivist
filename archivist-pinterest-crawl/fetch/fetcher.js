const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const md5 = require("md5");
const mkdirp = require("mkdirp");
const path = require("path");
const sizeOf = require("image-size");
const tmp = require("tmp");
const wget = require("node-wget");

const TMP_PATH = envPaths("archivist-pinterest").data;
const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");

mkdirp(TMP_PATH);
mkdirp(DATA_PATH);
mkdirp(ASSETS_PATH);

const download = async url => {
  console.log("[archivist-pinterest-crawl]", "downloading", url);

  const tempPath = tmp.tmpNameSync();

  return new Promise((resolve, reject) =>
    wget({ url, dest: tempPath }, (error, result, body) => {
      if (error) {
        return reject(error);
      }

      const ext = path.extname(url);
      const hash = md5(body);
      const filename = `${hash}${ext}`;
      const finalPath = path.join(ASSETS_PATH, filename);

      fs.renameSync(tempPath, finalPath);

      sizeOf(finalPath, (err, size) => {
        if (err) {
          console.log(
            "[archivist-pinterest-crawl]",
            `image-size error: ${err} (${finalPath})`
          );
          resolve({ filename, width: 0, height: 0 });
        } else {
          resolve({ filename, ...size });
        }
      });
    })
  );
};

module.exports = async crawledPins => {
  return new Promise(resolve => {
    async.mapLimit(
      crawledPins,
      10,
      async pin => {
        const { filename, width, height } = await download(pin.biggestSrc);
        return { ...pin, filename, width, height };
      },
      (err, res) => {
        resolve(res);
      }
    );
  });
};
