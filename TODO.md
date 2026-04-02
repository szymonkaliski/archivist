# Archivist: Consolidate Plugin Architecture into Unified Codebase

## Context

The archivist project currently uses a plugin architecture where each data source (pinboard, pinterest, screenshot) is a separate npm package with its own SQLite database, FTS5 index, embedding tables, fetch logic, and query interface. The CLI and web UI dynamically discover and load plugins at runtime via `require(name)`.

This creates unnecessary complexity:
- Dynamic `require()` plugin loading with runtime discovery
- Each plugin has its own DB, so the web UI must aggregate queries, merge embedding maps, and rank across plugins in JS
- Duplicate boilerplate: every plugin repeats SQLite setup, FTS5 triggers, thumbnail generation, embedding generation calls
- The web UI builds an **in-memory BM25 index** (`wink-bm25-text-search`) separate from SQLite's built-in FTS5 BM25, loads all embeddings into JS `Map`s, and computes cosine similarity in JS loops

**Goal**: Single codebase, single DB, all sources always-on via config, with search/ranking pushed into SQLite (FTS5 `bm25()` + `sqlite-vec` for vector KNN + RRF in SQL).

## Progress

### Phase 1: Foundation
- [x] `src/types.ts` — SourceKind, SourceConfig, SearchResult, SourceDefinition
- [x] `src/logger.ts` — inline pino (~15 lines)
- [x] `src/paths.ts` — env-paths for data dir
- [x] `src/config.ts` — load/validate config
- [x] `src/db.ts` — open DB, load sqlite-vec, run migrations via `PRAGMA user_version`
- [x] `package.json` — single package, ESM, all deps unified + latest versions via ncu
- [x] `tsconfig.json` — bundler moduleResolution (extensionless imports)
- [x] `tsup.config.ts` — builds to dist/, node can run output directly
- [x] `src/sources/registry.ts` — skeleton for source registration

### Phase 2: Port Sources
- [x] `src/sources/pinboard/index.ts` — SourceDefinition + fetch logic
- [x] `src/sources/pinboard/fetcher.ts` — puppeteer screenshot + freeze-dry
- [x] `src/sources/pinterest/index.ts` — SourceDefinition + fetch/download logic
- [x] `src/sources/pinterest/crawler.ts` — puppeteer crawl (replaced lodash chain with native JS)
- [x] `src/sources/screenshot/index.ts` — SourceDefinition + fetch logic
- [x] `src/sources/registry.ts` — all three registered

### Phase 3: Embeddings
- [x] `src/embeddings.ts` — port generation, writes to both blob + vec0 tables, syncVecTables()

### Phase 4: Search
- [x] `src/search.ts` — FTS5 UNION + sqlite-vec KNN + RRF CTEs, search() + findSimilar()

### Phase 5: Entry Points
- [x] `src/cli/index.ts` — yargs with fetch, search, config
- [x] `src/server/index.ts` — Express server with /api/search, /api/sources, /img, /html, query parsing
- [x] Move `web/` directory for Vite frontend (copied from archivist-web-ui, added root to vite config, separate tsconfig for jsx)

### Phase 6: Migration & Swap
- [x] Write ad-hoc `tmp/migrate.ts`
- [ ] Run migration, test
- [ ] Merge branch, cleanup

---

## Plan Details

### Directory Structure

```
archivist/
  package.json                # single package, all deps unified
  tsconfig.json
  src/
    types.ts                  # SourceKind union, SourceConfig, SearchResult, SourceDefinition
    logger.ts                 # inline pino setup (~15 lines)
    paths.ts                  # env-paths for unified data dir + per-source asset dirs
    config.ts                 # load/validate config
    db.ts                     # open single DB, load sqlite-vec, run migrations
    embeddings.ts             # DINOv2 + MiniLM generation, writes to blob + vec0 tables
    search.ts                 # unified FTS5 + sqlite-vec + RRF search — all in SQL
    sources/
      registry.ts             # static imports of all sources, exports SOURCES map
      pinboard/
        index.ts              # SourceDefinition: schema, fetch(), toSearchResult()
        fetcher.ts            # puppeteer screenshot + freeze-dry
      pinterest/
        index.ts              # SourceDefinition
        crawler.ts            # puppeteer crawl
      screenshot/
        index.ts              # SourceDefinition
    cli/
      index.ts                # yargs: fetch, search, config
    server/
      index.ts                # express server entry point
      routes.ts               # API routes
  web/                        # React frontend (largely unchanged)
    index.html
    vite.config.ts
    src/
      App.tsx, Grid.tsx, Cell.tsx, Detail.tsx, SearchBar.tsx, api.ts, types.ts, styles.css
```

