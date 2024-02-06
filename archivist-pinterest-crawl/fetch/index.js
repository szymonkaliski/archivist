const Database = require("better-sqlite3");
const async = require("async");
const dateFormat = require("dateformat");
const envPaths = require("env-paths");
const fs = require("fs");
const gifFrames = require("gif-frames");
const mkdirp = require("mkdirp");
const mktemp = require("mktemp");
const path = require("path");
const sharp = require("sharp");
const { chain } = require("lodash");

const { crawlBoards, crawlPinMetadata } = require("./crawler");
const fetcher = require("./fetcher");

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");
const TMP_PATH = "/tmp/archivist-pinterest-crawl";

mkdirp(DATA_PATH);
mkdirp(THUMBS_PATH);
mkdirp(TMP_PATH);
mkdirp(ASSETS_PATH);

const FORCE_RECREATE_THUMBS = false;
const THUMB_SIZE = 400;

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-pins.json");

const identity = (x) => x;

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
    CREATE INDEX IF NOT EXISTS pinid_idx ON data(pinid)
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS ft_search
    USING FTS5(pinid, board, link, title, text);
  `,
  `
    CREATE TRIGGER IF NOT EXISTS ft_search_update AFTER INSERT ON data BEGIN
      INSERT INTO ft_search(pinid, board, link, title, text)
      VALUES (new.pinid, new.board, new.link, new.title, new.text);
    END
  `,
];

// seems to be broken
const USE_GIF_FRAMES = false;

const prepareFileForThumbnailing = async (file) => {
  if (file.endsWith("gif")) {
    return new Promise((resolve, reject) => {
      const output = mktemp.createFileSync(`${TMP_PATH}/XXXXXX.png`);

      gifFrames(
        {
          url: file,
          frames: 0,
          culmative: true,
        },
        (err, frameData) => {
          if (err) {
            return reject(err);
          }

          frameData[0]
            .getImage()
            .pipe(fs.createWriteStream(output))
            .on("finish", () => resolve(output));
        }
      );
    });
  } else {
    return Promise.resolve(file);
  }
};

// TODO: remove thumbnails if original file doesn't exist anymore
const createThumbnails = async (db) => {
  const dbFiles = db.prepare("SELECT filename FROM data").all();

  return new Promise((resolve) => {
    async.eachLimit(
      dbFiles,
      10,
      ({ filename }, next) => {
        const inputPath = path.join(ASSETS_PATH, filename);

        if (!fs.existsSync(inputPath)) {
          next();
          return;
        }

        const outputName = path.parse(filename).name + ".png";
        const outputPath = path.join(THUMBS_PATH, outputName);

        const alreadyExists = fs.existsSync(outputPath);
        const shouldMakeThumbnail = FORCE_RECREATE_THUMBS || !alreadyExists;

        function createThumbnail(inputPath) {
          console.log(
            "[archivist-pinterest-crawl]",
            `making thumbnail for ${inputPath} -> ${outputPath}`
          );

          try {
            sharp(inputPath)
              .resize(THUMB_SIZE)
              .png()
              .toFile(outputPath, () => {
                next();
              });
          } catch (e) {
            console.log(
              "[archivist-pinterest-crawl]",
              `error making thumbnail for: ${inputPath}`,
              e
            );
            next();
          }
        }

        if (shouldMakeThumbnail) {
          if (USE_GIF_FRAMES) {
            prepareFileForThumbnailing(inputPath)
              .then((inputPath) => {
                createThumbnail(inputPath);
              })
              .catch((e) => {
                console.log("[archivist-pinterest-crawl]", `error: ${e}`);
                next();
              });
          } else {
            createThumbnail(inputPath);
          }
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

  // re-comment to crawl fresh or use stored data
  const USE_PERSISTED_CRAWLED_DATA = false;
  const crawledPins = USE_PERSISTED_CRAWLED_DATA
    ? require(CRAWLED_DATA_PATH)
    : await crawlBoards(options);

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

  const finalPins = fetchedPins.filter(identity).map((pin) => ({
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

  createThumbnails(db);

  console.log(
    "[archivist-pinterest-crawl]",
    `inserted pins: ${finalPins.length} (of ${newPins.length})`
  );
};

module.exports = run;
