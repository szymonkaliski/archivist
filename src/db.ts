import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths";
import { createLogger } from "./logger";
import { SOURCES } from "./sources/registry";

const log = createLogger("db");

type Migration = (db: Database.Database) => void;

const buildInitialSchema = (): string => {
  const parts: string[] = [];
  for (const source of Object.values(SOURCES)) {
    parts.push(...source.setupStatements);
  }
  parts.push(`
    CREATE TABLE IF NOT EXISTS embeddings (
      global_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'dinov2-base'
    )
  `);
  parts.push(`
    CREATE TABLE IF NOT EXISTS text_embeddings (
      global_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2'
    )
  `);
  return parts.map((s) => s.trim()).join(";\n") + ";";
};

const migrations: Migration[] = [
  (db) => {
    db.exec(buildInitialSchema());
  },
  (db) => {
    const arena = SOURCES.arena;
    for (const stmt of arena.setupStatements) {
      db.exec(stmt);
    }
  },
];

const runMigrations = (db: Database.Database) => {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      migrations[i](db);
      db.pragma(`user_version = ${i + 1}`);
    })();
    log.info(`applied migration ${i + 1}`);
  }
};

export const openDb = (): Database.Database => {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return db;
};
