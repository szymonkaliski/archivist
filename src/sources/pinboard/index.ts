import fs from "fs";
import path from "path";
import sharp from "sharp";
import type Database from "better-sqlite3";

import { createLogger } from "../../logger";
import {
  sourceAssetsDir,
  sourceFrozenDir,
  sourceThumbsDir,
  sourceDir,
} from "../../paths";
import type { SourceDefinition, SearchResult } from "../../types";
import { withRetry } from "../../retry";
import { fetchWithDeadline, describeFetchError } from "../../http";
import { fetchLinks, type PinboardLink, type FetcherResult } from "./fetcher";

const log = createLogger("pinboard");

const ASSETS_PATH = sourceAssetsDir("pinboard");
const FROZEN_PATH = sourceFrozenDir("pinboard");
const THUMBS_PATH = sourceThumbsDir("pinboard");
const THUMB_SIZE = 400;

const API_URL = "https://api.pinboard.in/v1/posts/all";

// pinboard.in documents posts/all as callable once every five minutes and
// answers 429 past that, so the one retry waits out the whole window rather
// than spending its attempts inside it.
const API_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300_000;

// the api answers the tcp handshake and then goes silent for hours at a time,
// which leaves the socket established with no transport-level timeout to break
// it, so the request carries its own deadline.
const API_TIMEOUT_MS = 60_000;

// enough of an unexpected body to identify it in the log without pasting a
// whole error page into the journal
const BODY_PREVIEW = 200;

// the request url carries the api token in its query string, and both error
// messages and server error pages can quote that url back, so every reason
// built from a response passes through here before it is logged.
export const redactToken = (message: string): string =>
  message.replace(/auth_token=[^&\s]+/g, "auth_token=[redacted]");

// JSON.parse rejects a leading byte order mark, which the api has no obligation
// to omit
const stripBom = (body: string): string =>
  body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;

const fetchAllPosts = async (apiKey: string): Promise<PinboardLink[]> => {
  const url = new URL(API_URL);
  url.searchParams.set("auth_token", apiKey);
  url.searchParams.set("format", "json");

  // An error thrown here propagates past every caller and aborts the whole
  // source for the run, so anything that might be transient is retried.
  return withRetry(
    {
      label: "posts/all",
      attempts: API_ATTEMPTS,
      backoff: { kind: "fixed", ms: RETRY_DELAY_MS },
      log,
    },
    async () => {
      let res: Response;
      let body: string;
      try {
        res = await fetchWithDeadline(url.toString(), API_TIMEOUT_MS, {
          headers: { Accept: "application/json" },
        });
        // read inside the deadline too, so a stall part-way through the body
        // aborts rather than hanging on an open response
        body = await res.text();
      } catch (e: any) {
        return {
          kind: "retry",
          reason: redactToken(describeFetchError(e, API_TIMEOUT_MS)),
        };
      }

      // the only documented permanent rejection; every other status could be a
      // transient block and falls through to a retry
      if (res.status === 401) {
        return { kind: "fail", reason: "api rejected the token (401)" };
      }

      if (res.status === 429) {
        return {
          kind: "retry-after",
          reason: "rate limited",
          waitMs: RETRY_DELAY_MS,
        };
      }

      if (!res.ok) {
        return { kind: "retry", reason: `API ${res.status}` };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripBom(body));
      } catch {
        return {
          kind: "retry",
          reason: `body was not json: ${redactToken(body.slice(0, BODY_PREVIEW))}`,
        };
      }

      if (!Array.isArray(parsed)) {
        return {
          kind: "retry",
          reason: `expected an array of posts, got ${typeof parsed}`,
        };
      }

      return { kind: "done", value: parsed as PinboardLink[] };
    },
  );
};

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

    const crawledLinks = await fetchAllPosts(config.apiKey);

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

    const dbLinks = db
      .prepare("SELECT * FROM pinboard")
      .all() as PinboardDbRow[];

    const newLinks = crawledLinks.filter(
      (link) => (search.get(link.hash) as { count: number }).count === 0,
    );

    const removedLinks = dbLinks.filter(
      ({ hash }) => !crawledLinks.find((l) => l.hash === hash),
    );

    log.info(
      `all links: ${crawledLinks.length} / new links: ${newLinks.length} / removed links: ${removedLinks.length}`,
    );

    // process removed
    for (const item of removedLinks) {
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
    }

    db.transaction((hashes: string[]) => {
      for (const hash of hashes) remove.run(hash);
    })(removedLinks.map((l) => l.hash));

    // fetch new
    const allFetched = (await fetchLinks(newLinks, config.concurrency)).filter(
      (r): r is FetcherResult => r !== null,
    );

    const savedLinks = allFetched
      .filter(
        (r): r is Extract<FetcherResult, { kind: "saved" }> =>
          r.kind === "saved",
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
    return [r.description, r.extended, r.tags, r.href]
      .filter(Boolean)
      .join(" ");
  },

  thumbPath(row): string {
    const r = row as Record<string, any>;
    if (!r.screenshot) return "";
    return path.join(THUMBS_PATH, path.parse(r.screenshot).name + ".png");
  },
};

export default pinboard;