### Database Schema & Migrations

Single DB at `~/.local/share/archivist/data.db`.

Schema migrations via DIY `PRAGMA user_version` (~20 lines, zero deps):
- Migrations are an ordered array of `(db) => void` functions in `src/db.ts`
- Run on every DB open — skips already-applied, runs pending in a transaction
- Future schema changes just append a new migration function

Global ID strategy: prefixed strings — `"pinboard:<hash>"`, `"pinterest:<pinid>"`, `"screenshot:<md5>"`

#### Migration v1: Initial schema

Source data tables (separate per source, same DB):

```sql
CREATE TABLE pinboard (
  global_id TEXT PRIMARY KEY,
  href TEXT, hash TEXT NOT NULL UNIQUE, meta TEXT, description TEXT,
  extended TEXT, tags TEXT, time DATETIME,
  screenshot TEXT, frozen TEXT, fulltext TEXT
);

CREATE TABLE pinterest (
  global_id TEXT PRIMARY KEY,
  board TEXT, filename TEXT, title TEXT, text TEXT, link TEXT, pinurl TEXT,
  pinid TEXT NOT NULL UNIQUE, crawldate DATETIME, createdat DATETIME,
  width INTEGER, height INTEGER
);

CREATE TABLE screenshot (
  global_id TEXT PRIMARY KEY,
  filepath TEXT NOT NULL UNIQUE, filename TEXT, time TEXT,
  width INTEGER, height INTEGER, link TEXT, note TEXT
);
```

FTS5 tables (UNIONed in search):

```sql
CREATE VIRTUAL TABLE pinboard_fts USING FTS5(global_id, href, meta, description, extended, tags, fulltext);
CREATE VIRTUAL TABLE pinterest_fts USING FTS5(global_id, board, link, title, text);
CREATE VIRTUAL TABLE screenshot_fts USING FTS5(global_id, filepath, filename, link, note);
```

Unified embeddings + sqlite-vec:

```sql
CREATE TABLE embeddings (global_id TEXT PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'dinov2-base');
CREATE TABLE text_embeddings (global_id TEXT PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2');
CREATE VIRTUAL TABLE vec_image USING vec0(global_id TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine);
CREATE VIRTUAL TABLE vec_text USING vec0(global_id TEXT PRIMARY KEY, embedding float[384] distance_metric=cosine);
```

### Search: The Big Simplification

Replaces: `ranking.ts` (158 lines), in-memory BM25 index, JS cosine similarity loops, `wink-bm25-text-search`, `wink-nlp-utils`.

FTS5 with native bm25(), sqlite-vec KNN, RRF fusion — all in SQL CTEs.

### Config Format

Record keyed by SourceKind:

```json
{
  "pinboard": { "apiKey": "user:XXXXX" },
  "pinterest": { "profile": "username", "loginMethod": "cookies" },
  "screenshot": { "directory": "/path/to/screenshots" }
}
```

### Asset Directories

```
~/.local/share/archivist/
  data.db
  pinboard/   (assets/, frozen/, thumbs/)
  pinterest/  (assets/, thumbs/)
  screenshot/ (thumbs/)
```

Screenshot source images stay in user-configured directory (Dropbox). Only thumbs/DB move.

### Migration (ad-hoc `tmp/migrate.ts`, deleted after use)

1. Backup old data dirs
2. Create unified DB, run setup statements
3. ATTACH old DBs, copy rows with global_id prefixes
4. mv old asset dirs into unified layout
5. Rebuild FTS5, sync vec0
6. Test
7. Manual cleanup with confirmation
