const async = require("async");
const envPaths = require("env-paths");
const mkdirp = require("mkdirp");
const os = require("os");
const path = require("path");
const { chain } = require("lodash");

const CONFIG_PATH = envPaths("archivist").config;
const CONFIG_FILE = path.join(CONFIG_PATH, "config.json");
const DEFAULT_CONFIG = {};

mkdirp(CONFIG_PATH);

const loadConfig = () => {
  let config;

  try {
    config = require(CONFIG_FILE);
  } catch (e) {
    console.log(e);
    process.exit(1);
  }

  return config;
};

const loadCrawler = (name) => {
  return new Promise((resolve, reject) => {
    let crawler;

    try {
      crawler = require(name);
    } catch (e) {
      return reject(e);
    }

    resolve(crawler);
  });
};

const fetch = () => {
  return new Promise((resolve, reject) => {
    async.eachLimit(
      Object.entries(loadConfig()),
      os.cpus().length,
      ([name, config], callback) => {
        loadCrawler(name).then((crawler) =>
          crawler(config)
            .fetch(config)
            .then(callback)
            .catch((e) => callback(`[${name}] fetching error ${e}`))
        );
      },
      (err) => {
        if (err) {
          return reject(err);
        }

        resolve();
      }
    );
  });
};

const search = (query, limit) => {
  return new Promise((resolve, reject) => {
    async.map(
      Object.entries(loadConfig()),
      ([name, config], callback) => {
        // loading the whole crawler is slow - maybe due to puppeteer?
        loadCrawler(`${name}/query`).then((crawlerQuery) => {
          crawlerQuery(config, query, limit)
            .then((result) => callback(null, result))
            .catch((e) => callback(`[${name}] search error ${e}`));
        });
      },
      (err, result) => {
        if (err) {
          return reject(err);
        }

        const sortedResult = chain(result)
          .flatten()
          .sortBy((d) => new Date(d.time));

        resolve(sortedResult);
      }
    );
  });
};

module.exports = { loadConfig, loadCrawler, fetch, search, CONFIG_FILE };
