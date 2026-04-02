import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execFileSync } from "child_process";
import bplist from "bplist-parser";
import type Database from "better-sqlite3";

import { createLogger } from "../../logger";
import { sourceThumbsDir } from "../../paths";
import type { SourceDefinition, ScreenshotConfig, SearchResult } from "../../types";

const log = createLogger("screenshot");

const isMac = process.platform === "darwin";

if (!isMac) {
  try {
    execFileSync("which", ["getfattr"], { stdio: "pipe" });
  } catch {
    log.warn(
      "getfattr not found — xattr extraction will be unavailable (install the 'attr' package)",
    );
  }
}

const THUMB_SIZE = 400;
const THUMBS_PATH = sourceThumbsDir("screenshot");

const makeId = (filepath: string): string =>
  crypto.createHash("md5").update(filepath).digest("hex").slice(0, 12);

const globalId = (filepath: string): string =>
  `screenshot:${makeId(filepath)}`;

const parseTimeFromFilename = (filename: string): string | undefined => {
  const match = filename.match(
    /Screenshot (\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})/,
  );
  if (match) {
    const [, year, month, day, hour, min, sec] = match;
    return `${year}/${month}/${day} ${hour}:${min}:${sec}`;
  }
  return undefined;
};

const readXattr = (filePath: string, key: string): any => {
  try {
    if (isMac) {
      const hex = execFileSync("xattr", ["-px", key, filePath], {
        stdio: ["pipe", "pipe", "pipe"],
      }).toString();
      const buf = Buffer.from(hex.replace(/\s/g, ""), "hex");
      return bplist.parseBuffer(buf)[0];
    } else {
      const buf = execFileSync(
        "getfattr",
        ["-n", key, "--only-values", filePath],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      return bplist.parseBuffer(buf)[0];
    }
  } catch {
    return undefined;
  }
};

const parseComment = (
  comment: string | undefined,
): { link: string | null; note: string | null } => {
  if (!comment) return { link: null, note: null };

  let link: string | undefined;
  let note: string | undefined = comment;

  const firstLine = note.split("\n")[0];
  if (
    firstLine.startsWith("http://") ||
    firstLine.startsWith("https://") ||
    firstLine.startsWith("file://")
  ) {
    link = firstLine;
    note = note.slice(firstLine.length + 1).replace(/^\n/, "");
  }

  return { link: link || null, note: note || null };
};

const COMMENT_XATTR = isMac
  ? "com.apple.metadata:kMDItemFinderComment"
  : "user.com.dropbox.apple.metadata:kMDItemFinderComment";

const extractXattrComment = (filepath: string) => {
  const comment = readXattr(filepath, COMMENT_XATTR);
  return parseComment(comment);
};

interface ScreenshotDbRow {
  global_id: string;
  filepath: string;
  filename: string;
  time: string;
  width: number;
  height: number;
  link: string | null;
  note: string | null;
}

const extractMetadata = async (
  filepath: string,
  filename: string,
): Promise<ScreenshotDbRow | null> => {
  const time =
    parseTimeFromFilename(filename) ||
    fs
      .statSync(filepath)
      .mtime.toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z/, "")
      .replace(/-/g, "/");

  let width: number | undefined, height: number | undefined;
  try {
    const meta = await sharp(filepath).metadata();
    width = meta.width;
    height = meta.height;
  } catch {
    return null;
  }

  const { link, note } = extractXattrComment(filepath);

  return {
    global_id: globalId(filepath),
    filepath,
    filename,
    time,
    width: width!,
    height: height!,
    link,
    note,
  };
};

