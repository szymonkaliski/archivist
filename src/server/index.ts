import express from "express";
import fs from "fs";
import path from "path";

import { createLogger } from "../logger";
import { CONFIG_FILE, loadConfig } from "../config";
import { openDb } from "../db";
import { sourceAssetsDir, sourceFrozenDir, sourceThumbsDir } from "../paths";
import { search, findSimilar, warmSearchIndex } from "../search";
import type { SourceKind } from "../types";
import { SOURCES } from "../sources/registry";
import { loadCached } from "../vec-index";
import {
  IMAGE_MIME_TYPES,
  buildAllowedRoots,
  resolveServedFile,
  type AllowedRoots,
} from "./files";

const log = createLogger("server");
const app = express();
app.set("etag", false);
const PORT = parseInt(process.env.PORT || "3000");

const db = openDb();
warmSearchIndex(db);

const config = fs.existsSync(CONFIG_FILE) ? loadConfig() : {};
const sourceKinds = Object.keys(SOURCES) as SourceKind[];
const IMAGE_ROOTS = buildAllowedRoots([
  ...sourceKinds.flatMap((k) => [sourceAssetsDir(k), sourceThumbsDir(k)]),
  ...(config.screenshot?.directory ? [config.screenshot.directory] : []),
]);
const HTML_ROOTS = buildAllowedRoots([sourceFrozenDir("pinboard")]);
const HTML_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
};

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
  img: item.img ? `/img/${encodePath(item.img)}` : "",
  thumbImg: item.thumbImg ? `/img/${encodePath(item.thumbImg)}` : "",
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
    const filters = {
      text: parsed.text || undefined,
      sources: parsed.sources.length > 0 ? parsed.sources : undefined,
      tags: parsed.tags.length > 0 ? parsed.tags : undefined,
      before: parsed.before ?? undefined,
      after: parsed.after ?? undefined,
      limit,
      offset,
    };

    if (parsed.detail) {
      const vecIndex = loadCached();
      if (!vecIndex) {
        res
          .status(503)
          .json({ error: "vec index not built yet, run fetch first" });
        return;
      }
      const { item, items, total } = findSimilar(
        db,
        vecIndex,
        parsed.detail,
        filters,
      );
      res.json({
        item: item ? rewritePaths(item) : null,
        items: items.map(rewritePaths),
        total,
      });
      return;
    }

    const { items, total } = search(db, filters);
    res.json({ items: items.map(rewritePaths), total });
  } catch (err) {
    log.error(err, "search failed");
    res.status(500).json({ error: "search failed" });
  }
});

const serveEncodedFile = (
  encoded: string,
  allowedRoots: AllowedRoots,
  mimeByExt: Record<string, string>,
  res: express.Response,
): void => {
  const result = resolveServedFile(
    decodePath(encoded),
    allowedRoots,
    mimeByExt,
  );
  if (result.kind === "invalid") {
    res.status(400).json({ error: "invalid path" });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (result.kind === "not_found") {
    res.status(404).json({ error: "not found" });
    return;
  }

  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  const stream = fs.createReadStream(result.filePath);
  stream.on("error", (err) => {
    log.error(err, "failed to stream %s", result.filePath);
    if (!res.headersSent) res.status(500).json({ error: "read failed" });
    else res.destroy();
  });
  stream.pipe(res);
};

app.get("/img/:encoded", (req, res) => {
  serveEncodedFile(req.params.encoded, IMAGE_ROOTS, IMAGE_MIME_TYPES, res);
});

app.get("/html/:encoded", (req, res) => {
  serveEncodedFile(req.params.encoded, HTML_ROOTS, HTML_MIME_TYPES, res);
});

const DIST = path.join(import.meta.dirname, "../../web/dist");
app.use(express.static(DIST));
app.get("/{*path}", (_req, res, next) => {
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

const server = app.listen(PORT, () => {
  log.info(`listening on http://localhost:${PORT}`);
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
