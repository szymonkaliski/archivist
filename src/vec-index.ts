import fs from "fs";
import path from "path";
import { Index, MetricKind, ScalarKind } from "usearch";
import type Database from "better-sqlite3";

import { DATA_DIR } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("vec-index");

const IMAGE_INDEX_PATH = path.join(DATA_DIR, "vec_image.usearch");
const TEXT_INDEX_PATH = path.join(DATA_DIR, "vec_text.usearch");
const META_PATH = path.join(DATA_DIR, "vec_index_meta.json");

const IMAGE_DIMS = 768;
const TEXT_DIMS = 384;

interface IndexMeta {
  image: string[];
  text: string[];
}

export interface VecIndex {
  hasImage(id: string): boolean;
  hasText(id: string): boolean;
  searchImage(embedding: Buffer, k: number): string[];
  searchText(embedding: Buffer, k: number): string[];
}

const createUsearchIndex = (dims: number): Index =>
  new Index({
    dimensions: dims,
    metric: MetricKind.Cos,
    quantization: ScalarKind.F32,
    connectivity: 16,
    expansion_add: 128,
    expansion_search: 64,
    multi: false,
  });

export const buildAndSave = (db: Database.Database): void => {
  const imgRows = db
    .prepare("SELECT global_id, embedding FROM embeddings")
    .all() as { global_id: string; embedding: Buffer }[];
  const txtRows = db
    .prepare("SELECT global_id, embedding FROM text_embeddings")
    .all() as { global_id: string; embedding: Buffer }[];

  log.info(
    `building vec index: ${imgRows.length} image, ${txtRows.length} text`,
  );

  const imgIndex = createUsearchIndex(IMAGE_DIMS);
  const imgIds: string[] = [];
  for (let i = 0; i < imgRows.length; i++) {
    const vec = new Float32Array(
      imgRows[i].embedding.buffer,
      imgRows[i].embedding.byteOffset,
      IMAGE_DIMS,
    );
    imgIndex.add(BigInt(i), vec);
    imgIds.push(imgRows[i].global_id);
  }

  const txtIndex = createUsearchIndex(TEXT_DIMS);
  const txtIds: string[] = [];
  for (let i = 0; i < txtRows.length; i++) {
    const vec = new Float32Array(
      txtRows[i].embedding.buffer,
      txtRows[i].embedding.byteOffset,
      TEXT_DIMS,
    );
    txtIndex.add(BigInt(i), vec);
    txtIds.push(txtRows[i].global_id);
  }

  const meta: IndexMeta = { image: imgIds, text: txtIds };

  imgIndex.save(IMAGE_INDEX_PATH + ".tmp");
  txtIndex.save(TEXT_INDEX_PATH + ".tmp");
  fs.writeFileSync(META_PATH + ".tmp", JSON.stringify(meta));

  fs.renameSync(IMAGE_INDEX_PATH + ".tmp", IMAGE_INDEX_PATH);
  fs.renameSync(TEXT_INDEX_PATH + ".tmp", TEXT_INDEX_PATH);
  fs.renameSync(META_PATH + ".tmp", META_PATH);

  log.info("vec index saved to disk");
};

let cached: { index: VecIndex; mtime: number } | null = null;

export const loadCached = (): VecIndex | null => {
  if (
    !fs.existsSync(IMAGE_INDEX_PATH) ||
    !fs.existsSync(TEXT_INDEX_PATH) ||
    !fs.existsSync(META_PATH)
  ) {
    return cached?.index ?? null;
  }

  const mtime = Math.max(
    fs.statSync(IMAGE_INDEX_PATH).mtimeMs,
    fs.statSync(TEXT_INDEX_PATH).mtimeMs,
    fs.statSync(META_PATH).mtimeMs,
  );

  if (cached && cached.mtime === mtime) {
    return cached.index;
  }

  log.info("loading vec index from disk...");

  const meta: IndexMeta = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));

  const imgIndex = createUsearchIndex(IMAGE_DIMS);
  imgIndex.load(IMAGE_INDEX_PATH);

  const txtIndex = createUsearchIndex(TEXT_DIMS);
  txtIndex.load(TEXT_INDEX_PATH);

  const imgIdSet = new Set(meta.image);
  const txtIdSet = new Set(meta.text);

  const index: VecIndex = {
    hasImage: (id) => imgIdSet.has(id),
    hasText: (id) => txtIdSet.has(id),

    searchImage(embedding, k) {
      const vec = new Float32Array(
        embedding.buffer,
        embedding.byteOffset,
        IMAGE_DIMS,
      );
      const results = imgIndex.search(vec, k, 0);
      const ids: string[] = [];
      for (let i = 0; i < results.keys.length; i++) {
        ids.push(meta.image[Number(results.keys[i])]);
      }
      return ids;
    },

    searchText(embedding, k) {
      const vec = new Float32Array(
        embedding.buffer,
        embedding.byteOffset,
        TEXT_DIMS,
      );
      const results = txtIndex.search(vec, k, 0);
      const ids: string[] = [];
      for (let i = 0; i < results.keys.length; i++) {
        ids.push(meta.text[Number(results.keys[i])]);
      }
      return ids;
    },
  };

  cached = { index, mtime };
  log.info(
    `vec index loaded: ${meta.image.length} image, ${meta.text.length} text`,
  );

  return index;
};
