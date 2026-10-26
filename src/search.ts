import type Database from "better-sqlite3";

import { SOURCES } from "./sources/registry";
import type { SearchResult, SourceKind } from "./types";
import type { VecIndex } from "./vec-index";

const RRF_K = 60;
const ALL_SOURCES: SourceKind[] = [
  "pinboard",
  "pinterest",
  "screenshot",
  "arena",
];

const SOURCE_META: Record<
  SourceKind,
  { table: string; fts: string; timeCol: string; selectCols: string }
> = {
  pinboard: {
    table: "pinboard",
    fts: "pinboard_fts",
    timeCol: "time",
    // fulltext holds megabytes of frozen-page prose and is only used by the
    // FTS5 trigger; omitting it here avoids faulting overflow pages on read.
    selectCols:
      "global_id, href, hash, meta, description, extended, tags, time, screenshot, frozen",
  },
  pinterest: {
    table: "pinterest",
    fts: "pinterest_fts",
    timeCol: "createdat",
    selectCols: "*",
  },
  screenshot: {
    table: "screenshot",
    fts: "screenshot_fts",
    timeCol: "time",
    selectCols: "*",
  },
  arena: {
    table: "arena",
    fts: "arena_fts",
    timeCol: "connected_at",
    selectCols: "*",
  },
};

export interface SearchOptions {
  text?: string;
  sources?: SourceKind[];
  tags?: string[];
  before?: string;
  after?: string;
  limit: number;
  offset: number;
}

interface RankedRow {
  global_id: string;
}

export const ftsQuoteTerms = (input: string): string =>
  input
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"*`)
    .join(" OR ");

const buildSourceFragment = (
  kind: SourceKind,
  options: SearchOptions,
  params: Record<string, any>,
  mode: "browse" | "fts",
): string | null => {
  const { table, fts, timeCol } = SOURCE_META[kind];
  const wheres: string[] = [];

  if (options.tags && options.tags.length > 0) {
    if (kind === "pinboard") {
      const clauses = options.tags.map((tag, i) => {
        const key = `tag_pb_${i}`;
        params[key] = `% ${tag} %`;
        return `(' ' || ${table}.tags || ' ') LIKE :${key}`;
      });
      wheres.push(`(${clauses.join(" OR ")})`);
    } else if (kind === "pinterest") {
      const clauses = options.tags.map((tag, i) => {
        const key = `tag_pi_${i}`;
        params[key] = tag;
        return `${table}.board = :${key}`;
      });
      wheres.push(`(${clauses.join(" OR ")})`);
    } else if (kind === "arena") {
      const clauses = options.tags.map((tag, i) => {
        const key = `tag_ar_${i}`;
        params[key] = `%\t${tag}\t%`;
        return `('\t' || ${table}.channels || '\t') LIKE :${key}`;
      });
      wheres.push(`(${clauses.join(" OR ")})`);
    } else {
      return null;
    }
  }

  if (options.before) {
    params.before = options.before;
    wheres.push(`${table}.${timeCol} < :before`);
  }
  if (options.after) {
    params.after = options.after;
    wheres.push(`${table}.${timeCol} >= :after`);
  }

  if (mode === "browse") {
    const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    return `SELECT ${table}.global_id, ${table}.${timeCol} AS sort_time FROM ${table} ${where}`;
  }

  const ftsWhere = wheres.length > 0 ? `AND ${wheres.join(" AND ")}` : "";
  return `SELECT ${table}.global_id, ${table}.${timeCol} AS sort_time FROM ${fts} JOIN ${table} ON ${fts}.global_id = ${table}.global_id WHERE ${fts} MATCH :query ${ftsWhere}`;
};

