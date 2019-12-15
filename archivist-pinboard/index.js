require("dotenv").config();

const Database = require("better-sqlite3");
const Pinboard = require("node-pinboard");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const path = require("path");

const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinboard").data;
mkdirp(DATA_PATH);

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

const run = async () => {
  console.time("run");

  const db = new Database(path.join(DATA_PATH, "data.db"));

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS data (
      href TEXT,
      hash TEXT
      PRIMARY KEY,
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

  const searchForLink = db.prepare(
    "SELECT count(hash) AS count FROM data WHERE hash = ?"
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (href,   hash,  meta,  description,  extended,  tags,  time,  screenshot,  frozen)
     VALUES                      (:href, :hash, :meta, :description, :extended, :tags, :time, :screenshot, :frozen)`
  );

  const crawledLinks = await crawlLinks();
  // const crawledLinks = require(CRAWLED_DATA_PATH);

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledLinks, null, 2),
    "utf-8"
  );

  const newLinks = crawledLinks.filter(link => {
    return searchForLink.get(link.hash).count === 0;
  });

  console.log(`new links: ${newLinks.length}`);

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

run();
