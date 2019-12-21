require("dotenv").config();

const async = require("async");
const Database = require("better-sqlite3");
const Pinboard = require("node-pinboard");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const path = require("path");

const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

mkdirp(ASSETS_PATH);
mkdirp(FROZEN_PATH);

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-links.json");

// TODO: store config somewhere else than in .env
const pinboard = new Pinboard(process.env.API_KEY);

const crawlLinks = async () =>
  new Promise((resolve, reject) => {
    pinboard.all((err, links) => {
      if (err) {
        reject(err);
      } else {
        resolve(links);
      }
    });
  });

const processRemovedLinks = async removedLinks => {
  return new Promise(resolve => {
    async.mapLimit(
      removedLinks,
      10,
      (item, callback) => {
        const screenshotPath =
          item.screenshot && path.join(ASSETS_PATH, item.screenshot);

        const frozenPath = item.frozen && path.join(FROZEN_PATH, item.frozen);

        if (screenshotPath && fs.existsSync(screenshotPath)) {
          console.log(`unlinking ${screenshotPath}`);
          fs.unlinkSync(screenshotPath);
        }

        if (frozenPath && fs.existsSync(frozenPath)) {
          console.log(`unlinking ${frozenPath}`);
          fs.unlinkSync(frozenPath);
        }

        callback(null, item.hash);
      },
      (err, hashes) => resolve(hashes)
    );
  });
};

const run = async () => {
  console.time("run");

  const db = new Database(path.join(DATA_PATH, "data.db"));

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS data (
      href TEXT,
      hash TEXT PRIMARY KEY,
      meta TEXT,
      description TEXT,
      extended TEXT,
      tags TEXT,
      time DATETIME,
      screenshot TEXT,
      frozen TEXT
    )
    `
  ).run();

  const search = db.prepare(
    "SELECT count(hash) AS count FROM data WHERE hash = ?"
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (href,   hash,  meta,  description,  extended,  tags,  time,  screenshot,  frozen)
     VALUES                      (:href, :hash, :meta, :description, :extended, :tags, :time, :screenshot, :frozen)`
  );

  const remove = db.prepare("DELETE FROM data WHERE hash = ?");

  const dbLinks = db.prepare("SELECT * FROM data").all();

  const crawledLinks = await crawlLinks();
  // const crawledLinks = require(CRAWLED_DATA_PATH);

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledLinks, null, 2),
    "utf-8"
  );
  console.log(`crawled data saved to ${CRAWLED_DATA_PATH}`);

  const newLinks = crawledLinks.filter(
    link => search.get(link.hash).count === 0
  );

  const removedLinks = dbLinks.filter(
    ({ hash }) => !crawledLinks.find(l => l.hash === hash)
  );

  console.log(
    `all links: ${crawledLinks.length} / new links: ${newLinks.length} / removed links: ${removedLinks.length}`
  );

  const hashesToRemove = await processRemovedLinks(removedLinks);

  const removeLinks = db.transaction(hashes => {
    hashes.forEach(hash => remove.run(hash));
  });

  removeLinks(hashesToRemove);

  const fetchedLinks = await fetcher(newLinks);

  const finalLinks = fetchedLinks
    .filter(link => link && link.paths)
    .map(link => ({
      href: link.href,
      hash: link.hash,
      meta: link.meta,
      description: link.description,
      extended: link.extended,
      tags: link.tags,
      time: link.time,
      screenshot: link.paths.screenshot,
      frozen: link.paths.frozen
    }));

  const insertLinks = db.transaction(links => {
    links.forEach(link => insert.run(link));
  });

  insertLinks(finalLinks);

  console.log(`insterted links: ${finalLinks.length} (of ${newLinks.length})`);

  console.timeEnd("run");
};

module.exports = run;
