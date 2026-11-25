import type Database from "better-sqlite3";

import { SOURCES } from "./sources/registry";
import type { SearchResult, SourceDefinition, SourceKind } from "./types";
import type { VecIndex } from "./vec-index";

const RRF_K = 60;

const SOURCE_LIST: readonly SourceDefinition[] = Object.values(SOURCES);
const SOURCE_INDEX = new Map<string, number>(
  SOURCE_LIST.map((s, i) => [s.kind, i]),
);
const ALL_SOURCES_MASK = (1 << SOURCE_LIST.length) - 1;
const TAGGABLE_MASK = SOURCE_LIST.reduce(
  (mask, s, i) => (s.tagSpec ? mask | (1 << i) : mask),
  0,
);

export interface SearchOptions {
  text?: string;
  sources?: SourceKind[];
  tags?: string[];
  before?: string;
  after?: string;
  limit: number;
  offset: number;
}

interface SearchStmts {
  begin: Database.Statement;
  commit: Database.Statement;
  rollback: Database.Statement;
  version: Database.Statement;
  metaLoad: Database.Statement[];
  fts: Database.Statement[];
  resolve: Database.Statement[];
  embeddings: Database.Statement;
}

interface SearchIndex {
  stmts: SearchStmts;
  version: [number, number, number];
  count: number;
  nonNullTimes: number;
  srcIdx: Uint8Array;
  rowids: Float64Array;
  globalIds: string[];
  times: (string | null)[];
  tags: (string | null)[];
  rankByRowid: Map<number, number>[];
  rankByGlobalId: Map<string, number> | null;
  seenMark: Uint32Array;
  markGen: number;
}

interface TagFilter {
  delimited: string[];
  exact: string[];
}

interface CompiledFilter {
  activeMask: number;
  tagFilter: TagFilter | null;
  minRank: number;
  maxRank: number;
  offset: number;
  limit: number;
}

const stmtCache = new WeakMap<Database.Database, SearchStmts>();
const indexCache = new WeakMap<Database.Database, SearchIndex>();

const prepareStmts = (db: Database.Database): SearchStmts => ({
  begin: db.prepare("BEGIN"),
  commit: db.prepare("COMMIT"),
  rollback: db.prepare("ROLLBACK"),
  version: db
    .prepare(
      "SELECT (SELECT data_version FROM pragma_data_version), (SELECT schema_version FROM pragma_schema_version), total_changes()",
    )
    .raw(),
  metaLoad: SOURCE_LIST.map((s) => {
    const tagSelect = s.tagSpec ? `, ${s.tagSpec.column}` : "";
    return db
      .prepare(
        `SELECT rowid, global_id, ${s.timeColumn}${tagSelect} FROM ${s.dataTable} ORDER BY ${s.timeColumn} DESC`,
      )
      .raw();
  }),
  fts: SOURCE_LIST.map((s) =>
    db
      .prepare(`SELECT rowid FROM ${s.ftsTable} WHERE ${s.ftsTable} MATCH ?`)
      .pluck(),
  ),
  resolve: SOURCE_LIST.map((s) =>
    db.prepare(
      `SELECT ${s.selectColumns ?? "*"} FROM ${s.dataTable} WHERE rowid IN (SELECT value FROM json_each(?))`,
    ),
  ),
  embeddings: db.prepare(
    `SELECT
       (SELECT embedding FROM embeddings WHERE global_id = ?) AS img,
       (SELECT embedding FROM text_embeddings WHERE global_id = ?) AS txt`,
  ),
});

const getStmts = (db: Database.Database): SearchStmts => {
  let stmts = stmtCache.get(db);
  if (!stmts) {
    stmts = prepareStmts(db);
    stmtCache.set(db, stmts);
  }
  return stmts;
};

const withReadSnapshot = <T>(
  db: Database.Database,
  fn: (cacheable: boolean) => T,
): T => {
  if (db.inTransaction) return fn(false);
  const stmts = getStmts(db);
  stmts.begin.run();
  try {
    const result = fn(true);
    stmts.commit.run();
    return result;
  } catch (err) {
    if (db.inTransaction) stmts.rollback.run();
    throw err;
  }
};

