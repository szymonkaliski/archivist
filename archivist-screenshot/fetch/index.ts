import Database from "better-sqlite3";
import async from "async";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execFileSync } from "child_process";
import bplist from "bplist-parser";

import { generateEmbeddings } from "archivist-embeddings";
import { THUMBS_PATH, DB_PATH } from "../consts";
import { createLogger } from "archivist-logger";
import type { ScreenshotOptions } from "../index";

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

const makeId = (filepath: string): string =>
  crypto.createHash("md5").update(filepath).digest("hex").slice(0, 12);

const SETUP_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS data (
      filepath TEXT PRIMARY KEY,
      filename TEXT,
      time TEXT,
      width INTEGER,
      height INTEGER,
      link TEXT,
      note TEXT,
      id TEXT NOT NULL
    )
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS ft_search
    USING FTS5(filepath, filename, link, note)
  `,
  `
    CREATE TRIGGER IF NOT EXISTS ft_search_update AFTER INSERT ON data BEGIN
      INSERT INTO ft_search(filepath, filename, link, note)
      VALUES (new.filepath, new.filename, new.link, new.note);
    END
  `,
];

interface ScreenshotDbRow {
  filepath: string;
  filename: string;
  time: string;
  width: number;
  height: number;
  link: string | null;
  note: string | null;
  id: string;
}

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

  return {
    link: link || null,
    note: note || null,
  };
};

const COMMENT_XATTR = isMac
  ? "com.apple.metadata:kMDItemFinderComment"
  : "user.com.dropbox.apple.metadata:kMDItemFinderComment";

const extractXattrComment = (filepath: string) => {
  const comment = readXattr(filepath, COMMENT_XATTR);
  return parseComment(comment);
};

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
    filepath,
    filename,
    time,
    width: width!,
    height: height!,
    link,
    note,
    id: makeId(filepath),
  };
};

const populateDb = async (options: ScreenshotOptions) => {
  const db = new Database(DB_PATH);

  SETUP_STATEMENTS.forEach((stmt: string) => db.prepare(stmt).run());

  const diskFiles = new Set(
    fs
      .readdirSync(options.directory)
      .filter((f: string) => f.endsWith(".png"))
      .map((f: string) => path.join(options.directory, f)),
  );

  const dbFiles = new Set(
    (
      db.prepare("SELECT filepath FROM data").all() as { filepath: string }[]
    ).map((r) => r.filepath),
  );

  const newFiles = [...diskFiles].filter((f) => !dbFiles.has(f));
  const removedFiles = ([...dbFiles] as string[]).filter(
    (f) => !diskFiles.has(f),
  );

  if (removedFiles.length > 0) {
    const remove = db.prepare("DELETE FROM data WHERE filepath = ?");
    const removeFt = db.prepare("DELETE FROM ft_search WHERE filepath = ?");
    const removeAll = db.transaction((files: string[]) => {
      files.forEach((f) => {
        remove.run(f);
        removeFt.run(f);
      });
    });
    removeAll(removedFiles);
  }

  log.info(
    `all files: ${diskFiles.size} / new: ${newFiles.length} / removed: ${removedFiles.length}`,
  );

  if (newFiles.length > 0) {
    const entries: ScreenshotDbRow[] = [];

    await new Promise<void>((resolve) => {
      async.eachLimit(
        newFiles,
        10,
        async (filepath: string) => {
          const filename = path.basename(filepath);
          const entry = await extractMetadata(filepath, filename);
          if (entry) entries.push(entry);
        },
        () => resolve(),
      );
    });

    const insert = db.prepare(
      `INSERT INTO data (filepath, filename, time, width, height, link, note, id)
       VALUES (:filepath, :filename, :time, :width, :height, :link, :note, :id)`,
    );

    const insertAll = db.transaction((rows: ScreenshotDbRow[]) => {
      rows.forEach((row) => insert.run(row));
    });

    insertAll(entries);

    log.info(`indexed ${entries.length} new files`);
  }

  // retry xattr extraction for rows where note is still NULL (xattr may not
  // have been synced by Dropbox yet), only update rows where we actually found
  // data - leave the rest as NULL so they get retried on the next run
  const pendingOcr = db
    .prepare("SELECT filepath, filename FROM data WHERE note IS NULL")
    .all() as { filepath: string; filename: string }[];

  if (pendingOcr.length > 0) {
    const update = db.prepare(
      "UPDATE data SET link = :link, note = :note WHERE filepath = :filepath",
    );
    const deleteFt = db.prepare(
      "DELETE FROM ft_search WHERE filepath = :filepath",
    );
    const insertFt = db.prepare(
      "INSERT INTO ft_search(filepath, filename, link, note) VALUES (:filepath, :filename, :link, :note)",
    );

    let filled = 0;

    const updateAll = db.transaction(
      (
        rows: {
          filepath: string;
          filename: string;
          link: string | null;
          note: string;
        }[],
      ) => {
        rows.forEach((row) => {
          update.run(row);
          deleteFt.run(row);
          insertFt.run(row);
        });
      },
    );

    const updates: {
      filepath: string;
      filename: string;
      link: string | null;
      note: string;
    }[] = [];

    for (const { filepath, filename } of pendingOcr) {
      const { link, note } = extractXattrComment(filepath);

      if (link || note) {
        filled++;
        updates.push({ filepath, filename, link, note: note || "" });
      }
    }

    updateAll(updates);

    log.info(`retried OCR for ${pendingOcr.length} files, filled ${filled}`);
  }

  db.close();
};

const createThumbnails = (options: ScreenshotOptions) => {
  const files = fs
    .readdirSync(options.directory)
    .filter((f) => f.endsWith(".png"));

  return new Promise<void>((resolve) => {
    async.eachLimit(
      files,
      10,
      (filename: string, next: () => void) => {
        const inputPath = path.join(options.directory, filename);
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

const embedItems = async () => {
  const db = new Database(DB_PATH);
  const rows = db
    .prepare("SELECT id, filepath, link, note FROM data")
    .all() as {
    id: string;
    filepath: string;
    link: string | null;
    note: string | null;
  }[];

  await generateEmbeddings({
    db,
    items: rows.map((r) => ({
      id: r.id,
      thumbPath: path.join(
        THUMBS_PATH,
        path.parse(path.basename(r.filepath)).name + ".png",
      ),
      text: [r.note, r.link].filter(Boolean).join(" "),
    })),
  });

  db.close();
};

export default async (options: ScreenshotOptions) => {
  await populateDb(options);
  await createThumbnails(options);
  await embedItems();
};
