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
      freeze TEXT
    )
    `
  ).run();

  const searchForLink = db.prepare(
    "SELECT count(hash) AS count FROM data WHERE hash = ?"
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (href,   hash,   meta,  description,  extended,  tags,  time,  screenshot,  freeze)
     VALUES                      (:href, :hash,  :meta, :description, :extended, :tags, :time, :screenshot, :freeze)`
  );

  // const crawledLinks = await crawlLinks();
  const crawledLinks = require(CRAWLED_DATA_PATH);

  // {
  //   href: 'https://github.com/samsquire/ideas',
  //   description: 'samsquire/ideas: a record of ideas',
  //   extended: '',
  //   meta: '9131eb46af68b12dc999cc96e58da527',
  //   hash: 'a01097201949e7a0f22b50122bf9d959',
  //   time: '2019-12-08T07:49:09Z',
  //   shared: 'no',
  //   toread: 'no',
  //   tags: 'ideas inspiration reference'
  // }

  // TODO:
  // fetch
  //   freezedry
  //   screenshot
  // store to DB

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

  console.log({ fetchedLinks });

  console.timeEnd("run");
};

run();
