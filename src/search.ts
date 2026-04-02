import type Database from "better-sqlite3";

import { SOURCES } from "./sources/registry";
import type { SearchResult, SourceKind } from "./types";

const RRF_K = 60;

const buildFtsUnion = (sources: SourceKind[]): string =>
  sources
    .map(
      (kind) =>
        `SELECT global_id, bm25(${SOURCES[kind].ftsTable}) AS score FROM ${SOURCES[kind].ftsTable} WHERE ${SOURCES[kind].ftsTable} MATCH :query`,
    )
    .join("\n  UNION ALL\n  ");

const buildAllItemsUnion = (sources: SourceKind[]): string =>
  sources
    .map((kind) => `SELECT global_id, '${kind}' AS source FROM ${SOURCES[kind].dataTable}`)
    .join("\n  UNION ALL\n  ");

interface SearchOptions {
  text?: string;
  sources?: SourceKind[];
  tags?: string[];
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
}

const resolveRows = (
  db: Database.Database,
  rankedIds: { global_id: string }[],
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

  const ordered: SearchResult[] = [];
  for (const { global_id } of rankedIds) {
    const result = rowMap.get(global_id);
    if (result) ordered.push(result);
  }
  return ordered;
};

export const search = (
  db: Database.Database,
  options: SearchOptions,
): { items: SearchResult[]; total: number } => {
  const activeSources =
    options.sources && options.sources.length > 0
      ? options.sources
      : (Object.keys(SOURCES) as SourceKind[]);

  const limit = options.limit ?? 400;
  const offset = options.offset ?? 0;

  if (options.text) {
    const ftsQuery = `${options.text}*`;
    const ftsUnion = buildFtsUnion(activeSources);

    const sql = `
      WITH fts_results AS (
        ${ftsUnion}
      ),
      fts_ranked AS (
        SELECT global_id, ROW_NUMBER() OVER (ORDER BY score) AS rank
        FROM fts_results
      )
      SELECT global_id FROM fts_ranked
      ORDER BY rank ASC
    `;

    const allResults = db.prepare(sql).all({ query: ftsQuery }) as {
      global_id: string;
    }[];

    const total = allResults.length;
    const page = allResults.slice(offset, offset + limit);
    return { items: resolveRows(db, page), total };
  }

  // no text query — return all items sorted by time
  const allUnion = buildAllItemsUnion(activeSources);
  const timeCol = (kind: SourceKind): string => {
    if (kind === "pinterest") return "createdat";
    return "time";
  };

  const parts = activeSources.map(
    (kind) =>
      `SELECT global_id, ${timeCol(kind)} AS sort_time FROM ${SOURCES[kind].dataTable}`,
  );
  const sql = `
    WITH all_items AS (
      ${parts.join("\n      UNION ALL\n      ")}
    )
    SELECT global_id FROM all_items
    ORDER BY sort_time DESC
  `;

  const allResults = db.prepare(sql).all() as { global_id: string }[];
  const total = allResults.length;
  const page = allResults.slice(offset, offset + limit);
  return { items: resolveRows(db, page), total };
};

export const findSimilar = (
  db: Database.Database,
  targetId: string,
  options: SearchOptions = {},
): { item: SearchResult | null; items: SearchResult[]; total: number } => {
  const activeSources =
    options.sources && options.sources.length > 0
      ? options.sources
      : (Object.keys(SOURCES) as SourceKind[]);

  const limit = options.limit ?? 400;
  const offset = options.offset ?? 0;

  // find the target item
  const [sourcePrefix] = targetId.split(":");
  const targetSource = SOURCES[sourcePrefix as SourceKind];
  if (!targetSource) return { item: null, items: [], total: 0 };

  const targetRow = db
    .prepare(`SELECT * FROM ${targetSource.dataTable} WHERE global_id = ?`)
    .get(targetId) as Record<string, unknown> | undefined;

  if (!targetRow) return { item: null, items: [], total: 0 };

  const item = targetSource.toSearchResult(targetRow);

  // build text query from target item for FTS ranking
  const itemText = [
    item.meta?.title || "",
    item.meta?.note || "",
    ...(item.meta?.tags || []),
    item.link || "",
  ]
    .filter(Boolean)
    .join(" ");

  const hasFtsQuery = itemText.trim().length > 0;

  // build the RRF query
  const ftsUnion = buildFtsUnion(activeSources);

  const sql = `
    WITH
    ${
      hasFtsQuery
        ? `fts_results AS (
        ${ftsUnion}
      ),
      fts_ranked AS (
        SELECT global_id, ROW_NUMBER() OVER (ORDER BY score) AS rank
        FROM fts_results
        WHERE global_id != :target_id
      ),`
        : ""
    }
    img_knn AS (
      SELECT global_id, ROW_NUMBER() OVER (ORDER BY distance) AS rank
      FROM vec_image
      WHERE embedding MATCH (SELECT embedding FROM vec_image WHERE global_id = :target_id)
        AND k = :k
        AND global_id != :target_id
    ),
    txt_knn AS (
      SELECT global_id, ROW_NUMBER() OVER (ORDER BY distance) AS rank
      FROM vec_text
      WHERE embedding MATCH (SELECT embedding FROM vec_text WHERE global_id = :target_id)
        AND k = :k
        AND global_id != :target_id
    ),
    all_candidates AS (
      ${hasFtsQuery ? "SELECT global_id FROM fts_ranked UNION\n      " : ""}SELECT global_id FROM img_knn UNION
      SELECT global_id FROM txt_knn
    ),
    rrf AS (
      SELECT a.global_id,
        ${hasFtsQuery ? `COALESCE(1.0 / (${RRF_K} + f.rank), 0) +` : ""}
        COALESCE(1.0 / (${RRF_K} + i.rank), 0) +
        COALESCE(1.0 / (${RRF_K} + t.rank), 0) AS rrf_score
      FROM all_candidates a
      ${hasFtsQuery ? "LEFT JOIN fts_ranked f ON a.global_id = f.global_id" : ""}
      LEFT JOIN img_knn i ON a.global_id = i.global_id
      LEFT JOIN txt_knn t ON a.global_id = t.global_id
    )
    SELECT global_id, rrf_score FROM rrf
    ORDER BY rrf_score DESC
  `;

  const params: Record<string, any> = {
    target_id: targetId,
    k: 500,
  };
  if (hasFtsQuery) {
    params.query = itemText
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `${w}*`)
      .join(" OR ");
  }

  const allResults = db.prepare(sql).all(params) as {
    global_id: string;
    rrf_score: number;
  }[];

  const total = allResults.length;
  const page = allResults.slice(offset, offset + limit);
  return { item, items: resolveRows(db, page), total };
};
