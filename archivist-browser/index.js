#!/usr/bin/env node

const archivist = require("archivist-cli/lib");

const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const level = require("level");
const mkdirp = require("mkdirp");
const mobilenet = require("@tensorflow-models/mobilenet");
const path = require("path");
const tf = require("@tensorflow/tfjs-node");
const yargs = require("yargs");
const { UMAP } = require("umap-js");
const { getPaletteFromURL } = require("color-thief-node");
const { spawn } = require("child_process");

const SHELL = process.env.SHELL || "zsh";

const DATA_PATH = envPaths("archivist-browser").data;
const CACHE_PATH = path.join(DATA_PATH, "cache");
const JSON_OUTPUT = path.join(DATA_PATH, "archivist-library.json");

mkdirp(DATA_PATH);
const CACHE = level(CACHE_PATH);

const identity = (x) => x;

const getOrInsert = (key, prepareCb, cb) => {
  CACHE.get(key, (err, cached) => {
    if (err) {
      prepareCb((err, result) => {
        if (err) {
          return cb(err);
        }

        CACHE.put(key, JSON.stringify(result), () => {
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

const processUMAP = (items, cb) => {
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: 50,
    minDist: 0.05,
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

const prepare = () => {
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

      const finalData = result.map((d) => ({
        imgFull: d.img,
        imgThumb: d.thumbImg,
        position: d.embedding,
        width: d.width,
        height: d.height,
        color: d.palette[0],
        title: d.meta.title,
        source: d.link,
      }));

      fs.writeFileSync(JSON_OUTPUT, JSON.stringify(finalData), "utf-8");
      console.log("saved to: ", JSON_OUTPUT);
    });
  });
};

const args = yargs
  .demandCommand()
  .command("prepare", "prepare archivist browser data")
  .command("browse", "run browser with viewer")
  .demandCommand(1, "you need to provide a command")
  .help().argv;

const [command] = args._;

if (command === "prepare") {
  prepare();
} else if (command === "browse") {
  const browser = spawn("json-images-browser", [JSON_OUTPUT]);

  browser.stdout.on("data", (data) => {
    process.stdout.write(data.toString());
  });

  browser.stderr.on("data", (data) => {
    process.stderr.write(data.toString());
  });
}
