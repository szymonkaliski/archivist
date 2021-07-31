const archivist = require("archivist-cli/lib");

const async = require("async");
const fs = require("fs");
const level = require("level");
const mobilenet = require("@tensorflow-models/mobilenet");
const tf = require("@tensorflow/tfjs-node");
const { UMAP } = require("umap-js");
const { getPaletteFromURL } = require("color-thief-node");

const cache = level("cache");

const identity = (x) => x;

const getOrInsert = (key, prepareCb, cb) => {
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

const getActivation = (file, mobilenet, cb) => {
  try {
    const image = fs.readFileSync(file);
    const tensor = tf.node.decodeImage(image, 3);

    // TODO: refactor!
    mobilenet
      .classify(tensor)
      .then((predictions) => {
        mobilenet
          .infer(tensor, true)
          .data()
          .then((result) => {
            getPaletteFromURL(file)
              .then((palette) => {
                cb(null, {
                  embedding: Array.from(result),
                  predictions,
                  palette,
                });
              })
              .catch((e) => {
                cb(null, {
                  embedding: Array.from(result),
                  predictions,
                  palette: [],
                });
              });
          })
          .catch((e) => {
            cb(e);
          });
      })
      .catch((e) => {
        cb(e);
      });
  } catch (e) {
    cb(e);
  }
};

const getActivationCached = (file, mobilenet, cb) => {
  getOrInsert(
    file,
    (cb) => {
      console.log("cache miss: " + file);
      getActivation(file, mobilenet, (err, result) => cb(err, result));
    },
    (err, result) => {
      cb(err, result);
    }
  );
};

const search = (query, cb) => {
  const limit = undefined;

  mobilenet.load().then((mobilenet) => {
    archivist.search(query, limit).then((found) => {
      async.mapSeries(
        found.value().filter((d) => !!d.thumbImg),
        (item, cb) => {
          getActivationCached(item.thumbImg, mobilenet, (err, d) => {
            if (err) {
              console.log("error for:", item.img, err);
              cb(null);
            } else {
              item.embedding = d.embedding;
              item.predictions = d.predictions;
              item.palette = d.palette;

              cb(null, item);
            }
          });
        },
        cb
      );
    });
  });
};

// TODO: cache this as well?
const processUMAP = (items, cb) => {
  const umap = new UMAP({
    nComponents: 2,
    // nEpochs: 400,
    nNeighbors: 30,
  });

  items = items.filter(identity);

  const rawData = items.map((item) => item.embedding);
  const nEpochs = umap.initializeFit(rawData);

  for (let i = 0; i < nEpochs; i++) {
    console.log("umap " + i + "/" + nEpochs);
    umap.step();
  }

  const embedding = umap.getEmbedding();

  cb(
    null,
    items.map((d, i) => {
      d.embedding = embedding[i];
      return d;
    })
  );
};

console.time("search");
search(undefined, (err, result) => {
  console.timeEnd("search");

  if (err) {
    console.log(err);
    return;
  }

  console.time("umap");
  processUMAP(result, (err, result) => {
    console.timeEnd("umap");

    if (err) {
      console.log(err);
      return;
    }

    console.log("------");
    console.log(JSON.stringify(result, null, 2));
  });
});
