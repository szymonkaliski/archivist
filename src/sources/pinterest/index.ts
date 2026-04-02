import fs from "fs";
import md5 from "md5";
import path from "path";
import sharp from "sharp";
import { imageSize } from "image-size";
import tmp from "tmp";
import wget from "node-wget";
import type Database from "better-sqlite3";

import { createLogger } from "../../logger";
import { sourceAssetsDir, sourceThumbsDir } from "../../paths";
import type { SourceDefinition, SearchResult } from "../../types";
import {
  crawlBoards,
  crawlPinMetadata,
  type CrawledPin,
  type CrawledPinWithMetadata,
} from "./crawler";

const log = createLogger("pinterest");

const ASSETS_PATH = sourceAssetsDir("pinterest");
const THUMBS_PATH = sourceThumbsDir("pinterest");
const THUMB_SIZE = 400;

const makePinId = (pin: CrawledPin): string =>
  pin.url.split("/").filter(Boolean).pop()!;

const globalId = (pinid: string): string => `pinterest:${pinid}`;

export interface FetchedPin extends CrawledPinWithMetadata {
  filename: string;
  width: number;
  height: number;
}

const download = async (
  url: string,
): Promise<{ filename: string; width: number; height: number }> => {
  log.debug("downloading %s", url);
  const tempPath = tmp.tmpNameSync();

  return new Promise((resolve, reject) =>
    (wget as any)(
      { url, dest: tempPath },
      (error: any, _: any, body: string) => {
        if (error) return reject(error);

        const ext = path.extname(url);
        const hash = md5(body);
        const filename = `${hash}${ext}`;
        const finalPath = path.join(ASSETS_PATH, filename);

        fs.renameSync(tempPath, finalPath);

        try {
          const buf = fs.readFileSync(finalPath);
          const size = imageSize(new Uint8Array(buf));
          resolve({
            filename,
            width: size.width || 0,
            height: size.height || 0,
          });
        } catch (err) {
          log.warn(`image-size error: ${err} (${finalPath})`);
          resolve({ filename, width: 0, height: 0 });
        }
      },
    ),
  );
};

const fetchPins = async (
  crawledPins: CrawledPinWithMetadata[],
  concurrency = 10,
): Promise<(FetchedPin | null)[]> => {
  const results: (FetchedPin | null)[] = [];
  const queue = [...crawledPins];

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const pin = queue.shift()!;
      try {
        const { filename, width, height } = await download(pin.biggestSrc);
        results.push({ ...pin, filename, width, height });
      } catch (e: any) {
        log.error("download failed for %s: %s", pin.biggestSrc, e.message);
        results.push(null);
      }
    }
  });

  await Promise.all(workers);
  return results;
};

const createThumbnails = async (db: Database.Database) => {
  fs.mkdirSync(THUMBS_PATH, { recursive: true });

  const dbFiles = db.prepare("SELECT filename FROM pinterest").all() as {
    filename: string;
  }[];

  for (const { filename } of dbFiles) {
    const inputPath = path.join(ASSETS_PATH, filename);
    if (!fs.existsSync(inputPath)) continue;

    const outputName = path.parse(filename).name + ".png";
    const outputPath = path.join(THUMBS_PATH, outputName);

    if (!fs.existsSync(outputPath)) {
      log.info(`making thumbnail for ${inputPath} -> ${outputPath}`);
      try {
        const meta = await sharp(inputPath).metadata();
        const w = meta.width || 0;
        const h = meta.height || 0;
        if (w <= THUMB_SIZE && h <= THUMB_SIZE) {
          fs.copyFileSync(inputPath, outputPath);
        } else {
          await sharp(inputPath).resize(THUMB_SIZE).png().toFile(outputPath);
        }
      } catch (e: any) {
        log.error("error making thumbnail for: %s %s", inputPath, String(e));
        try {
          fs.copyFileSync(inputPath, outputPath);
        } catch {}
      }
    }
  }
};

