const Database = require("better-sqlite3");
const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const path = require("path");
const sharp = require("sharp");
const { default: Pinboard } = require("node-pinboard");
const { isString } = require("lodash");

const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

mkdirp(ASSETS_PATH);
mkdirp(FROZEN_PATH);
mkdirp(THUMBS_PATH);

const FORCE_RECREATE_THUMBS = false;
const THUMB_SIZE = 400;

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-links.json");

const processRemovedLinks = async (removedLinks) => {
  return new Promise((resolve) => {
    async.mapLimit(
      removedLinks,
      10,
      (item, callback) => {
        const screenshotPath =
          item.screenshot && path.join(ASSETS_PATH, item.screenshot);

        const frozenPath = item.frozen && path.join(FROZEN_PATH, item.frozen);

        if (screenshotPath && fs.existsSync(screenshotPath)) {
          console.log("[archivist-pinboard]", `unlinking ${screenshotPath}`);
          fs.unlinkSync(screenshotPath);
        }

        if (frozenPath && fs.existsSync(frozenPath)) {
          console.log("[archivist-pinboard]", `unlinking ${frozenPath}`);
          fs.unlinkSync(frozenPath);
        }

        callback(null, item.hash);
      },
      (err, hashes) => resolve(hashes)
    );
  });
};

// TODO: remove thumbnails if original file doesn't exist anymore
const createThumbnails = async (db) => {
  const dbScreenshots = db.prepare("SELECT screenshot FROM data").all();

  return new Promise((resolve) => {
    async.eachLimit(
      dbScreenshots,
      10,
      ({ screenshot: filename }, next) => {
        const inputPath = path.join(ASSETS_PATH, filename);

        const outputName = path.parse(filename).name + ".jpg";
        const outputPath = path.join(THUMBS_PATH, outputName);

        const alreadyExists = fs.existsSync(outputPath);
        const shouldMakeThumbnail = FORCE_RECREATE_THUMBS || !alreadyExists;

        if (shouldMakeThumbnail) {
          console.log(
            "[archivist-pinboard]",
            `making thumbnail for ${inputPath} -> ${outputPath}`
          );

          sharp(inputPath)
            .resize(THUMB_SIZE)
            .jpeg()
            .toFile(outputPath, () => {
              next();
            });
        } else {
          next();
        }
      },
      () => {
        resolve();
      }
    );
  });
};

const SETUP_STATEMENTS = [
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
      fulltext TEXT
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS hash_idx ON data(hash)
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS ft_search
    USING FTS5(hash, href, meta, description, extended, tags, fulltext);
  `,
  `
    CREATE TRIGGER IF NOT EXISTS ft_search_update AFTER INSERT ON data BEGIN
      INSERT INTO ft_search(hash, href, meta, description, extended, tags, fulltext)
      VALUES (new.hash, new.href, new.meta, new.description, new.extended, new.tags, new.fulltext);
    END
  `,
];

const run = async (options) => {
  if (!options.apiKey) {
    throw new Error("apiKey not provided");
  }

  const pinboard = new Pinboard(options.apiKey);

  const crawlLinks = async () => {
    return await pinboard.all();
  };

  const db = new Database(path.join(DATA_PATH, "data.db"));

  SETUP_STATEMENTS.forEach((stmt) => db.prepare(stmt).run());

  const search = db.prepare(
    "SELECT count(hash) AS count FROM data WHERE hash = ?"
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (href,   hash,  meta,  description,  extended,  tags,  time,  screenshot,  frozen,  fulltext)
     VALUES                      (:href, :hash, :meta, :description, :extended, :tags, :time, :screenshot, :frozen, :fulltext)`
  );

  const remove = db.prepare("DELETE FROM data WHERE hash = ?");

  const dbLinks = db.prepare("SELECT * FROM data").all();

  let crawledLinks = await crawlLinks();

  // not sure what's going on in here really
  if (isString(crawledLinks)) {
    try {
      crawledLinks = JSON.parse(crawledLinks.slice(1));
    } catch (e) {}
  }

  if (isString(crawledLinks)) {
    console.log("[archivist-pinboard] unrecoverable issue with crawled links");
    return;
  }

  // const crawledLinks = require(CRAWLED_DATA_PATH);

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledLinks, null, 2),
    "utf-8"
  );
  // console.log("[archivist-pinboard]", `crawled data saved to ${CRAWLED_DATA_PATH}`);

  const newLinks = crawledLinks.filter(
    (link) => search.get(link.hash).count === 0
  );

  const removedLinks = dbLinks.filter(
    ({ hash }) => !crawledLinks.find((l) => l.hash === hash)
  );

  console.log(
    "[archivist-pinboard]",
    `all links: ${crawledLinks.length} / new links: ${newLinks.length} / removed links: ${removedLinks.length}`
  );

  const hashesToRemove = await processRemovedLinks(removedLinks);

  const removeLinks = db.transaction((hashes) => {
    hashes.forEach((hash) => remove.run(hash));
  });

  removeLinks(hashesToRemove);

  const fetchedLinks = await fetcher(newLinks);

  const finalLinks = fetchedLinks
    .filter((link) => link && link.paths)
    .map((link) => ({
      href: link.href,
      hash: link.hash,
      meta: link.meta,
      description: link.description,
      extended: link.extended,
      tags: link.tags,
      time: link.time,
      screenshot: link.paths.screenshot,
      frozen: link.paths.frozen,
      fulltext: link.fulltext,
    }));

  const insertLinks = db.transaction((links) => {
    links.forEach((link) => insert.run(link));
  });

  insertLinks(finalLinks);

  createThumbnails(db);

  console.log(
    "[archivist-pinboard]",
    `insterted links: ${finalLinks.length} (of ${newLinks.length} new links)`
  );
};

module.exports = run;
