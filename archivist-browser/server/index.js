const archivist = require("archivist-cli/lib");

const async = require("async");
const express = require("express");
const fs = require("fs");
const mobilenet = require("@tensorflow-models/mobilenet");
const tf = require("@tensorflow/tfjs-node");
const level = require("level");

const app = express();
const cache = level("cache");

mobilenet.load().then((mobilenet) => {
  const getActivation = (file, cb) => {
    try {
      const image = fs.readFileSync(file);
      const tensor = tf.node.decodeImage(image, 3);
      const preds = mobilenet.infer(tensor);

      preds.data().then((result) => {
        tensor.dispose();
        preds.dispose();

        cb(null, result);
      });
    } catch (e) {
      cb(e);
    }
  };

  const getActivationCached = (file, cb) => {
    cache.get(file, (err, cached) => {
      if (err) {
        console.log("cache miss: " + file);
        getActivation(file, (err, result) => {
          if (err) {
            cb(err);
          } else {
            cache.put(file, JSON.stringify(result), () => {
              cb(null, file);
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

    archivist.search(query).then((found) => {
      found = found.value();
      async.mapSeries(
        found,
        (item, cb) => {
          console.log(n++ + "/" + found.length);

          getActivationCached(item.img, (err, preds) => {
            if (err) {
              console.log("ERROR");
              console.log(item.img);
              console.log(err);
              console.log("-----");
              cb(null, null);
            } else {
              item.preds = preds;
              cb(null, item);
            }
          });
        },
        (err, results) => {
          results = results.filter((x) => x);
          if (cb) {
            cb(results);
          }
        }
      );
    });
  };

  console.time("mobilenet");
  search(undefined, () => {
    console.timeEnd("mobilenet");
  });

  // TODO: query params
  app.get("/search", (req, res) => {
    const query = undefined;
    search(query, (items) => res.send(items));
  });

  app.listen(4000);
});