const normalizeTag = (
  source: SourceDefinition,
  raw: string | null,
): string | null => {
  if (raw == null || !source.tagSpec) return null;
  if (source.tagSpec.kind === "delimited") {
    return `\0${raw.toLowerCase().split(source.tagSpec.delimiter).join("\0")}\0`;
  }
  return raw;
};

const buildIndex = (
  stmts: SearchStmts,
  version: [number, number, number],
): SearchIndex => {
  const numSources = SOURCE_LIST.length;
  const lists = stmts.metaLoad.map((stmt) => stmt.all() as unknown[][]);
  const lens = lists.map((l) => l.length);
  let count = 0;
  for (let s = 0; s < numSources; s++) count += lens[s];

  const srcIdx = new Uint8Array(count);
  const rowids = new Float64Array(count);
  const globalIds = new Array<string>(count);
  const times = new Array<string | null>(count);
  const tags = new Array<string | null>(count);
  const rankByRowid = SOURCE_LIST.map(() => new Map<number, number>());

  // Each covering-index scan is already ordered by time DESC (NULLs last),
  // so a k-way merge builds the global rank order in O(N).
  const cursors = new Int32Array(numSources);
  let nonNullTimes = 0;
  for (let out = 0; out < count; out++) {
    let bestSrc = -1;
    let bestTime: string | null = null;
    for (let s = 0; s < numSources; s++) {
      if (cursors[s] >= lens[s]) continue;
      const t = (lists[s][cursors[s]][2] as string | null) ?? null;
      if (
        bestSrc === -1 ||
        (t !== null && (bestTime === null || t > bestTime))
      ) {
        bestSrc = s;
        bestTime = t;
      }
    }

    const row = lists[bestSrc][cursors[bestSrc]++];
    const rid = row[0] as number;
    const source = SOURCE_LIST[bestSrc];
    const rawTag = source.tagSpec ? ((row[3] as string | null) ?? null) : null;

    srcIdx[out] = bestSrc;
    rowids[out] = rid;
    globalIds[out] = row[1] as string;
    times[out] = bestTime;
    if (bestTime !== null) nonNullTimes = out + 1;
    tags[out] = normalizeTag(source, rawTag);
    rankByRowid[bestSrc].set(rid, out);
  }

  return {
    stmts,
    version,
    count,
    nonNullTimes,
    srcIdx,
    rowids,
    globalIds,
    times,
    tags,
    rankByRowid,
    rankByGlobalId: null,
    seenMark: new Uint32Array(count),
    markGen: 0,
  };
};

const getIndex = (db: Database.Database, cacheable: boolean): SearchIndex => {
  const existing = indexCache.get(db);
  const stmts = existing ? existing.stmts : getStmts(db);
  const version = stmts.version.get() as [number, number, number];

  if (
    existing &&
    version[0] === existing.version[0] &&
    version[1] === existing.version[1] &&
    version[2] === existing.version[2]
  ) {
    return existing;
  }

  const activeStmts =
    existing && version[1] !== existing.version[1] ? prepareStmts(db) : stmts;
  const built = buildIndex(activeStmts, version);
  if (cacheable) {
    if (activeStmts !== stmts) stmtCache.set(db, activeStmts);
    indexCache.set(db, built);
  }
  return built;
};

const getRankByGlobalId = (index: SearchIndex): Map<string, number> => {
  if (index.rankByGlobalId) return index.rankByGlobalId;
  const map = new Map<string, number>();
  const { globalIds, count } = index;
  for (let i = 0; i < count; i++) map.set(globalIds[i], i);
  index.rankByGlobalId = map;
  return map;
};

export const warmSearchIndex = (db: Database.Database): void => {
  withReadSnapshot(db, (cacheable) => {
    getIndex(db, cacheable);
  });
};

export const ftsQuoteTerms = (input: string): string =>
  input
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"*`)
    .join(" OR ");

