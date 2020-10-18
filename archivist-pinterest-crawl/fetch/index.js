const Database = require("better-sqlite3");
const async = require("async");
const dateFormat = require("dateformat");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const path = require("path");
const { chain } = require("lodash");

const { crawlBoards, crawlPinMetadata } = require("./crawler");
const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinterest").data;
mkdirp(DATA_PATH);

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-pins.json");

const makePinId = (pin) => {
  return chain(pin.url).split("/").takeRight(2).first().value();
};

const processRemovedPins = async (removedPins) => {
  return new Promise((resolve) => {
    async.mapLimit(
      removedPins,
      10,
      (item, callback) => {
        const filePath = item.filename && path.join(DATA_PATH, item.filename);

        if (filePath && fs.existsSync(filePath)) {
          console.log("[archivist-pinterest-crawl]", `unlinking ${filePath}`);
          fs.unlinkSync(filePath);
        }

        callback(null, item.pinid);
      },
      (err, pinids) => resolve(pinids)
    );
  });
};

const SETUP_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS data (
      board TEXT,
      filename TEXT,
      title TEXT,
      text TEXT,
      link TEXT,
      pinurl TEXT,
      width INTEGER,
      height INTEGER,
      pinid TEXT PRIMARY KEY,
      crawldate DATETIME,
      createdat DATETIME
    )
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS ft_search
    USING FTS5(board, title, text);
  `,
  `
    CREATE TRIGGER IF NOT EXISTS ft_search_update AFTER INSERT ON data BEGIN
      INSERT INTO ft_search(board, title, text)
      VALUES (new.board, new.title, new.text);
    END
  `,
];

const run = async (options) => {
  const db = new Database(path.join(DATA_PATH, "data.db"));

  SETUP_STATEMENTS.forEach((stmt) => db.prepare(stmt).run());

  const search = db.prepare(
    "SELECT count(pinid) AS count FROM data WHERE pinid = ?"
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (board,   filename,  title,  text,  link,  pinurl,  pinid,  crawldate,  createdat,  width,  height)
     VALUES                      (:board, :filename, :title, :text, :link, :pinurl, :pinid, :crawldate, :createdat, :width, :height)`
  );

  const remove = db.prepare("DELETE FROM data WHERE pinid = ?");

  const dbPins = db.prepare("SELECT * FROM data").all();

  const crawledPins = await crawlBoards(options);
  // const crawledPins = require(CRAWLED_DATA_PATH);

  if (crawledPins.length === 0) {
    console.log("[archivist-pinterest-crawl]", "0 crawled pins, exiting");
    return;
  }

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledPins, null, 2),
    "utf-8"
  );
  // console.log("[archivist-pinterest-crawl]", `crawled data saved to ${CRAWLED_DATA_PATH}`);

  const newPins = crawledPins.filter((pin) => {
    if (!pin) {
      return false;
    }

    const pinid = makePinId(pin);
    return search.get(pinid).count === 0;
  });

  const removedPins = dbPins.filter(
    ({ pinid }) => !crawledPins.find((pin) => makePinId(pin) === pinid)
  );

  console.log(
    "[archivist-pinterest-crawl]",
    `all pins: ${crawledPins.length} / new pins: ${newPins.length} / removed pins: ${removedPins.length}`
  );

  const pinidsToRemove = await processRemovedPins(removedPins);

  const removePins = db.transaction((pinids) => {
    pinids.forEach((pinid) => remove.run(pinid));
  });

  removePins(pinidsToRemove);

  const newPinsWithMetadata = await crawlPinMetadata(options, newPins);

  const fetchedPins = await fetcher(newPinsWithMetadata);

  const crawldate = dateFormat(new Date(), "isoDateTime");

  const finalPins = fetchedPins.map((pin) => ({
    board: pin.board,
    filename: pin.filename,
    title: pin.title,
    text: pin.alt,
    link: pin.link,
    pinurl: pin.url,
    pinid: makePinId(pin),
    crawldate,
    createdat: pin.createdAt
      ? dateFormat(new Date(pin.createdAt), "isoDateTime")
      : undefined,
    width: pin.width,
    height: pin.height,
  }));

  const insertPins = db.transaction((pins) => {
    pins.forEach((pin) => insert.run(pin));
  });

  insertPins(finalPins);

  console.log(
    "[archivist-pinterest-crawl]",
    `inserted pins: ${finalPins.length} (of ${newPins.length})`
  );
};

module.exports = run;
