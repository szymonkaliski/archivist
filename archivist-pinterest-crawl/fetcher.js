const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const md5 = require("md5");
const mkdirp = require("mkdirp");
const path = require("path");
const wget = require("node-wget");
const urlStatusCode = require("url-status-code");

const TMP_PATH = envPaths("archivist-pinterest").data;
const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");

mkdirp(TMP_PATH);
mkdirp(DATA_PATH);
mkdirp(ASSETS_PATH);

const download = async url => {
  console.log("downloading", url);

  const tempName = `TMP-${encodeURIComponent(url)}`; // TODO: ?
  const tempPath = path.join(TMP_PATH, tempName);

  return new Promise((resolve, reject) =>
    wget({ url, dest: tempPath }, (error, result, body) => {
      if (error) {
        return reject(error);
      }

      const ext = path.extname(url);
      const hash = md5(body);
      const filename = `${hash}${ext}`;

      fs.renameSync(tempPath, path.join(ASSETS_PATH, filename));

      resolve(filename);
    })
  );
};

module.exports = async crawledPins => {
  return new Promise(resolve => {
    async.mapLimit(
      crawledPins,
      10,
      async pin => {
        return new Promise(resolve => {
          urlStatusCode(pin.imgSrc, async (err, statusCode) => {
            const url = statusCode === 200 ? pin.imgSrc : pin.imgSrcFromPage;

            const filename = await download(url);

            resolve({ ...pin, filename });
          });
        });
      },
      (err, res) => {
        resolve(res);
      }
    );
  });
};
