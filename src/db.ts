import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths";
import { SOURCES } from "./sources/registry";
import type { SourceDefinition } from "./types";

const sourceSetupStatements = (source: SourceDefinition): string[] => {
  const table = source.dataTable;
  const fts = source.ftsTable;
  const cols = source.ftsColumns.join(", ");
  const newVals = source.ftsColumns.map((c) => `new.${c}`).join(", ");
  const oldVals = source.ftsColumns.map((c) => `old.${c}`).join(", ");
  const coverCols = source.tagSpec
    ? `${source.timeColumn} DESC, global_id, ${source.tagSpec.column}`
    : `${source.timeColumn} DESC, global_id`;

  return [
    source.tableSql,
    `CREATE INDEX IF NOT EXISTS idx_${table}_time_cover ON ${table}(${coverCols})`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts}
     USING FTS5(${cols}, content='${table}', content_rowid='rowid', prefix='1 2 3')`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_insert AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.rowid, ${newVals});
    END`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_delete AFTER DELETE ON ${table} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldVals});
    END`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_update AFTER UPDATE OF ${cols} ON ${table} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldVals});
      INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.rowid, ${newVals});
    END`,
  ];
};

// External-content FTS5 tables reference each source table's implicit rowid,
// so any manual VACUUM on data.db must be followed by an FTS5 'rebuild'.
const buildSchema = (): string => {
  const parts: string[] = [];
  for (const source of Object.values(SOURCES)) {
    parts.push(...sourceSetupStatements(source));
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

export const openDb = (
  dbPath: string = DB_PATH,
  options?: { readonly?: boolean },
): Database.Database => {
  const readonly = Boolean(options?.readonly);
  if (!readonly && dbPath === DB_PATH) {
    ensureDirs();
  }
  const db = new Database(dbPath, readonly ? { readonly: true } : undefined);
  db.pragma("mmap_size = 268435456");
  db.pragma("cache_size = -65536");
  db.pragma("temp_store = MEMORY");
  db.pragma("busy_timeout = 15000");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("recursive_triggers = ON");
    db.exec(buildSchema());
  }
  return db;
};
