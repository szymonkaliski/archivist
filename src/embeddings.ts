import type Database from "better-sqlite3";
import fs from "fs";
import sharp from "sharp";

import { createLogger } from "./logger";
import { MODEL_CACHE_DIR } from "./paths";

const log = createLogger("embeddings");

const IMAGE_MODEL_ID = "onnx-community/dinov2-base";
const TEXT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const IMAGE_SIZE = 224;
const DINO_DIMS = 768;

const GLOBAL_IMG = "__archivist_clip_img__";
const GLOBAL_TEXT_PIPE = "__archivist_text_pipe__";
const GLOBAL_LOCK = "__archivist_clip_lock__";
const GLOBAL_TEXT_LOCK = "__archivist_text_lock__";

const ensureCache = () => fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });

const getImageExtractor = async () => {
  if ((globalThis as any)[GLOBAL_IMG]) return (globalThis as any)[GLOBAL_IMG];
  if ((globalThis as any)[GLOBAL_LOCK]) return (globalThis as any)[GLOBAL_LOCK];

  const loading = (async () => {
    ensureCache();
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = MODEL_CACHE_DIR;

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
    env.cacheDir = MODEL_CACHE_DIR;

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

export interface EmbedItem {
  id: string;
  thumbPath: string;
  text: string;
}

const generateImageEmbeddings = async (
  db: Database.Database,
  items: EmbedItem[],
) => {
  const stale = (
    db
      .prepare("SELECT COUNT(*) as c FROM embeddings WHERE model != ?")
      .get("dinov2-base") as { c: number }
  ).c;
  if (stale > 0) {
    log.info(`clearing ${stale} stale image embeddings (model changed)`);
    db.prepare("DELETE FROM embeddings").run();
    db.prepare("DELETE FROM vec_image WHERE true").run();
  }

  const existing = new Set(
    (db.prepare("SELECT global_id FROM embeddings").all() as { global_id: string }[]).map(
      (r) => r.global_id,
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
  const insertBlob = db.prepare(
    "INSERT OR IGNORE INTO embeddings (global_id, embedding, model) VALUES (?, ?, ?)",
  );
  const insertVec = db.prepare(
    "INSERT OR IGNORE INTO vec_image (global_id, embedding) VALUES (?, ?)",
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
      insertBlob.run(id, embedding, "dinov2-base");
      insertVec.run(id, embedding);

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
  const stale = (
    db
      .prepare("SELECT COUNT(*) as c FROM text_embeddings WHERE model != ?")
      .get("all-MiniLM-L6-v2") as { c: number }
  ).c;
  if (stale > 0) {
    log.info(`clearing ${stale} stale text embeddings (model changed)`);
    db.prepare("DELETE FROM text_embeddings").run();
    db.prepare("DELETE FROM vec_text WHERE true").run();
  }

  const existing = new Set(
    (
      db.prepare("SELECT global_id FROM text_embeddings").all() as { global_id: string }[]
    ).map((r) => r.global_id),
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
  const insertBlob = db.prepare(
    "INSERT OR IGNORE INTO text_embeddings (global_id, embedding, model) VALUES (?, ?, ?)",
  );
  const insertVec = db.prepare(
    "INSERT OR IGNORE INTO vec_text (global_id, embedding) VALUES (?, ?)",
  );

  for (let i = 0; i < pending.length; i++) {
    const { id, text } = pending[i];
    try {
      const output = await extractor(text.slice(0, 512), {
        pooling: "mean",
        normalize: true,
      });
      const embedding = Buffer.from(output.data.buffer as ArrayBuffer);
      insertBlob.run(id, embedding, "all-MiniLM-L6-v2");
      insertVec.run(id, embedding);

      if ((i + 1) % 100 === 0) {
        log.info(`text embeddings: ${i + 1}/${pending.length}`);
      }
    } catch (e) {
      log.warn(`failed to embed text ${id}: ${e}`);
    }
  }

  log.info(`done embedding ${pending.length} texts`);
};

export const generateEmbeddings = async (
  db: Database.Database,
  items: EmbedItem[],
) => {
  await generateImageEmbeddings(db, items);
  await generateTextEmbeddings(db, items);
};

export const syncVecTables = (db: Database.Database) => {
  const imgCount = db.prepare(
    `INSERT OR IGNORE INTO vec_image (global_id, embedding)
     SELECT global_id, embedding FROM embeddings
     WHERE global_id NOT IN (SELECT global_id FROM vec_image)`,
  ).run().changes;

  const txtCount = db.prepare(
    `INSERT OR IGNORE INTO vec_text (global_id, embedding)
     SELECT global_id, embedding FROM text_embeddings
     WHERE global_id NOT IN (SELECT global_id FROM vec_text)`,
  ).run().changes;

  if (imgCount > 0 || txtCount > 0) {
    log.info(`synced vec tables: ${imgCount} image + ${txtCount} text`);
  }
};
