import type Database from "better-sqlite3";

import { SOURCES } from "./sources/registry";
import type { SearchResult, SourceKind } from "./types";

const RRF_K = 60;
const ALL_SOURCES: SourceKind[] = ["pinboard", "pinterest", "screenshot"];

const SOURCE_META: Record<
  SourceKind,
  { table: string; fts: string; timeCol: string }
> = {
  pinboard: { table: "pinboard", fts: "pinboard_fts", timeCol: "time" },
  pinterest: { table: "pinterest", fts: "pinterest_fts", timeCol: "createdat" },
  screenshot: { table: "screenshot", fts: "screenshot_fts", timeCol: "time" },
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
  total: number;
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
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT * FROM ${source.dataTable} WHERE global_id IN (${placeholders})`,
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

    const sql = `
      WITH fts_results AS (
        ${parts.join("\n        UNION ALL\n        ")}
      )
      SELECT global_id, COUNT(*) OVER() AS total
      FROM fts_results
      ORDER BY sort_time DESC
      LIMIT :limit OFFSET :offset
    `;
    params.limit = options.limit;
    params.offset = options.offset;

    const rows = db.prepare(sql).all(params) as RankedRow[];
    return { items: resolveRows(db, rows), total: rows[0]?.total ?? 0 };
  }

  const parts = activeSources
    .map((kind) => buildSourceFragment(kind, options, params, "browse"))
    .filter(Boolean);
  if (parts.length === 0) return { items: [], total: 0 };

  const sql = `
    WITH filtered AS (
      ${parts.join("\n      UNION ALL\n      ")}
    )
    SELECT global_id, COUNT(*) OVER() AS total
    FROM filtered
    ORDER BY sort_time DESC
    LIMIT :limit OFFSET :offset
  `;
  params.limit = options.limit;
  params.offset = options.offset;

  const rows = db.prepare(sql).all(params) as RankedRow[];
  return { items: resolveRows(db, rows), total: rows[0]?.total ?? 0 };
};

export const findSimilar = (
  db: Database.Database,
  targetId: string,
  options: SearchOptions,
): { item: SearchResult | null; items: SearchResult[]; total: number } => {
  const [sourcePrefix] = targetId.split(":");
  const targetSource = SOURCES[sourcePrefix as SourceKind];
  if (!targetSource) return { item: null, items: [], total: 0 };

  const targetRow = db
    .prepare(`SELECT * FROM ${targetSource.dataTable} WHERE global_id = ?`)
    .get(targetId) as Record<string, unknown> | undefined;
  if (!targetRow) return { item: null, items: [], total: 0 };

  const item = targetSource.toSearchResult(targetRow);

  const hasImg = db
    .prepare("SELECT 1 FROM vec_image WHERE global_id = ?")
    .get(targetId);
  const hasTxt = db
    .prepare("SELECT 1 FROM vec_text WHERE global_id = ?")
    .get(targetId);
  if (!hasImg && !hasTxt) return { item, items: [], total: 0 };

  const activeSources = options.sources?.length ? options.sources : ALL_SOURCES;

  const params: Record<string, any> = { target_id: targetId, k: 500 };

  const sourceWheres: string[] = [];
  if (options.sources?.length) {
    const clauses = options.sources.map((s, i) => {
      params[`src_${i}`] = `${s}:%`;
      return `r.global_id LIKE :src_${i}`;
    });
    sourceWheres.push(`(${clauses.join(" OR ")})`);
  }

  const needsDataJoin = !!(
    options.tags?.length ||
    options.before ||
    options.after
  );
  let filterCTE = "";
  let filterJoin = "";

  if (needsDataJoin) {
    const filterParams: Record<string, any> = {};
    const eligibleParts = activeSources
      .map((kind) => buildSourceFragment(kind, options, filterParams, "browse"))
      .filter(Boolean);

    Object.assign(params, filterParams);
    if (eligibleParts.length === 0) return { item, items: [], total: 0 };

    filterCTE = `,\n    eligible AS (\n      ${eligibleParts.join("\n      UNION ALL\n      ")}\n    )`;
    filterJoin = "JOIN eligible e ON r.global_id = e.global_id";
  }

  const filterWhere =
    sourceWheres.length > 0 ? `WHERE ${sourceWheres.join(" AND ")}` : "";

  const knnCTEs: string[] = [];
  const candidateParts: string[] = [];
  const rrfScoreParts: string[] = [];
  const rrfJoins: string[] = [];

  if (hasImg) {
    knnCTEs.push(`img_knn AS (
      SELECT global_id, ROW_NUMBER() OVER (ORDER BY distance) AS rank
      FROM vec_image
      WHERE embedding MATCH (SELECT embedding FROM vec_image WHERE global_id = :target_id)
        AND k = :k AND global_id != :target_id
    )`);
    candidateParts.push("SELECT global_id FROM img_knn");
    rrfScoreParts.push(`COALESCE(1.0 / (${RRF_K} + i.rank), 0)`);
    rrfJoins.push("LEFT JOIN img_knn i ON a.global_id = i.global_id");
  }

  if (hasTxt) {
    knnCTEs.push(`txt_knn AS (
      SELECT global_id, ROW_NUMBER() OVER (ORDER BY distance) AS rank
      FROM vec_text
      WHERE embedding MATCH (SELECT embedding FROM vec_text WHERE global_id = :target_id)
        AND k = :k AND global_id != :target_id
    )`);
    candidateParts.push("SELECT global_id FROM txt_knn");
    rrfScoreParts.push(`COALESCE(1.0 / (${RRF_K} + t.rank), 0)`);
    rrfJoins.push("LEFT JOIN txt_knn t ON a.global_id = t.global_id");
  }

  const sql = `
    WITH
    ${knnCTEs.join(",\n    ")},
    all_candidates AS (
      ${candidateParts.join(" UNION\n      ")}
    ),
    rrf AS (
      SELECT a.global_id,
        ${rrfScoreParts.join(" +\n        ")} AS rrf_score
      FROM all_candidates a
      ${rrfJoins.join("\n      ")}
    )${filterCTE}
    SELECT r.global_id, COUNT(*) OVER() AS total
    FROM rrf r
    ${filterJoin}
    ${filterWhere}
    ORDER BY r.rrf_score DESC
    LIMIT :limit OFFSET :offset
  `;

  params.limit = options.limit;
  params.offset = options.offset;

  const rows = db.prepare(sql).all(params) as RankedRow[];
  return { item, items: resolveRows(db, rows), total: rows[0]?.total ?? 0 };
};
