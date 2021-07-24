const archivist = require("archivist-cli/lib");

const async = require("async");
const fs = require("fs");
const level = require("level");
const mobilenet = require("@tensorflow-models/mobilenet");
const tf = require("@tensorflow/tfjs-node");
const { UMAP } = require("umap-js");

const cache = level("cache");

const IMG_W = 224;
const IMG_H = 224;

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
          getActivationCached(item.thumbImg, mobilenet, (err, preds) => {
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
  });
};

// TODO: cache this as well
const processUMAP = (items, cb) => {
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

  cb(
    null,
    items.map((d, i) => {
      d.embedding = embedding[i];
      return d;
    })
  );
};

console.time("search");
search(undefined, (result) => {
  console.timeEnd("search");

  console.time("umap");
  processUMAP(result, (err, result) => {
    console.timeEnd("umap");

    result = result.map((d) => {
      delete d.preds;
      return d;
    });

    console.log(result);
  });
});