const resolveRows = (
  db: Database.Database,
  rankedIds: RankedRow[],
): SearchResult[] => {
  if (rankedIds.length === 0) return [];

  const idsBySource = new Map<SourceKind, string[]>();
  for (const { global_id } of rankedIds) {
    const [source] = global_id.split(":");
    const kind = source as SourceKind;
    if (!idsBySource.has(kind)) idsBySource.set(kind, []);
    idsBySource.get(kind)!.push(global_id);
  }

  const rowMap = new Map<string, SearchResult>();
  for (const [kind, ids] of idsBySource) {
    const source = SOURCES[kind];
    const { selectCols } = SOURCE_META[kind];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT ${selectCols} FROM ${source.dataTable} WHERE global_id IN (${placeholders})`,
      )
      .all(...ids) as Record<string, unknown>[];

    for (const row of rows) {
      const result = source.toSearchResult(row);
      rowMap.set(result.id, result);
    }
  }

  return rankedIds
    .map(({ global_id }) => rowMap.get(global_id)!)
    .filter(Boolean);
};

// COUNT(*) OVER() would force the whole UNION to be materialized just to label
// each of the LIMIT rows, so the total is counted separately. This also keeps
// the total correct when an offset lands past the end and no rows come back.
const runPagedQuery = (
  db: Database.Database,
  unionSql: string,
  params: Record<string, any>,
  options: SearchOptions,
): { items: SearchResult[]; total: number } => {
  // A bare compound UNION ALL lets SQLite merge-walk the per-table time indexes.
  const rows = db
    .prepare(
      `${unionSql}
       ORDER BY sort_time DESC
       LIMIT :limit OFFSET :offset`,
    )
    .all({
      ...params,
      limit: options.limit,
      offset: options.offset,
    }) as RankedRow[];

  const { total } = db
    .prepare(
      `WITH matched AS (${unionSql}) SELECT COUNT(*) AS total FROM matched`,
    )
    .get(params) as { total: number };

  return { items: resolveRows(db, rows), total };
};

export const search = (
  db: Database.Database,
  options: SearchOptions,
): { items: SearchResult[]; total: number } => {
  const activeSources = options.sources?.length ? options.sources : ALL_SOURCES;

  const params: Record<string, any> = {};

  if (options.text) {
    const ftsQuery = ftsQuoteTerms(options.text);
    if (ftsQuery.length === 0) return { items: [], total: 0 };
    params.query = ftsQuery;

    const parts = activeSources
      .map((kind) => buildSourceFragment(kind, options, params, "fts"))
      .filter(Boolean);
    if (parts.length === 0) return { items: [], total: 0 };

    return runPagedQuery(
      db,
      parts.join("\n        UNION ALL\n        "),
      params,
      options,
    );
  }

  const parts = activeSources
    .map((kind) => buildSourceFragment(kind, options, params, "browse"))
    .filter(Boolean);
  if (parts.length === 0) return { items: [], total: 0 };

  return runPagedQuery(
    db,
    parts.join("\n      UNION ALL\n      "),
    params,
    options,
  );
};

const findSimilarIds = (
  db: Database.Database,
  vecIndex: VecIndex,
  targetId: string,
  options: SearchOptions,
): { pageIds: string[]; total: number } => {
  const embs = db
    .prepare(
      `SELECT
         (SELECT embedding FROM embeddings WHERE global_id = :id) AS img,
         (SELECT embedding FROM text_embeddings WHERE global_id = :id) AS txt`,
    )
    .get({ id: targetId }) as { img: Buffer | null; txt: Buffer | null };
  if (!embs.img && !embs.txt) return { pageIds: [], total: 0 };

  const K = 500;

  const imgResults = embs.img
    ? vecIndex.searchImage(embs.img, K + 1).filter((id) => id !== targetId)
    : [];
  const txtResults = embs.txt
    ? vecIndex.searchText(embs.txt, K + 1).filter((id) => id !== targetId)
    : [];

  const scores = new Map<string, number>();
  for (let i = 0; i < imgResults.length; i++) {
    scores.set(
      imgResults[i],
      (scores.get(imgResults[i]) ?? 0) + 1 / (RRF_K + i + 1),
    );
  }
  for (let i = 0; i < txtResults.length; i++) {
    scores.set(
      txtResults[i],
      (scores.get(txtResults[i]) ?? 0) + 1 / (RRF_K + i + 1),
    );
  }

  let ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  if (options.sources?.length) {
    const prefixes = options.sources.map((s) => `${s}:`);
    ranked = ranked.filter(([id]) => prefixes.some((p) => id.startsWith(p)));
  }

  const activeSources = options.sources?.length ? options.sources : ALL_SOURCES;
  if (options.tags?.length || options.before || options.after) {
    const params: Record<string, any> = {};
    const parts = activeSources
      .map((kind) => buildSourceFragment(kind, options, params, "browse"))
      .filter(Boolean);
    if (parts.length === 0) return { pageIds: [], total: 0 };

    const sql = parts.join(" UNION ALL ");
    const eligible = new Set(
      (db.prepare(sql).all(params) as { global_id: string }[]).map(
        (r) => r.global_id,
      ),
    );
    ranked = ranked.filter(([id]) => eligible.has(id));
  }

  const total = ranked.length;
  const pageIds = ranked
    .slice(options.offset, options.offset + options.limit)
    .map(([global_id]) => global_id);

  return { pageIds, total };
};

export const findSimilar = (
  db: Database.Database,
  vecIndex: VecIndex,
  targetId: string,
  options: SearchOptions,
): { item: SearchResult | null; items: SearchResult[]; total: number } => {
  const [sourcePrefix] = targetId.split(":");
  if (!SOURCES[sourcePrefix as SourceKind]) {
    return { item: null, items: [], total: 0 };
  }

  const { pageIds, total } = findSimilarIds(db, vecIndex, targetId, options);
  const resolved = resolveRows(
    db,
    [targetId, ...pageIds].map((global_id) => ({ global_id })),
  );
  if (resolved.length === 0 || resolved[0].id !== targetId) {
    return { item: null, items: [], total: 0 };
  }

  return { item: resolved[0], items: resolved.slice(1), total };
};
