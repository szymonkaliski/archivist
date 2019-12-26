#!/usr/bin/env node

const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const os = require("os");
const path = require("path");
const yargs = require("yargs");
const { chain } = require("lodash");
const { spawn } = require("child_process");

const CONFIG_PATH = envPaths("archivist").config;
const CONFIG_FILE = path.join(CONFIG_PATH, "config.json");
const DEFAULT_CONFIG = {};

mkdirp(CONFIG_PATH);

const args = yargs
  .command("config", "open configuration file")
  .command("fetch", "fetch all configured crawlers")
  .command("query", "query crawlers", yargs => {
    yargs.option("json", { description: "output as JSON" });
  })
  .demandCommand(1, "you need to provide a command")
  .help().argv;

const [TYPE] = args._;

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

const loadCrawler = name =>
  new Promise((resolve, reject) => {
    let crawler;

    try {
      crawler = require(name);
    } catch (e) {
      return reject(e);
    }

    resolve(crawler);
  });

if (TYPE === "config") {
  const editor = process.env.EDITOR || "vim";

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      CONFIG_FILE,
      "utf-8"
    );
  }

  spawn(editor, [CONFIG_FILE], { stdio: "inherit" });
} else if (TYPE === "fetch") {
  async.eachLimit(
    Object.entries(loadConfig()),
    os.cpus().length,
    ([name, config], callback) => {
      loadCrawler(name).then(crawler =>
        crawler(config)
          .fetch(config)
          .then(callback)
          .catch(e => {
            callback(`[${name}] fetching error ${e}`);
          })
      );
    },
    err => {
      if (err) {
        console.log(err);
        process.exit(1);
      }
    }
  );
} else if (TYPE === "query") {
  async.mapLimit(
    Object.entries(loadConfig()),
    os.cpus().length,
    ([name, config], callback) => {
      loadCrawler(name).then(crawler => {
        crawler(config)
          .query(args._[1])
          .then(result => callback(null, result))
          .catch(e => callback(`[${name}] query error ${e}`));
      });
    },
    (err, result) => {
      if (err) {
        console.log(err);
        process.exit(1);
      }

      const sortedResult = chain(result)
        .flatten()
        .sortBy(d => new Date(d.time));

      if (args.json === true) {
        // JSON output
        console.log(JSON.stringify(sortedResult.value(), null, 2));
      } else {
        // NDJSON output
        sortedResult.forEach(d => console.log(JSON.stringify(d))).value();
      }
    }
  );
}
