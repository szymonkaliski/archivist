import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import type { SourceKind } from "./types";

const paths = envPaths("archivist", { suffix: "" });

export const DATA_DIR = paths.data;
export const CONFIG_DIR = paths.config;
export const CACHE_DIR = paths.cache;

export const DB_PATH = path.join(DATA_DIR, "data.db");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const MODEL_CACHE_DIR = path.join(CACHE_DIR, "models");

export const sourceDir = (source: SourceKind): string =>
  path.join(DATA_DIR, source);

export const sourceAssetsDir = (source: SourceKind): string =>
  path.join(DATA_DIR, source, "assets");

export const sourceThumbsDir = (source: SourceKind): string =>
  path.join(DATA_DIR, source, "thumbs");

export const sourceFrozenDir = (source: SourceKind): string =>
  path.join(DATA_DIR, source, "frozen");

export const sourceSessionDir = (source: SourceKind): string =>
  path.join(DATA_DIR, source, "session");

export const ensureDirs = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
};
