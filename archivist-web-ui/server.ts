import express from "express";
import fs from "fs";
import path from "path";
import async from "async";
import { chain as lodashChain } from "lodash";
import { createLogger } from "archivist-logger";
import { loadConfig, loadCrawler } from "archivist-cli/lib";

const log = createLogger("web-ui");
const app = express();
const PORT = parseInt(process.env.PORT || "3000");

const encodePath = (filePath: string): string =>
  Buffer.from(filePath).toString("base64url");

const decodePath = (encoded: string): string =>
  Buffer.from(encoded, "base64url").toString();

const searchTolerant = (query?: string): Promise<any[]> => {
  return new Promise((resolve) => {
    const config = loadConfig();
    async.map(
      Object.entries(config),
      (
        [name, cfg]: [string, any],
        callback: (err: any, result?: any) => void,
      ) => {
        loadCrawler(`${name}/query`)
          .then((crawlerQuery: any) => {
            const queryFn = crawlerQuery.default || crawlerQuery;
            queryFn(cfg, query)
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
  const results = await searchTolerant(query);
  const rewritten = results.map((item: any) => ({
    ...item,
    img: `/img/${encodePath(item.img)}`,
    thumbImg: `/img/${encodePath(item.thumbImg)}`,
  }));
  resultCache.set(key, { items: rewritten, timestamp: Date.now() });
  return rewritten;
};

app.get("/api/search", async (req, res) => {
  const query = (req.query.q as string) || undefined;
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  try {
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
});