const populateDb = async (db: Database.Database, config: ScreenshotConfig) => {
  const diskFiles = new Set(
    fs
      .readdirSync(config.directory)
      .filter((f: string) => f.endsWith(".png"))
      .map((f: string) => path.join(config.directory, f)),
  );

  const dbFiles = new Set(
    (
      db.prepare("SELECT filepath FROM screenshot").all() as { filepath: string }[]
    ).map((r) => r.filepath),
  );

  const newFiles = [...diskFiles].filter((f) => !dbFiles.has(f));
  const removedFiles = ([...dbFiles] as string[]).filter(
    (f) => !diskFiles.has(f),
  );

  if (removedFiles.length > 0) {
    const remove = db.prepare("DELETE FROM screenshot WHERE filepath = ?");
    const removeFt = db.prepare("DELETE FROM screenshot_fts WHERE global_id = ?");
    db.transaction((files: string[]) => {
      for (const f of files) {
        const row = db.prepare("SELECT global_id FROM screenshot WHERE filepath = ?").get(f) as { global_id: string } | undefined;
        if (row) {
          removeFt.run(row.global_id);
          remove.run(f);
        }
      }
    })(removedFiles);
  }

  log.info(
    `all files: ${diskFiles.size} / new: ${newFiles.length} / removed: ${removedFiles.length}`,
  );

  if (newFiles.length > 0) {
    const entries: ScreenshotDbRow[] = [];

    for (const filepath of newFiles) {
      const filename = path.basename(filepath);
      const entry = await extractMetadata(filepath, filename);
      if (entry) entries.push(entry);
    }

    const insert = db.prepare(
      `INSERT INTO screenshot (global_id, filepath, filename, time, width, height, link, note)
       VALUES (:global_id, :filepath, :filename, :time, :width, :height, :link, :note)`,
    );

    db.transaction((rows: ScreenshotDbRow[]) => {
      for (const row of rows) insert.run(row);
    })(entries);

    log.info(`indexed ${entries.length} new files`);
  }

  // retry xattr extraction for rows where note is still NULL
  const pending = db
    .prepare("SELECT global_id, filepath, filename FROM screenshot WHERE note IS NULL")
    .all() as { global_id: string; filepath: string; filename: string }[];

  if (pending.length > 0) {
    const update = db.prepare(
      "UPDATE screenshot SET link = :link, note = :note WHERE global_id = :global_id",
    );
    const deleteFt = db.prepare(
      "DELETE FROM screenshot_fts WHERE global_id = :global_id",
    );
    const insertFt = db.prepare(
      "INSERT INTO screenshot_fts(global_id, filepath, filename, link, note) VALUES (:global_id, :filepath, :filename, :link, :note)",
    );

    const updates: { global_id: string; filepath: string; filename: string; link: string | null; note: string }[] = [];

    for (const { global_id, filepath, filename } of pending) {
      const { link, note } = extractXattrComment(filepath);
      if (link || note) {
        updates.push({ global_id, filepath, filename, link, note: note || "" });
      }
    }

    db.transaction((rows: typeof updates) => {
      for (const row of rows) {
        update.run(row);
        deleteFt.run(row);
        insertFt.run(row);
      }
    })(updates);

    log.info(`retried xattr for ${pending.length} files, filled ${updates.length}`);
  }
};

const createThumbnails = async (config: ScreenshotConfig) => {
  fs.mkdirSync(THUMBS_PATH, { recursive: true });

  const files = fs
    .readdirSync(config.directory)
    .filter((f) => f.endsWith(".png"));

  for (const filename of files) {
    const inputPath = path.join(config.directory, filename);
    const outputName = path.parse(filename).name + ".png";
    const outputPath = path.join(THUMBS_PATH, outputName);

    if (!fs.existsSync(outputPath)) {
      log.info(`making thumbnail for ${inputPath} -> ${outputPath}`);
      await sharp(inputPath).resize(THUMB_SIZE).png().toFile(outputPath);
    }
  }
};

const screenshot: SourceDefinition<"screenshot"> = {
  kind: "screenshot",

  setupStatements: [
    `CREATE TABLE IF NOT EXISTS screenshot (
      global_id TEXT PRIMARY KEY,
      filepath TEXT NOT NULL UNIQUE,
      filename TEXT,
      time TEXT,
      width INTEGER,
      height INTEGER,
      link TEXT,
      note TEXT
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS screenshot_fts
     USING FTS5(global_id, filepath, filename, link, note)`,
    `CREATE TRIGGER IF NOT EXISTS screenshot_fts_insert AFTER INSERT ON screenshot BEGIN
      INSERT INTO screenshot_fts(global_id, filepath, filename, link, note)
      VALUES (new.global_id, new.filepath, new.filename, new.link, new.note);
    END`,
    `CREATE TRIGGER IF NOT EXISTS screenshot_fts_delete AFTER DELETE ON screenshot BEGIN
      DELETE FROM screenshot_fts WHERE global_id = old.global_id;
    END`,
  ],

  ftsTable: "screenshot_fts",
  dataTable: "screenshot",

  async fetch(db, config) {
    await populateDb(db, config);
    await createThumbnails(config);
  },

  toSearchResult(row): SearchResult {
    const r = row as Record<string, any>;
    const thumbname = path.parse(r.filename).name + ".png";
    const thumbImg = path.join(THUMBS_PATH, thumbname);
    const hasThumb = fs.existsSync(thumbImg);

    return {
      img: r.filepath,
      thumbImg: hasThumb ? thumbImg : r.filepath,
      id: r.global_id,
      link: r.link || undefined,
      time: r.time,
      width: r.width,
      height: r.height,
      meta: {
        source: "screenshot",
        note: r.note || undefined,
      },
    };
  },

  embeddingText(row): string {
    const r = row as Record<string, any>;
    return [r.note, r.link].filter(Boolean).join(" ");
  },

  thumbPath(row): string {
    const r = row as Record<string, any>;
    return path.join(THUMBS_PATH, path.parse(r.filename).name + ".png");
  },
};

export default screenshot;
