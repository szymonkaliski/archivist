import Database from "better-sqlite3";
import async from "async";
import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { default as Pinboard } from "node-pinboard";
import { isString } from "lodash";

import { createLogger } from "archivist-logger";
import fetcher, { type PinboardLink, type SavedPaths } from "./fetcher";
import type { PinboardOptions } from "../index";

const log = createLogger("pinboard");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

fs.mkdirSync(ASSETS_PATH, { recursive: true });
fs.mkdirSync(FROZEN_PATH, { recursive: true });
fs.mkdirSync(THUMBS_PATH, { recursive: true });

const THUMB_SIZE = 400;

const CRAWLED_DATA_PATH = path.join(DATA_PATH, "crawled-links.json");

interface PinboardDbRow extends PinboardLink {
  screenshot: string;
  frozen: string;
  fulltext: string;
}

interface FetchedLink extends PinboardLink {
  fulltext: string;
  paths: SavedPaths;
}

const processRemovedLinks = async (
  removedLinks: PinboardDbRow[],
  concurrency = 10,
): Promise<string[]> => {
  return new Promise((resolve) => {
    async.mapLimit(
      removedLinks,
      concurrency,
      (item: PinboardDbRow, callback: (err: null, hash: string) => void) => {
        const screenshotPath =
          item.screenshot && path.join(ASSETS_PATH, item.screenshot);

        const frozenPath = item.frozen && path.join(FROZEN_PATH, item.frozen);

        if (screenshotPath && fs.existsSync(screenshotPath)) {
          log.info(`unlinking ${screenshotPath}`);
          fs.unlinkSync(screenshotPath);
        }

        if (frozenPath && fs.existsSync(frozenPath)) {
          log.info(`unlinking ${frozenPath}`);
          fs.unlinkSync(frozenPath);
        }

        callback(null, item.hash);
      },
      (_err: any, hashes: any) => resolve(hashes as string[]),
    );
  });
};

const createThumbnails = async (db: Database.Database, concurrency = 10) => {
  const dbScreenshots = db.prepare("SELECT screenshot FROM data").all() as {
    screenshot: string;
  }[];

  return new Promise<void>((resolve) => {
    async.eachLimit(
      dbScreenshots,
      concurrency,
      ({ screenshot: filename }: { screenshot: string }, next: () => void) => {
        if (!filename) return next();
        const inputPath = path.join(ASSETS_PATH, filename);

        const outputName = path.parse(filename).name + ".png";
        const outputPath = path.join(THUMBS_PATH, outputName);

        const alreadyExists = fs.existsSync(outputPath);
        if (!alreadyExists) {
          log.info(`making thumbnail for ${inputPath} -> ${outputPath}`);

          sharp(inputPath)
            .resize(THUMB_SIZE)
            .png()
            .toFile(outputPath, () => {
              next();
            });
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
      frozen TEXT,
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

const run = async (options: PinboardOptions) => {
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
    "SELECT count(hash) AS count FROM data WHERE hash = ?",
  );

  const insert = db.prepare(
    `INSERT OR REPLACE INTO data (href,   hash,  meta,  description,  extended,  tags,  time,  screenshot,  frozen,  fulltext)
     VALUES                      (:href, :hash, :meta, :description, :extended, :tags, :time, :screenshot, :frozen, :fulltext)`,
  );

  const remove = db.prepare("DELETE FROM data WHERE hash = ?");

  const dbLinks = db.prepare("SELECT * FROM data").all() as PinboardDbRow[];

  let crawledLinks: any = await crawlLinks();

  if (isString(crawledLinks)) {
    try {
      crawledLinks = JSON.parse(crawledLinks.slice(1));
    } catch (e) {}
  }

  if (isString(crawledLinks)) {
    log.error("unrecoverable issue with crawled links");
    return;
  }

  fs.writeFileSync(
    CRAWLED_DATA_PATH,
    JSON.stringify(crawledLinks, null, 2),
    "utf-8",
  );

  const newLinks = crawledLinks.filter(
    (link: PinboardLink) =>
      (search.get(link.hash) as { count: number }).count === 0,
  );

  const removedLinks = dbLinks.filter(
    ({ hash }) => !crawledLinks.find((l: PinboardLink) => l.hash === hash),
  );

  log.info(
    `all links: ${crawledLinks.length} / new links: ${newLinks.length} / removed links: ${removedLinks.length}`,
  );

  const hashesToRemove = await processRemovedLinks(
    removedLinks,
    options.concurrency,
  );

  const removeLinks = db.transaction((hashes: string[]) => {
    hashes.forEach((hash) => remove.run(hash));
  });

  removeLinks(hashesToRemove);

  const fetchedLinks = await fetcher(newLinks, options.concurrency);

  const finalLinks = (fetchedLinks as (FetchedLink | null)[])
    .filter((link): link is FetchedLink => link != null && link.paths != null)
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

  const insertLinks = db.transaction((links: any[]) => {
    links.forEach((link) => insert.run(link));
  });

  insertLinks(finalLinks);

  await createThumbnails(db, options.concurrency);

  log.info(
    `inserted links: ${finalLinks.length} (of ${newLinks.length} new links)`,
  );
};

export default run;
