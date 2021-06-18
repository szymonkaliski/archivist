const archivist = require("archivist-cli/lib");

const async = require("async");
const express = require("express");
const fs = require("fs");
const gifFrames = require("gif-frames");
const level = require("level");
const mkdirp = require("mkdirp");
const mktemp = require("mktemp");
const mobilenet = require("@tensorflow-models/mobilenet");
const tf = require("@tensorflow/tfjs-node");
const tsnejs = require("./tsne.js");

const app = express();
const cache = level("cache");

const TSNE_OPTS = {
  epsilon: 10,
  perplexity: 30,
  dim: 2,
};
const TSNE_ITERS = 10;
const I_W = 100;
const I_H = 100;

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
          .resizeBilinear(decoded, [I_W, I_H])
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
    cache.get(file, (err, cached) => {
      if (err) {
        console.log("cache miss: " + file);
        getActivation(file, (err, result) => {
          if (err) {
            cache.put(file, undefined, () => {
              cb(null);
            });
          } else {
            cache.put(file, JSON.stringify(result), () => {
              cb(null, result);
            });
          }
        });
      } else {
        cb(null, JSON.parse(cached));
      }
    });
  };

  const search = (query, cb) => {
    let n = 0;
    const limit = undefined;

    archivist.search(query, limit).then((found) => {
      found = found.value();
      async.mapSeries(
        found,
        (item, cb) => {
          console.log("search process " + n++ + "/" + found.length);

          getActivationCached(item.img, (err, preds) => {
            if (err) {
              console.log("ERROR");
              console.log(item.img);
              console.log(err);
              console.log("-----");
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

  console.time("search");
  search(undefined, (items) => {
    console.timeEnd("search");

    console.time("t-sne");

    const tsne = new tsnejs.tSNE(TSNE_OPTS);

    const rawData = items.map((item) => item.preds);

    tsne.initDataRaw(rawData);

    for (let i = 0; i < TSNE_ITERS; i++) {
      console.log("t-sne " + i + "/" + TSNE_ITERS);
      tsne.step();
    }

    let result = tsne.getSolution();
    console.timeEnd("t-sne");

    // console.log({ result });
  });

  // // TODO: support query params
  // app.get("/search", (req, res) => {
  //   const query = undefined;

  //   console.time("search");
  //   search(query, (items) => {
  //     console.timeEnd("search");

  //     console.time("t-sne");

  //     const tsne = new tsnejs.tSNE(TSNE_OPTS);
  //     const rawData = items.map((item) => item.preds.slice(0));

  //     tsne.initDataRaw(rawData);

  //     for (let i = 0; i < TSNE_ITERS; i++) {
  //       console.log("t-sne " + i + "/" + TSNE_ITERS);
  //       tsne.step();
  //     }

  //     let result = tsne.getSolution();
  //     console.timeEnd("t-sne");

  //     console.log({ result });
  //   });
  // });

  app.listen(4000);
});
