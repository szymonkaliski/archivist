import Database from "better-sqlite3";
import async from "async";
import dateFormat from "dateformat";
import envPaths from "env-paths";
import fs from "fs";
import gifFrames from "gif-frames";
import mktemp from "mktemp";
import path from "path";
import sharp from "sharp";
import { chain } from "lodash";

import { createLogger } from "archivist-logger";
import { crawlBoards, crawlPinMetadata } from "./crawler";
import fetcher from "./fetcher";
import type { PinterestOptions } from "../index";

const log = createLogger("pinterest");

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");
const TMP_PATH = "/tmp/archivist-pinterest-crawl";

fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(THUMBS_PATH, { recursive: true });
fs.mkdirSync(TMP_PATH, { recursive: true });
fs.mkdirSync(ASSETS_PATH, { recursive: true });

const THUMB_SIZE = 400;

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-pins.json");

export interface CrawledPin {
  url: string;
  src: string;
  alt: string;
  srcset: string;
  biggestSrc: string;
  board: string;
}

export interface CrawledPinWithMetadata extends CrawledPin {
  title?: string;
  text?: string;
  link?: string;
  createdAt?: string;
}

export interface FetchedPin extends CrawledPinWithMetadata {
  filename: string;
  width: number;
  height: number;
}

interface PinDbRow {
  board: string;
  filename: string;
  title?: string;
  text?: string;
  link?: string;
  pinurl: string;
  pinid: string;
  crawldate: string;
  createdat?: string;
  width: number;
  height: number;
}

const makePinId = (pin: CrawledPin): string => {
  return chain(pin.url).split("/").takeRight(2).first().value() as string;
};

const processRemovedPins = async (
  removedPins: PinDbRow[],
  concurrency = 10,
): Promise<string[]> => {
  return new Promise((resolve) => {
    async.mapLimit(
      removedPins,
      concurrency,
      (item: PinDbRow, callback: (err: null, pinid: string) => void) => {
        const filePath = item.filename && path.join(DATA_PATH, item.filename);

        if (filePath && fs.existsSync(filePath)) {
          log.info(`unlinking ${filePath}`);
          fs.unlinkSync(filePath);
        }

        callback(null, item.pinid);
      },
      (_err: any, pinids: any) => resolve(pinids as string[]),
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

const prepareFileForThumbnailing = async (file: string): Promise<string> => {
  if (file.endsWith("gif")) {
    return new Promise((resolve, reject) => {
      const output = mktemp.createFileSync(`${TMP_PATH}/XXXXXX.png`);

      gifFrames(
        {
          url: file,
          frames: 0,
          culmative: true,
        },
        (err: any, frameData: any) => {
          if (err) {
            return reject(err);
          }

          frameData[0]
            .getImage()
            .pipe(fs.createWriteStream(output))
            .on("finish", () => resolve(output));
        },
      );
    });
  } else {
    return Promise.resolve(file);
  }
};

const createThumbnails = async (db: Database.Database, concurrency = 10) => {
  const dbFiles = db.prepare("SELECT filename FROM data").all() as {
    filename: string;
  }[];

  return new Promise<void>((resolve) => {
    async.eachLimit(
      dbFiles,
      concurrency,
      ({ filename }: { filename: string }, next: () => void) => {
        const inputPath = path.join(ASSETS_PATH, filename);

        if (!fs.existsSync(inputPath)) {
          next();
          return;
        }

        const outputName = path.parse(filename).name + ".png";
        const outputPath = path.join(THUMBS_PATH, outputName);

        const alreadyExists = fs.existsSync(outputPath);

        function createThumbnail(inputPath: string) {
          log.info(`making thumbnail for ${inputPath} -> ${outputPath}`);

          try {
            sharp(inputPath)
              .resize(THUMB_SIZE)
              .png()
              .toFile(outputPath, () => {
                next();
              });
          } catch (e) {
            log.error(
              "error making thumbnail for: %s %s",
              inputPath,
              String(e),
            );
            next();
          }
        }

        if (!alreadyExists) {
          if (USE_GIF_FRAMES) {
            prepareFileForThumbnailing(inputPath)
              .then((inputPath) => {
                createThumbnail(inputPath);
              })
              .catch((e) => {
                log.error(`error: ${e}`);
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
      },
    );
  });
};

const run = async (options: PinterestOptions) => {
  const db = new Database(path.join(DATA_PATH, "data.db"));

  SETUP_STATEMENTS.forEach((stmt) => db.prepare(stmt).run());

  const search = db.prepare(
    "SELECT count(pinid) AS count FROM data WHERE pinid = ?",
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (board,   filename,  title,  text,  link,  pinurl,  pinid,  crawldate,  createdat,  width,  height)
     VALUES                      (:board, :filename, :title, :text, :link, :pinurl, :pinid, :crawldate, :createdat, :width, :height)`,
  );

  const remove = db.prepare("DELETE FROM data WHERE pinid = ?");

  const dbPins = db.prepare("SELECT * FROM data").all() as PinDbRow[];

  const USE_PERSISTED_CRAWLED_DATA = false;
  const crawledPins: CrawledPin[] = USE_PERSISTED_CRAWLED_DATA
    ? require(CRAWLED_DATA_PATH)
    : await crawlBoards(options);

  if (crawledPins.length === 0) {
    log.warn("0 crawled pins, exiting");
    return;
  }

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledPins, null, 2),
    "utf-8",
  );

  const newPins = crawledPins.filter((pin) => {
    if (!pin) {
      return false;
    }

    const pinid = makePinId(pin);
    return (search.get(pinid) as { count: number }).count === 0;
  });

  const removedPins = dbPins.filter(
    ({ pinid }) => !crawledPins.find((pin) => makePinId(pin) === pinid),
  );

  log.info(
    `all pins: ${crawledPins.length} / new pins: ${newPins.length} / removed pins: ${removedPins.length}`,
  );

  if (!options.appendOnly) {
    const pinidsToRemove = await processRemovedPins(
      removedPins,
      options.concurrency,
    );

    const removePins = db.transaction((pinids: string[]) => {
      pinids.forEach((pinid) => remove.run(pinid));
    });

    removePins(pinidsToRemove);
  } else {
    log.info("appendOnly mode enabled, skipping removal of pins");
  }

  const newPinsWithMetadata = await crawlPinMetadata(options, newPins);

  const fetchedPins = await fetcher(newPinsWithMetadata, options.concurrency);

  const crawldate = dateFormat(new Date(), "isoDateTime");

  const finalPins = (fetchedPins as (FetchedPin | null)[])
    .filter((pin): pin is FetchedPin => pin != null)
    .map((pin) => ({
      board: pin.board,
      filename: pin.filename,
      title: pin.title,
      text: pin.text || pin.alt,
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

  const insertPins = db.transaction((pins: any[]) => {
    pins.forEach((pin) => insert.run(pin));
  });

  insertPins(finalPins);

  await createThumbnails(db, options.concurrency);

  log.info(`inserted pins: ${finalPins.length} (of ${newPins.length})`);
};

export default run;
