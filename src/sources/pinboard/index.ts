import fs from "fs";
import path from "path";
import sharp from "sharp";
import { default as Pinboard } from "node-pinboard";
import type Database from "better-sqlite3";

import { createLogger } from "../../logger";
import { sourceAssetsDir, sourceFrozenDir, sourceThumbsDir, sourceDir } from "../../paths";
import type { SourceDefinition, PinboardConfig, SearchResult } from "../../types";
import { fetchLinks, type PinboardLink, type FetcherResult } from "./fetcher";

const log = createLogger("pinboard");

const ASSETS_PATH = sourceAssetsDir("pinboard");
const FROZEN_PATH = sourceFrozenDir("pinboard");
const THUMBS_PATH = sourceThumbsDir("pinboard");
const THUMB_SIZE = 400;

const globalId = (hash: string): string => `pinboard:${hash}`;

interface PinboardDbRow extends PinboardLink {
  global_id: string;
  screenshot: string;
  frozen: string;
  fulltext: string;
}

const createThumbnails = async (db: Database.Database) => {
  const dbScreenshots = db.prepare("SELECT screenshot FROM pinboard").all() as {
    screenshot: string;
  }[];

  for (const { screenshot: filename } of dbScreenshots) {
    if (!filename) continue;
    const inputPath = path.join(ASSETS_PATH, filename);
    const outputName = path.parse(filename).name + ".png";
    const outputPath = path.join(THUMBS_PATH, outputName);

    if (!fs.existsSync(outputPath)) {
      log.info(`making thumbnail for ${inputPath} -> ${outputPath}`);
      try {
        await sharp(inputPath).resize(THUMB_SIZE).png().toFile(outputPath);
      } catch (e: any) {
        log.error("error making thumbnail for: %s %s", inputPath, String(e));
      }
    }
  }
};

