const archivist = require("archivist-cli/lib");

const async = require("async");
const express = require("express");
const fs = require("fs");
const gifFrames = require("gif-frames");
const imageThumbnail = require("image-thumbnail");
const level = require("level");
const mkdirp = require("mkdirp");
const mktemp = require("mktemp");
const mobilenet = require("@tensorflow-models/mobilenet");
const tf = require("@tensorflow/tfjs-node");
const { UMAP } = require("umap-js");

const app = express();
const activationCache = level("cache/activation");
const thumbnailCache = level("cache/thumbnail");
const mediumCache = level("cache/medium");

const getOrInsert = (cache, key, prepareCb, cb) => {
  cache.get(key, (err, cached) => {
    if (err) {
      prepareCb((err, result) => {
        if (err) {
          return cb(err);
        }

        cache.put(key, JSON.stringify(result), () => {
          cb(null, result);
        });
      });
    } else {
      cb(null, JSON.parse(cached));
    }
  });
};

const IMG_W = 224;
const IMG_H = 224;
const DO_WARMUP = false;

mkdirp("/tmp/archivist-browser/");

mobilenet.load().then((mobilenet) => {
  const prepareFile = (file, cb) => {
    if (file.endsWith("gif")) {
      const output = mktemp.createFileSync("/tmp/archivist-browser/XXXXXX.jpg");

      console.log("decoding gif to a first frame in file:", output);

      gifFrames({
        url: file,
        frames: 0,
        culmative: true,
      })
        .then((frameData) => {
          frameData[0]
            .getImage()
            .pipe(fs.createWriteStream(output))
            .on("finish", () => cb(null, output));
        })
        .catch((e) => {
          console.log("gif decoding error", e);
          cb(e);
        });
    } else {
      cb(null, file);
    }
  };

  const getActivation = (file, cb) => {
    prepareFile(file, (error, file) => {
      if (error) {
        cb(error);
        return;
      }

      try {
        const image = fs.readFileSync(file);
        const decoded = tf.node.decodeImage(image, 3);

        // this is black magic and I have no idea why it's necessary - but it works!
        const tensor = tf.image
          .resizeBilinear(decoded, [IMG_W, IMG_H])
          .toFloat()
          .div(255)
          .expandDims();

        mobilenet
          .infer(tensor)
          .data()
          .then((result) => {
            cb(null, Array.from(result));
          });
      } catch (e) {
        cb(e);
      }
    });
  };

  const getActivationCached = (file, cb) => {
    getOrInsert(
      activationCache,
      file,
      (cb) => {
        console.log("activationCache miss: " + file);
        getActivation(file, (err, result) => cb(err, result));
      },
      (err, result) => {
        cb(err, result);
      }
    );
  };

  const search = (query, cb) => {
    const limit = undefined;

    archivist.search(query, limit).then((found) => {
      found = found.value();

      async.mapSeries(
        found,
        (item, cb) => {
          getActivationCached(item.img, (err, preds) => {
            if (err) {
              console.log("Error for:", item.img, err);
              cb(null);
            } else {
              item.preds = preds;
              cb(null, item);
            }
          });
        },
        (err, results) => {
          results = results.filter((x) => !!x && x.preds !== undefined);

          if (cb) {
            cb(results);
          }
        }
      );
    });
  };

  const searchAndPrepare = (query, cb) => {
    console.time("search");

    search(undefined, (items) => {
      console.timeEnd("search");
      console.time("umap");

      const umap = new UMAP({
        nComponents: 2,
        nEpochs: 400,
        nNeighbors: 10,
      });

      const rawData = items.map((item) => item.preds);

      const nEpochs = umap.initializeFit(rawData);

      for (let i = 0; i < nEpochs; i++) {
        console.log("umap " + i + "/" + nEpochs);
        umap.step();
      }

      const embedding = umap.getEmbedding();

      console.timeEnd("umap");

      cb(null, { items, embedding });
    });
  };

  if (DO_WARMUP) {
    search(undefined, () => {
      console.log("warmed up!");
    });
  }

  let devCached;

  app.get("/search", (req, res) => {
    // TODO: support query params
    const query = undefined;

    if (devCached) {
      res.send(devCached);
      return;
    }

    searchAndPrepare(query, (err, data) => {
      if (err) {
        console.log(err);
        res.status(500);
        return;
      }

      devCached = data;

      res.send(data);
    });
  });

  app.get("/image-thumbnail/:filename", (req, res) => {
    const filename = decodeURIComponent(req.params.filename);

    getOrInsert(
      thumbnailCache,
      filename,
      (cb) => {
        imageThumbnail(filename, { percentage: 10, responseType: "base64" })
          .then((thumbnail) => {
            cb(null, thumbnail);
          })
          .catch((err) => {
            cb(err);
          });
      },
      (err, result) => {
        if (err) {
          console.log(err);
          res.status(500);
          return;
        }

        const img = Buffer.from(result, "base64");
        res.send(img);
      }
    );
  });

  app.get("/image-medium/:filename", (req, res) => {
    const filename = decodeURIComponent(req.params.filename);

    getOrInsert(
      mediumCache,
      filename,
      (cb) => {
        imageThumbnail(filename, { percentage: 50, responseType: "base64" })
          .then((thumbnail) => {
            cb(null, thumbnail);
          })
          .catch((err) => {
            cb(err);
          });
      },
      (err, result) => {
        if (err) {
          console.log(err);
          res.status(500);
          return;
        }

        const img = Buffer.from(result, "base64");
        res.send(img);
      }
    );
  });

  app.get("/image-full/:filename", (req, res) => {
    const filename = decodeURIComponent(req.params.filename);

    fs.readFile(filename, (err, data) => {
      if (err) {
        console.log(err);
        res.status(500);
        return;
      }

      res.send(data);
    });
  });

  app.listen(4000);
});
