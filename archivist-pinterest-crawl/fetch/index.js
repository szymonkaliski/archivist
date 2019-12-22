const Database = require("better-sqlite3");
const async = require("async");
const dateFormat = require("dateformat");
const envPaths = require("env-paths");
const fs = require("fs");
const mkdirp = require("mkdirp");
const path = require("path");
const { chain } = require("lodash");

const crawler = require("./crawler");
const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinterest").data;
mkdirp(DATA_PATH);

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-pins.json");

const makePinId = pin => {
  return chain(pin.url)
    .split("/")
    .takeRight(2)
    .first()
    .value();
};

const processRemovedPins = async removedPins => {
  return new Promise(resolve => {
    async.mapLimit(
      removedPins,
      10,
      (item, callback) => {
        const filePath = item.filename && path.join(DATA_PATH, item.filename);

        if (filePath && fs.existsSync(filePath)) {
          console.log(`unlinking ${filePath}`);
          fs.unlinkSync(filePath);
        }

        callback(null, item.pinid);
      },
      (err, pinids) => resolve(pinids)
    );
  });
};

const run = async () => {
  console.time("run");

  const db = new Database(path.join(DATA_PATH, "data.db"));

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS data (
    board TEXT,
      filename TEXT,
      text TEXT,
      link TEXT,
      pinurl TEXT,
      pinid TEXT PRIMARY KEY,
      crawldate DATETIME,
      createdat DATETIME
    )
    `
  ).run();

  const search = db.prepare(
    "SELECT count(pinid) AS count FROM data WHERE pinid = ?"
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (board,   filename,  text,  link,  pinurl,  pinid,  crawldate,  createdat)
     VALUES                      (:board, :filename, :text, :link, :pinurl, :pinid, :crawldate, :createdat)`
  );

  const remove = db.prepare("DELETE FROM data WHERE pinid = ?");

  const dbPins = db.prepare("SELECT * FROM data").all();

  const crawledPins = await crawler();
  // const crawledPins = require(CRAWLED_DATA_PATH);

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledPins, null, 2),
    "utf-8"
  );
  console.log(`crawled data saved to ${CRAWLED_DATA_PATH}`);

  const newPins = crawledPins.filter(pin => {
    if (!pin) {
      return false;
    }

    const pinid = makePinId(pin);
    return search.get(pinid).count === 0;
  });

  const removedPins = dbPins.filter(
    ({ pinid }) => !crawledPins.find(pin => makePinId(pin) === pinid)
  );

  console.log(
    `all pins: ${crawledPins.length} / new pins: ${newPins.length} / removed pins: ${removedPins.length}`
  );

  const pinidsToRemove = await processRemovedPins(removedPins);

  const removePins = db.transaction(pinids => {
    pinids.forEach(pinid => remove.run(pinid));
  });

  removePins(pinidsToRemove);

  const fetchedPins = await fetcher(newPins);

  const crawldate = dateFormat(new Date(), "isoDateTime");

  const finalPins = fetchedPins.map(pin => ({
    board: pin.board,
    filename: pin.filename,
    text: pin.alt || "",
    link: pin.link,
    pinurl: pin.url,
    pinid: makePinId(pin),
    crawldate,
    createdat: pin.createdAt
      ? dateFormate(new Date(pin.createdAt), "isoDateTime")
      : undefined
  }));

  const insertPins = db.transaction(pins => {
    pins.forEach(pin => insert.run(pin));
  });

  insertPins(finalPins);

  console.log(`inserted pins: ${finalPins.length} (of ${newPins.length})`);

  console.timeEnd("run");
};

module.exports = run;