interface PinDbRow {
  global_id: string;
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

const pinterest: SourceDefinition<"pinterest"> = {
  kind: "pinterest",

  setupStatements: [
    `CREATE TABLE IF NOT EXISTS pinterest (
      global_id TEXT PRIMARY KEY,
      board TEXT,
      filename TEXT,
      title TEXT,
      text TEXT,
      link TEXT,
      pinurl TEXT,
      pinid TEXT NOT NULL UNIQUE,
      crawldate DATETIME,
      createdat DATETIME,
      width INTEGER,
      height INTEGER
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS pinterest_fts
     USING FTS5(global_id, board, link, title, text)`,
    `CREATE TRIGGER IF NOT EXISTS pinterest_fts_insert AFTER INSERT ON pinterest BEGIN
      INSERT INTO pinterest_fts(global_id, board, link, title, text)
      VALUES (new.global_id, new.board, new.link, new.title, new.text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS pinterest_fts_delete AFTER DELETE ON pinterest BEGIN
      DELETE FROM pinterest_fts WHERE global_id = old.global_id;
    END`,
  ],

  ftsTable: "pinterest_fts",
  dataTable: "pinterest",

  async fetch(db, config) {
    fs.mkdirSync(ASSETS_PATH, { recursive: true });
    fs.mkdirSync(THUMBS_PATH, { recursive: true });

    const search = db.prepare(
      "SELECT count(pinid) AS count FROM pinterest WHERE pinid = ?",
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO pinterest (global_id, board, filename, title, text, link, pinurl, pinid, crawldate, createdat, width, height)
       VALUES (:global_id, :board, :filename, :title, :text, :link, :pinurl, :pinid, :crawldate, :createdat, :width, :height)`,
    );
    const remove = db.prepare("DELETE FROM pinterest WHERE pinid = ?");

    const dbPins = db.prepare("SELECT * FROM pinterest").all() as PinDbRow[];

    let recentPinIdsByBoard: Map<string, string[]> | undefined;
    if (config.appendOnly) {
      log.info("appendOnly mode, will stop at known pins");
      recentPinIdsByBoard = new Map();
      const recentPinsQuery = db.prepare(
        "SELECT pinid FROM pinterest WHERE board = ? ORDER BY createdat DESC LIMIT 10",
      );
      const boards = db
        .prepare("SELECT DISTINCT board FROM pinterest")
        .all() as { board: string }[];
      for (const { board } of boards) {
        const pins = recentPinsQuery.all(board) as { pinid: string }[];
        recentPinIdsByBoard.set(
          board,
          pins.map((p) => p.pinid),
        );
      }
    }

    const crawledPins = await crawlBoards(config, recentPinIdsByBoard);

    if (crawledPins.length === 0) {
      log.warn("0 crawled pins, exiting");
      return;
    }

    const DATA_DIR = path.dirname(ASSETS_PATH);
    fs.writeFileSync(
      path.join(DATA_DIR, "crawled-pins.json"),
      JSON.stringify(crawledPins, null, 2),
      "utf-8",
    );

    const newPins = crawledPins.filter((pin) => {
      if (!pin) return false;
      const pinid = makePinId(pin);
      return (search.get(pinid) as { count: number }).count === 0;
    });

    if (!config.appendOnly) {
      const removedPins = dbPins.filter(
        ({ pinid }) => !crawledPins.find((pin) => makePinId(pin) === pinid),
      );

      log.info(
        `crawled pins: ${crawledPins.length} / new pins: ${newPins.length} / removed pins: ${removedPins.length}`,
      );

      if (removedPins.length > 0) {
        for (const pin of removedPins) {
          const filePath = pin.filename && path.join(ASSETS_PATH, pin.filename);
          if (filePath && fs.existsSync(filePath)) {
            log.info(`unlinking ${filePath}`);
            fs.unlinkSync(filePath);
          }
        }
        db.transaction((pins: PinDbRow[]) => {
          for (const pin of pins) remove.run(pin.pinid);
        })(removedPins);
      }
    } else {
      log.info(
        `crawled pins: ${crawledPins.length} / new pins: ${newPins.length}`,
      );
    }

    const newPinsWithMetadata = await crawlPinMetadata(config, newPins);
    const fetchedPins = await fetchPins(
      newPinsWithMetadata,
      config.concurrency,
    );
    const crawldate = new Date().toISOString();

    const finalPins = (fetchedPins as (FetchedPin | null)[])
      .filter((pin): pin is FetchedPin => pin != null)
      .map((pin) => {
        const pinid = makePinId(pin);
        return {
          global_id: globalId(pinid),
          board: pin.board,
          filename: pin.filename,
          title: pin.title,
          text: pin.text || pin.alt,
          link: pin.link,
          pinurl: pin.url,
          pinid,
          crawldate,
          createdat: pin.createdAt
            ? new Date(pin.createdAt).toISOString()
            : undefined,
          width: pin.width,
          height: pin.height,
        };
      });

    db.transaction((pins: any[]) => {
      for (const pin of pins) insert.run(pin);
    })(finalPins);

    await createThumbnails(db);

    log.info(`inserted pins: ${finalPins.length} (of ${newPins.length})`);
  },

  toSearchResult(row): SearchResult {
    const r = row as Record<string, any>;
    const thumbname = path.parse(r.filename).name + ".png";
    const imgPath = path.join(ASSETS_PATH, r.filename);
    const thumbPath = path.join(THUMBS_PATH, thumbname);

    let thumbOk = false;
    try {
      const stat = fs.statSync(thumbPath);
      thumbOk = stat.size > 0;
    } catch {}

    return {
      img: imgPath,
      thumbImg: thumbOk ? thumbPath : imgPath,
      id: r.global_id,
      link: r.link || r.pinurl,
      time: r.createdat || r.crawldate,
      width: r.width,
      height: r.height,
      meta: {
        source: "pinterest",
        title: r.title,
        note: r.text,
        tags: [r.board],
      },
    };
  },

  embeddingText(row): string {
    const r = row as Record<string, any>;
    return [r.title, r.text, r.board, r.link].filter(Boolean).join(" ");
  },

  thumbPath(row): string {
    const r = row as Record<string, any>;
    return path.join(THUMBS_PATH, path.parse(r.filename).name + ".png");
  },
};

export default pinterest;
