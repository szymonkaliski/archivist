const Database = require("better-sqlite3");
const envPaths = require("env-paths");
const mkdirp = require("mkdirp");
const path = require("path");
const { chain } = require("lodash");

const crawler = require("./crawler");
const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinterest").data;
mkdirp(DATA_PATH);

const run = async () => {
  const db = new Database(path.join(DATA_PATH, "data.db"));

  db.prepare(
    "CREATE TABLE IF NOT EXISTS data (board TEXT, filename TEXT, text TEXT, link TEXT, pinurl TEXT, pinid TEXT PRIMARY KEY)"
  ).run();

  const crawledPins = await crawler();

  console.log(crawledPins)

  const fetchedPins = await fetcher(crawledPins);

  const finalPins = fetchedPins.map(pin => ({
    board: pin.board,
    filename: pin.filename,
    text: pin.imgAlt || "",
    link: pin.link,
    pinurl: pin.pinUrl,
    pinid: chain(pin.pinUrl)
      .split("/")
      .takeRight(2)
      .first()
      .value()
  }));

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (board,   filename,  text,  link,  pinurl,  pinid)
     VALUES                      (:board, :filename, :text, :link, :pinurl, :pinid)`
  );

  const insertPins = db.transaction(pins => {
    pins.forEach(pin => insert.run(pin));
  });

  insertPins(finalPins);
};

run();
