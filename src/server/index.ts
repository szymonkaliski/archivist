import express from "express";
import fs from "fs";
import path from "path";

import { createLogger } from "../logger";
import { openDb } from "../db";
import { search, findSimilar } from "../search";
import { syncVecTables } from "../embeddings";
import type { SourceKind } from "../types";
import { SOURCES } from "../sources/registry";

const log = createLogger("server");
const app = express();
const PORT = parseInt(process.env.PORT || "3000");

const db = openDb();
syncVecTables(db);

const encodePath = (filePath: string): string =>
  Buffer.from(filePath).toString("base64url");

const decodePath = (encoded: string): string =>
  Buffer.from(encoded, "base64url").toString();

interface ParsedQuery {
  text: string;
  sources: SourceKind[];
  tags: string[];
  before: string | null;
  after: string | null;
  detail: string | null;
}

const parseQuery = (raw: string): ParsedQuery => {
  const result: ParsedQuery = {
    text: "",
    sources: [],
    tags: [],
    before: null,
    after: null,
    detail: null,
  };
  const textParts: string[] = [];

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const colonIdx = token.indexOf(":");
    if (colonIdx === -1) {
      textParts.push(token);
      continue;
    }
    const prefix = token.slice(0, colonIdx).toLowerCase();
    const value = token.slice(colonIdx + 1);
    if (!value) {
      textParts.push(token);
      continue;
    }
    switch (prefix) {
      case "source":
        result.sources.push(value.toLowerCase() as SourceKind);
        break;
      case "tag":
        result.tags.push(value.toLowerCase());
        break;
      case "detail":
        result.detail = value;
        break;
      case "before":
        if (!isNaN(Date.parse(value))) result.before = value;
        else textParts.push(token);
        break;
      case "after":
        if (!isNaN(Date.parse(value))) result.after = value;
        else textParts.push(token);
        break;
      default:
        textParts.push(token);
    }
  }

  result.text = textParts.join(" ");
  return result;
};

const rewritePaths = (item: any) => ({
  ...item,
  img: `/img/${encodePath(item.img)}`,
  thumbImg: `/img/${encodePath(item.thumbImg)}`,
  meta: {
    ...item.meta,
    static: item.meta.static
      ? `/html/${encodePath(item.meta.static)}`
      : undefined,
  },
});

app.get("/api/sources", (_req, res) => {
  res.json(Object.keys(SOURCES));
});

app.get("/api/search", (req, res) => {
  const query = (req.query.q as string) || "";
  const limit = parseInt(req.query.limit as string) || 400;
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const parsed = parseQuery(query);

    if (parsed.detail) {
      const { item, items, total } = findSimilar(db, parsed.detail, {
        text: parsed.text || undefined,
        sources: parsed.sources.length > 0 ? parsed.sources : undefined,
        limit: limit + 100,
        offset: 0,
      });

      if (!item) {
        res.json({ item: null, items: [], total: 0 });
        return;
      }

      let filtered = items;
      if (parsed.tags.length > 0) {
        filtered = filtered.filter((d) => {
          const itemTags = (d.meta?.tags || []).map((t) => t.toLowerCase());
          return parsed.tags.some((t) => itemTags.includes(t));
        });
      }
      if (parsed.before) {
        const beforeMs = new Date(parsed.before).getTime();
        filtered = filtered.filter((d) => new Date(d.time).getTime() < beforeMs);
      }
      if (parsed.after) {
        const afterMs = new Date(parsed.after).getTime();
        filtered = filtered.filter((d) => new Date(d.time).getTime() >= afterMs);
      }

      res.json({
        item: rewritePaths(item),
        items: filtered.slice(offset, offset + limit).map(rewritePaths),
        total: filtered.length,
      });
      return;
    }

    const result = search(db, {
      text: parsed.text || undefined,
      sources: parsed.sources.length > 0 ? parsed.sources : undefined,
      limit: undefined,
      offset: 0,
    });

    let filtered = result.items;
    if (parsed.tags.length > 0) {
      filtered = filtered.filter((d) => {
        const itemTags = (d.meta?.tags || []).map((t) => t.toLowerCase());
        return parsed.tags.some((t) => itemTags.includes(t));
      });
    }
    if (parsed.before) {
      const beforeMs = new Date(parsed.before).getTime();
      filtered = filtered.filter((d) => new Date(d.time).getTime() < beforeMs);
    }
    if (parsed.after) {
      const afterMs = new Date(parsed.after).getTime();
      filtered = filtered.filter((d) => new Date(d.time).getTime() >= afterMs);
    }

    res.json({
      items: filtered.slice(offset, offset + limit).map(rewritePaths),
      total: filtered.length,
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

const DIST = path.join(import.meta.dirname, "../../web/dist");
app.use(express.static(DIST));
app.get("/{*path}", (_req, res, next) => {
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  log.info(`listening on http://localhost:${PORT}`);
});
