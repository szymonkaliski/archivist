const fs = require("fs");
const Database = require("better-sqlite3");
const envPaths = require("env-paths");
const mkdirp = require("mkdirp");
const path = require("path");
const { chain } = require("lodash");

const crawler = require("./crawler");
const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinterest").data;
mkdirp(DATA_PATH);

const makePinId = pin => {
  return chain(pin.url)
    .split("/")
    .takeRight(2)
    .first()
    .value();
};

const run = async () => {
  console.time("run");

  const db = new Database(path.join(DATA_PATH, "data.db"));

  db.prepare(
    "CREATE TABLE IF NOT EXISTS data (board TEXT, filename TEXT, text TEXT, link TEXT, pinurl TEXT, pinid TEXT PRIMARY KEY)"
  ).run();

  const searchForPin = db.prepare(
    "SELECT count(pinid) AS count FROM data WHERE pinid = ?"
  );

  const crawledDataPath = path.join(DATA_PATH, "crawled-pins.json");

  const crawledPins = await crawler();
  // const crawledPins = require(crawledDataPath);

  fs.writeFileSync(
    crawledDataPath,
    JSON.stringify(crawledPins, null, 2),
    "utf-8"
  );
  console.log(`crawled data saved to ${crawledDataPath}`);

  const newPins = crawledPins.filter(pin => {
    if (!pin) {
      return false;
    }

    const pinid = makePinId(pin);
    return searchForPin.get(pinid).count === 0;
  });

  console.log(`new pins: ${newPins.length}`);

  const fetchedPins = await fetcher(newPins);

  console.log(`fetched pins: ${fetchedPins.length}`);

  const finalPins = fetchedPins.map(pin => ({
    board: pin.board,
    filename: pin.filename,
    text: pin.alt || "",
    link: pin.link,
    pinurl: pin.url,
    pinid: makePinId(pin)
  }));

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (board,   filename,  text,  link,  pinurl,  pinid)
     VALUES                      (:board, :filename, :text, :link, :pinurl, :pinid)`
  );

  const insertPins = db.transaction(pins => {
    pins.forEach(pin => insert.run(pin));
  });

  const result = insertPins(finalPins);

  console.timeEnd("run");
};

run();
