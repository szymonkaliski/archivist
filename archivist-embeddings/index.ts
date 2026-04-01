import type Database from "better-sqlite3";
import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createLogger } from "archivist-logger";

const log = createLogger("embeddings");

const IMAGE_MODEL_ID = "onnx-community/dinov2-base";
const TEXT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const IMAGE_SIZE = 224;
const CACHE_DIR = path.join(envPaths("archivist").cache, "models");

const GLOBAL_IMG = "__archivist_clip_img__";
const GLOBAL_TEXT_PIPE = "__archivist_text_pipe__";
const GLOBAL_LOCK = "__archivist_clip_lock__";
const GLOBAL_TEXT_LOCK = "__archivist_text_lock__";

const ensureCache = () => fs.mkdirSync(CACHE_DIR, { recursive: true });

const getImageExtractor = async () => {
  if ((globalThis as any)[GLOBAL_IMG]) return (globalThis as any)[GLOBAL_IMG];
  if ((globalThis as any)[GLOBAL_LOCK]) return (globalThis as any)[GLOBAL_LOCK];

  const loading = (async () => {
    ensureCache();
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = CACHE_DIR;

    log.info("loading DINOv2 vision model...");
    const instance = await pipeline(
      "image-feature-extraction",
      IMAGE_MODEL_ID,
      { dtype: "fp32" },
    );
    log.info("DINOv2 vision model loaded");

    (globalThis as any)[GLOBAL_IMG] = instance;
    (globalThis as any)[GLOBAL_LOCK] = null;
    return instance;
  })();

  (globalThis as any)[GLOBAL_LOCK] = loading;
  return loading;
};

const getTextExtractor = async () => {
  if ((globalThis as any)[GLOBAL_TEXT_PIPE])
    return (globalThis as any)[GLOBAL_TEXT_PIPE];
  if ((globalThis as any)[GLOBAL_TEXT_LOCK])
    return (globalThis as any)[GLOBAL_TEXT_LOCK];

  const loading = (async () => {
    ensureCache();
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = CACHE_DIR;

    log.info("loading text model (all-MiniLM-L6-v2)...");
    const instance = await pipeline("feature-extraction", TEXT_MODEL_ID, {
      dtype: "fp32",
    });
    log.info("text model loaded");

    (globalThis as any)[GLOBAL_TEXT_PIPE] = instance;
    (globalThis as any)[GLOBAL_TEXT_LOCK] = null;
    return instance;
  })();

  (globalThis as any)[GLOBAL_TEXT_LOCK] = loading;
  return loading;
};

const SETUP_IMG = `
  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'dinov2-base'
  )
`;

const SETUP_TXT = `
  CREATE TABLE IF NOT EXISTS text_embeddings (
    id TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2'
  )
`;

interface EmbedItem {
  id: string;
  thumbPath: string;
  text: string;
}

interface EmbedOptions {
  db: Database.Database;
  items: EmbedItem[];
}

const DINO_DIMS = 768;

const extractCLS = (output: any): Buffer => {
  const data = output.data as Float32Array;
  const cls = new Float32Array(DINO_DIMS);
  for (let i = 0; i < DINO_DIMS; i++) cls[i] = data[i];
  let norm = 0;
  for (let i = 0; i < DINO_DIMS; i++) norm += cls[i] * cls[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DINO_DIMS; i++) cls[i] /= norm;
  return Buffer.from(cls.buffer as ArrayBuffer);
};