const pinboard: SourceDefinition<"pinboard"> = {
  kind: "pinboard",

  setupStatements: [
    `CREATE TABLE IF NOT EXISTS pinboard (
      global_id TEXT PRIMARY KEY,
      href TEXT,
      hash TEXT NOT NULL UNIQUE,
      meta TEXT,
      description TEXT,
      extended TEXT,
      tags TEXT,
      time DATETIME,
      screenshot TEXT,
      frozen TEXT,
      fulltext TEXT
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS pinboard_fts
     USING FTS5(global_id, href, meta, description, extended, tags, fulltext)`,
    `CREATE TRIGGER IF NOT EXISTS pinboard_fts_insert AFTER INSERT ON pinboard BEGIN
      INSERT INTO pinboard_fts(global_id, href, meta, description, extended, tags, fulltext)
      VALUES (new.global_id, new.href, new.meta, new.description, new.extended, new.tags, new.fulltext);
    END`,
    `CREATE TRIGGER IF NOT EXISTS pinboard_fts_delete AFTER DELETE ON pinboard BEGIN
      DELETE FROM pinboard_fts WHERE global_id = old.global_id;
    END`,
  ],

  ftsTable: "pinboard_fts",
  dataTable: "pinboard",

  async fetch(db, config) {
    if (!config.apiKey) throw new Error("apiKey not provided");

    fs.mkdirSync(ASSETS_PATH, { recursive: true });
    fs.mkdirSync(FROZEN_PATH, { recursive: true });
    fs.mkdirSync(THUMBS_PATH, { recursive: true });

    const pinboardApi = new Pinboard(config.apiKey);
    let crawledLinks: any = await pinboardApi.all();

    if (typeof crawledLinks === "string") {
      try {
        crawledLinks = JSON.parse(crawledLinks.slice(1));
      } catch {}
    }
    if (typeof crawledLinks === "string") {
      log.error("unrecoverable issue with crawled links");
      return;
    }

    fs.writeFileSync(
      path.join(sourceDir("pinboard"), "crawled-links.json"),
      JSON.stringify(crawledLinks, null, 2),
      "utf-8",
    );

    const search = db.prepare(
      "SELECT count(hash) AS count FROM pinboard WHERE hash = ?",
    );
    const insert = db.prepare(
      `INSERT OR REPLACE INTO pinboard (global_id, href, hash, meta, description, extended, tags, time, screenshot, frozen, fulltext)
       VALUES (:global_id, :href, :hash, :meta, :description, :extended, :tags, :time, :screenshot, :frozen, :fulltext)`,
    );
    const remove = db.prepare("DELETE FROM pinboard WHERE hash = ?");

    const dbLinks = db.prepare("SELECT * FROM pinboard").all() as PinboardDbRow[];

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

    // process removed
    for (const item of removedLinks) {
      const screenshotPath = item.screenshot && path.join(ASSETS_PATH, item.screenshot);
      const frozenPath = item.frozen && path.join(FROZEN_PATH, item.frozen);
      if (screenshotPath && fs.existsSync(screenshotPath)) {
        log.info(`unlinking ${screenshotPath}`);
        fs.unlinkSync(screenshotPath);
      }
      if (frozenPath && fs.existsSync(frozenPath)) {
        log.info(`unlinking ${frozenPath}`);
        fs.unlinkSync(frozenPath);
      }
    }

    db.transaction((hashes: string[]) => {
      for (const hash of hashes) remove.run(hash);
    })(removedLinks.map((l) => l.hash));

    // fetch new
    const allFetched = (
      await fetchLinks(newLinks, config.concurrency)
    ).filter((r): r is FetcherResult => r !== null);

    const savedLinks = allFetched
      .filter((r): r is Extract<FetcherResult, { kind: "saved" }> => r.kind === "saved")
      .map((r) => ({
        global_id: globalId(r.link.hash),
        href: r.link.href,
        hash: r.link.hash,
        meta: r.link.meta,
        description: r.link.description,
        extended: r.link.extended,
        tags: r.link.tags,
        time: r.link.time,
        screenshot: r.paths.screenshot,
        frozen: r.paths.frozen,
        fulltext: r.fulltext,
      }));

    const failedLinks = allFetched
      .filter(
        (r): r is Extract<FetcherResult, { kind: "permanently_failed" }> =>
          r.kind === "permanently_failed",
      )
      .map((r) => ({
        global_id: globalId(r.link.hash),
        href: r.link.href,
        hash: r.link.hash,
        meta: r.link.meta,
        description: r.link.description,
        extended: r.link.extended,
        tags: r.link.tags,
        time: r.link.time,
        screenshot: null,
        frozen: null,
        fulltext: "",
      }));

    db.transaction((links: any[]) => {
      for (const link of links) insert.run(link);
    })(savedLinks);

    db.transaction((links: any[]) => {
      for (const link of links) insert.run(link);
    })(failedLinks);

    if (failedLinks.length > 0) {
      log.warn(
        `marked ${failedLinks.length} links as permanently failed (offline, no archive found)`,
      );
    }

    await createThumbnails(db);

    log.info(
      `inserted links: ${savedLinks.length} (of ${newLinks.length} new links)`,
    );
  },

  toSearchResult(row): SearchResult {
    const r = row as Record<string, any>;
    if (!r.screenshot) {
      return {
        img: "",
        thumbImg: "",
        id: r.global_id,
        link: r.href,
        time: r.time,
        width: 1920,
        height: 1080,
        meta: {
          source: "pinboard",
          title: r.description,
          note: r.extended,
          tags: r.tags ? r.tags.split(" ") : [],
          static: r.frozen ? path.join(FROZEN_PATH, r.frozen) : undefined,
        },
      };
    }

    const thumbname = path.parse(r.screenshot).name + ".png";
    return {
      img: path.join(ASSETS_PATH, r.screenshot),
      thumbImg: path.join(THUMBS_PATH, thumbname),
      id: r.global_id,
      link: r.href,
      time: r.time,
      width: 1920,
      height: 1080,
      meta: {
        source: "pinboard",
        title: r.description,
        note: r.extended,
        tags: r.tags ? r.tags.split(" ") : [],
        static: r.frozen ? path.join(FROZEN_PATH, r.frozen) : undefined,
      },
    };
  },

  embeddingText(row): string {
    const r = row as Record<string, any>;
    return [r.description, r.extended, r.tags, r.href].filter(Boolean).join(" ");
  },

  thumbPath(row): string {
    const r = row as Record<string, any>;
    if (!r.screenshot) return "";
    return path.join(THUMBS_PATH, path.parse(r.screenshot).name + ".png");
  },
};

export default pinboard;