// times[0 .. hi - 1] is non-null and sorted descending.
// Returns the smallest rank in [0, hi] where times[rank] < bound.
const firstRankLessThan = (
  times: (string | null)[],
  hi: number,
  bound: string,
): number => {
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! < bound) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

const compileFilter = (
  index: SearchIndex,
  options: SearchOptions,
): CompiledFilter => {
  const tagFilter: TagFilter | null = options.tags?.length
    ? {
        delimited: options.tags.map((t) => `\0${t.toLowerCase()}\0`),
        exact: options.tags,
      }
    : null;

  let activeMask = 0;
  if (options.sources?.length) {
    for (let i = 0; i < options.sources.length; i++) {
      const idx = SOURCE_INDEX.get(options.sources[i]);
      if (idx !== undefined) activeMask |= 1 << idx;
    }
  } else {
    activeMask = ALL_SOURCES_MASK;
  }
  if (tagFilter) activeMask &= TAGGABLE_MASK;

  let minRank = 0;
  let maxRank = index.count;
  if (options.before || options.after) {
    maxRank = index.nonNullTimes;
    if (options.before) {
      minRank = firstRankLessThan(
        index.times,
        index.nonNullTimes,
        options.before,
      );
    }
    if (options.after) {
      maxRank = firstRankLessThan(
        index.times,
        index.nonNullTimes,
        options.after,
      );
    }
  }

  return {
    activeMask,
    tagFilter,
    minRank,
    maxRank,
    offset: Math.max(0, options.offset),
    limit: Math.max(0, options.limit),
  };
};

const matchesTag = (
  src: number,
  tagVal: string | null,
  filter: TagFilter,
): boolean => {
  if (tagVal === null) return false;
  const spec = SOURCE_LIST[src].tagSpec;
  if (!spec) return false;
  if (spec.kind === "delimited") {
    for (let i = 0; i < filter.delimited.length; i++) {
      if (tagVal.includes(filter.delimited[i])) return true;
    }
    return false;
  }
  for (let i = 0; i < filter.exact.length; i++) {
    if (tagVal === filter.exact[i]) return true;
  }
  return false;
};

const resolveRanks = (index: SearchIndex, ranks: number[]): SearchResult[] => {
  if (ranks.length === 0) return [];

  const ridsBySource = SOURCE_LIST.map(() => [] as number[]);
  for (let i = 0; i < ranks.length; i++) {
    const rank = ranks[i];
    ridsBySource[index.srcIdx[rank]].push(index.rowids[rank]);
  }

  const rowMap = new Map<string, SearchResult>();
  for (let s = 0; s < SOURCE_LIST.length; s++) {
    const rids = ridsBySource[s];
    if (rids.length === 0) continue;
    const source = SOURCE_LIST[s];
    const rows = index.stmts.resolve[s].all(JSON.stringify(rids)) as Record<
      string,
      unknown
    >[];
    for (let i = 0; i < rows.length; i++) {
      const result = source.toSearchResult(rows[i]);
      rowMap.set(result.id, result);
    }
  }

  const items: SearchResult[] = [];
  for (let i = 0; i < ranks.length; i++) {
    const item = rowMap.get(index.globalIds[ranks[i]]);
    if (item) items.push(item);
  }
  return items;
};