const generateImageEmbeddings = async (
  db: Database.Database,
  items: EmbedItem[],
) => {
  db.prepare(SETUP_IMG).run();

  const stale = (
    db
      .prepare("SELECT COUNT(*) as c FROM embeddings WHERE model != ?")
      .get("dinov2-base") as { c: number }
  ).c;
  if (stale > 0) {
    log.info(`clearing ${stale} stale image embeddings (model changed)`);
    db.prepare("DROP TABLE embeddings").run();
    db.prepare(SETUP_IMG).run();
  }

  const existing = new Set(
    (db.prepare("SELECT id FROM embeddings").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );

  const pending = items.filter(
    (item) => !existing.has(item.id) && fs.existsSync(item.thumbPath),
  );

  if (pending.length === 0) {
    log.info("all items already have image embeddings");
    return;
  }

  log.info(
    `embedding ${pending.length} images (${existing.size} already done)`,
  );

  const extractor = await getImageExtractor();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO embeddings (id, embedding, model) VALUES (?, ?, ?)",
  );

  for (let i = 0; i < pending.length; i++) {
    const { id, thumbPath } = pending[i];
    try {
      const buf = await sharp(thumbPath)
        .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover" })
        .removeAlpha()
        .raw()
        .toBuffer();

      const { RawImage } = await import("@huggingface/transformers");
      const image = new RawImage(
        new Uint8ClampedArray(buf),
        IMAGE_SIZE,
        IMAGE_SIZE,
        3,
      );

      const output = await extractor(image);
      const embedding = extractCLS(output);
      insert.run(id, embedding, "dinov2-base");

      if ((i + 1) % 50 === 0) {
        log.info(`image embeddings: ${i + 1}/${pending.length}`);
      }
    } catch (e) {
      log.warn(`failed to embed image ${id}: ${e}`);
    }
  }

  log.info(`done embedding ${pending.length} images`);
};

const generateTextEmbeddings = async (
  db: Database.Database,
  items: EmbedItem[],
) => {
  db.prepare(SETUP_TXT).run();

  const stale = (
    db
      .prepare("SELECT COUNT(*) as c FROM text_embeddings WHERE model != ?")
      .get("all-MiniLM-L6-v2") as { c: number }
  ).c;
  if (stale > 0) {
    log.info(`clearing ${stale} stale text embeddings (model changed)`);
    db.prepare("DROP TABLE text_embeddings").run();
    db.prepare(SETUP_TXT).run();
  }

  const existing = new Set(
    (
      db.prepare("SELECT id FROM text_embeddings").all() as { id: string }[]
    ).map((r) => r.id),
  );

  const pending = items.filter(
    (item) => !existing.has(item.id) && item.text.trim().length > 0,
  );

  if (pending.length === 0) {
    log.info("all items already have text embeddings");
    return;
  }

  log.info(`embedding ${pending.length} texts (${existing.size} already done)`);

  const extractor = await getTextExtractor();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO text_embeddings (id, embedding, model) VALUES (?, ?, ?)",
  );

  for (let i = 0; i < pending.length; i++) {
    const { id, text } = pending[i];
    try {
      const output = await extractor(text.slice(0, 512), {
        pooling: "mean",
        normalize: true,
      });
      const embedding = Buffer.from(output.data.buffer as ArrayBuffer);
      insert.run(id, embedding, "all-MiniLM-L6-v2");

      if ((i + 1) % 100 === 0) {
        log.info(`text embeddings: ${i + 1}/${pending.length}`);
      }
    } catch (e) {
      log.warn(`failed to embed text ${id}: ${e}`);
    }
  }

  log.info(`done embedding ${pending.length} texts`);
};

const generateEmbeddings = async ({ db, items }: EmbedOptions) => {
  await generateImageEmbeddings(db, items);
  await generateTextEmbeddings(db, items);
};

interface Embeddings {
  image: Map<string, Float32Array>;
  text: Map<string, Float32Array>;
}

const loadTable = (
  dbPath: string,
  table: string,
): Map<string, Float32Array> => {
  const result = new Map<string, Float32Array>();
  if (!fs.existsSync(dbPath)) return result;

  const BetterSqlite3 = require("better-sqlite3");
  const db = new BetterSqlite3(dbPath, { readonly: true });

  let rows: { id: string; embedding: Buffer }[];
  try {
    rows = db.prepare(`SELECT id, embedding FROM ${table}`).all() as any[];
  } catch {
    db.close();
    return result;
  }

  for (const row of rows) {
    result.set(
      row.id,
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    );
  }

  db.close();
  return result;
};

const loadEmbeddings = (dbPath: string): Embeddings => ({
  image: loadTable(dbPath, "embeddings"),
  text: loadTable(dbPath, "text_embeddings"),
});

const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export { generateEmbeddings, loadEmbeddings, cosineSimilarity };
export type { Embeddings, EmbedItem };
