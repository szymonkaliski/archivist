import express from "express";
import fs from "fs";
import path from "path";
import async from "async";
import { chain as lodashChain } from "lodash";
import { createLogger } from "archivist-logger";
import { loadConfig, loadCrawler } from "archivist-cli/lib";
import { parseQuery } from "./src/query";
import { loadAllEmbeddings, buildBM25Index, rankRelatedRRF } from "./ranking";

const log = createLogger("web-ui");
const app = express();
const PORT = parseInt(process.env.PORT || "3000");

const DEFAULT_LIMIT = 400;

const configKeyToSource = (key: string): string => {
  const base = key.split("/").pop() || key;
  return base.replace(/^archivist-/, "").replace(/-(crawl|fetch)$/, "");
};

const encodePath = (filePath: string): string =>
  Buffer.from(filePath).toString("base64url");

const decodePath = (encoded: string): string =>
  Buffer.from(encoded, "base64url").toString();

const searchTolerant = (
  textQuery?: string,
  sourcesFilter?: string[],
): Promise<any[]> => {
  return new Promise((resolve) => {
    const config = loadConfig();
    const entries =
      sourcesFilter && sourcesFilter.length > 0
        ? Object.entries(config).filter(([name]) =>
            sourcesFilter.includes(configKeyToSource(name)),
          )
        : Object.entries(config);
    async.map(
      entries,
      (
        [name, cfg]: [string, any],
        callback: (err: any, result?: any) => void,
      ) => {
        loadCrawler(`${name}/query`)
          .then((crawlerQuery: any) => {
            const queryFn = crawlerQuery.default || crawlerQuery;
            queryFn(cfg, textQuery)
              .then((result: any) => callback(null, result))
              .catch((e: any) => {
                log.warn(`[${name}] search error: ${e}`);
                callback(null, []);
              });
          })
          .catch((e: any) => {
            log.warn(`[${name}] load error: ${e}`);
            callback(null, []);
          });
      },
      (_err: any, results: any) => {
        const sorted = lodashChain(results)
          .flatten()
          .filter((d: any) => d.img && d.thumbImg)
          .sortBy((d: any) => new Date(d.time))
          .reverse()
          .value();
        resolve(sorted);
      },
    );
  });
};

const CACHE_TTL = 60_000;
const resultCache = new Map<string, { items: any[]; timestamp: number }>();

const getCachedResults = async (query?: string): Promise<any[]> => {
  const key = query || "";
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.items;
  }

  const parsed = parseQuery(key);
  const results = await searchTolerant(
    parsed.text || undefined,
    parsed.sources.length > 0 ? parsed.sources : undefined,
  );

  let filtered = results;
  if (parsed.tags.length > 0) {
    filtered = filtered.filter((d: any) => {
      const itemTags: string[] = (d.meta?.tags || []).map((t: string) =>
        t.toLowerCase(),
      );
      return parsed.tags.some((t) => itemTags.includes(t));
    });
  }
  if (parsed.before) {
    const beforeMs = new Date(parsed.before).getTime();
    filtered = filtered.filter(
      (d: any) => new Date(d.time).getTime() < beforeMs,
    );
  }
  if (parsed.after) {
    const afterMs = new Date(parsed.after).getTime();
    filtered = filtered.filter(
      (d: any) => new Date(d.time).getTime() >= afterMs,
    );
  }

  const rewritten = filtered.map((item: any) => ({
    ...item,
    img: `/img/${encodePath(item.img)}`,
    thumbImg: `/img/${encodePath(item.thumbImg)}`,
    meta: {
      ...item.meta,
      static: item.meta.static
        ? `/html/${encodePath(item.meta.static)}`
        : undefined,
    },
  }));
  resultCache.set(key, { items: rewritten, timestamp: Date.now() });

  if (key === "") {
    buildBM25Index(rewritten);
  }

  return rewritten;
};

app.get("/api/sources", (_req, res) => {
  const config = loadConfig();
  res.json(Object.keys(config).map(configKeyToSource));
});

app.get("/api/search", async (req, res) => {
  const query = (req.query.q as string) || undefined;
  const limit = parseInt(req.query.limit as string) || DEFAULT_LIMIT;
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const parsed = parseQuery(query || "");

    if (parsed.detail) {
      const textQuery = parsed.text || undefined;
      const allResults = textQuery
        ? await getCachedResults(textQuery)
        : await getCachedResults();
      const item =
        allResults.find((r: any) => r.id === parsed.detail) ||
        (await getCachedResults()).find((r: any) => r.id === parsed.detail);
      if (!item) {
        res.json({ item: null, items: [], total: 0 });
        return;
      }

      let candidates = rankRelatedRRF(item, allResults, limit + 100);

      if (parsed.sources.length > 0) {
        candidates = candidates.filter((d: any) =>
          parsed.sources.includes(d.meta?.source?.toLowerCase()),
        );
      }
      if (parsed.tags.length > 0) {
        candidates = candidates.filter((d: any) => {
          const itemTags: string[] = (d.meta?.tags || []).map((t: string) =>
            t.toLowerCase(),
          );
          return parsed.tags.some((t) => itemTags.includes(t));
        });
      }
      if (parsed.before) {
        const beforeMs = new Date(parsed.before).getTime();
        candidates = candidates.filter(
          (d: any) => new Date(d.time).getTime() < beforeMs,
        );
      }
      if (parsed.after) {
        const afterMs = new Date(parsed.after).getTime();
        candidates = candidates.filter(
          (d: any) => new Date(d.time).getTime() >= afterMs,
        );
      }

      res.json({
        item,
        items: candidates.slice(offset, offset + limit),
        total: candidates.length,
      });
      return;
    }

    const results = await getCachedResults(query);
    res.json({
      items: results.slice(offset, offset + limit),
      total: results.length,
    });
  } catch (err) {
    log.error(err, "search failed");
    res.status(500).json({ error: "search failed" });
  }
});

app.get("/img/:encoded", (req, res) => {
  const decoded = decodePath(req.params.encoded);
  const resolved = path.resolve(decoded);

  if (!path.isAbsolute(resolved) || resolved !== decoded) {
    res.status(400).json({ error: "invalid path" });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  fs.createReadStream(resolved).pipe(res);
});

app.get("/html/:encoded", (req, res) => {
  const decoded = decodePath(req.params.encoded);
  const resolved = path.resolve(decoded);

  if (!path.isAbsolute(resolved) || resolved !== decoded) {
    res.status(400).json({ error: "invalid path" });
    return;
  }

  if (path.extname(resolved).toLowerCase() !== ".html") {
    res.status(400).json({ error: "invalid file type" });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: "not found" });
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  fs.createReadStream(resolved).pipe(res);
});

const DIST = path.join(__dirname, "dist");
app.use(express.static(DIST));
app.get("/{*path}", (_req, res, next) => {
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  log.info(`listening on http://localhost:${PORT}`);
  getCachedResults().catch((e) => log.warn(`cache warm-up failed: ${e}`));
  loadAllEmbeddings().catch((e) => log.warn(`embedding load failed: ${e}`));
});