export const search = (
  db: Database.Database,
  options: SearchOptions,
): { items: SearchResult[]; total: number } => {
  const ftsQuery = options.text ? ftsQuoteTerms(options.text) : null;
  if (options.text && !ftsQuery) return { items: [], total: 0 };

  return withReadSnapshot(db, (cacheable) => {
    const index = getIndex(db, cacheable);
    const { activeMask, tagFilter, minRank, maxRank, offset, limit } =
      compileFilter(index, options);
    if (activeMask === 0 || minRank >= maxRank) return { items: [], total: 0 };

    const pageRanks: number[] = [];

    if (!ftsQuery) {
      if (activeMask === ALL_SOURCES_MASK && !tagFilter) {
        const total = maxRank - minRank;
        const start = minRank + offset;
        const end = Math.min(start + limit, maxRank);
        for (let rank = start; rank < end; rank++) pageRanks.push(rank);
        return { items: resolveRanks(index, pageRanks), total };
      }

      const needEnd = offset + limit;
      let total = 0;
      const { srcIdx, tags } = index;
      for (let rank = minRank; rank < maxRank; rank++) {
        const s = srcIdx[rank];
        if ((activeMask & (1 << s)) === 0) continue;
        if (tagFilter && !matchesTag(s, tags[rank], tagFilter)) continue;
        if (total >= offset && total < needEnd) {
          pageRanks.push(rank);
        }
        total++;
      }

      return { items: resolveRanks(index, pageRanks), total };
    }

    const gen = ++index.markGen;
    const { seenMark, tags, rankByRowid } = index;
    let matchedCount = 0;
    let minHit = maxRank;
    let maxHit = -1;

    for (let s = 0; s < SOURCE_LIST.length; s++) {
      if ((activeMask & (1 << s)) === 0) continue;
      const rids = index.stmts.fts[s].all(ftsQuery) as number[];
      const lookup = rankByRowid[s];
      for (let i = 0; i < rids.length; i++) {
        const rank = lookup.get(rids[i]);
        if (
          rank === undefined ||
          rank < minRank ||
          rank >= maxRank ||
          seenMark[rank] === gen
        ) {
          continue;
        }
        if (tagFilter && !matchesTag(s, tags[rank], tagFilter)) continue;
        seenMark[rank] = gen;
        if (rank < minHit) minHit = rank;
        if (rank > maxHit) maxHit = rank;
        matchedCount++;
      }
    }

    if (matchedCount === 0 || limit === 0 || offset >= matchedCount) {
      return { items: [], total: matchedCount };
    }

    let skipped = 0;
    for (let rank = minHit; rank <= maxHit; rank++) {
      if (seenMark[rank] !== gen) continue;
      if (skipped >= offset) {
        pageRanks.push(rank);
        if (pageRanks.length >= limit) break;
      }
      skipped++;
    }

    return { items: resolveRanks(index, pageRanks), total: matchedCount };
  });
};

export const findSimilar = (
  db: Database.Database,
  vecIndex: VecIndex,
  targetId: string,
  options: SearchOptions,
): { item: SearchResult | null; items: SearchResult[]; total: number } =>
  withReadSnapshot(db, (cacheable) => {
    const index = getIndex(db, cacheable);
    const rankByGlobalId = getRankByGlobalId(index);
    const targetRank = rankByGlobalId.get(targetId);
    if (targetRank === undefined) {
      return { item: null, items: [], total: 0 };
    }

    const embs = index.stmts.embeddings.get(targetId, targetId) as {
      img: Buffer | null;
      txt: Buffer | null;
    };
    if (!embs.img && !embs.txt) {
      const [item] = resolveRanks(index, [targetRank]);
      return { item: item ?? null, items: [], total: 0 };
    }

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

    const { activeMask, tagFilter, minRank, maxRank, offset, limit } =
      compileFilter(index, options);

    const scoredRanks: [number, number][] = [];
    if (activeMask !== 0 && minRank < maxRank) {
      const { srcIdx, tags } = index;
      for (const [id, score] of scores) {
        const rank = rankByGlobalId.get(id);
        if (rank === undefined || rank < minRank || rank >= maxRank) continue;
        const s = srcIdx[rank];
        if ((activeMask & (1 << s)) === 0) continue;
        if (tagFilter && !matchesTag(s, tags[rank], tagFilter)) continue;
        scoredRanks.push([rank, score]);
      }
    }

    scoredRanks.sort((a, b) => b[1] - a[1]);

    const total = scoredRanks.length;
    const pageRanks = scoredRanks
      .slice(offset, offset + limit)
      .map(([rank]) => rank);

    const resolved = resolveRanks(index, [targetRank, ...pageRanks]);
    if (resolved.length === 0) {
      return { item: null, items: [], total: 0 };
    }

    return { item: resolved[0], items: resolved.slice(1), total };
  });
