import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import sharp from "sharp";
import { imageSize } from "image-size";
import type Database from "better-sqlite3";

const execFileAsync = promisify(execFile);

import { createLogger } from "../../logger";
import { sourceAssetsDir, sourceThumbsDir } from "../../paths";
import type { SourceDefinition, SearchResult } from "../../types";
import { withRetry } from "../../retry";

const log = createLogger("arena");

const ASSETS_PATH = sourceAssetsDir("arena");
const THUMBS_PATH = sourceThumbsDir("arena");
const THUMB_SIZE = 400;

const API_BASE = "https://api.are.na/v3";
const PER_PAGE = 100;

const globalId = (blockId: number): string => `arena:${blockId}`;

interface ArenaImage {
  src: string;
  width: number;
  height: number;
  content_type: string;
  filename: string;
  file_size: number;
}

interface ArenaSource {
  url: string;
  title: string;
  provider: { name: string; url: string };
}

interface ArenaAttachment {
  url: string;
  content_type: string;
  filename: string;
}

interface ArenaRichText {
  markdown?: string;
  html?: string;
  plain?: string;
}

interface ArenaBlock {
  id: number;
  type: "Image" | "Text" | "Link" | "Media" | "Attachment";
  base_type: "Block" | "Channel";
  title: string | null;
  description: string | ArenaRichText | null;
  content: string | ArenaRichText | null;
  created_at: string;
  updated_at: string;
  source: ArenaSource | null;
  image: ArenaImage | null;
  attachment: ArenaAttachment | null;
  connection: {
    connected_at: string;
  };
}

const richTextToPlain = (
  value: string | ArenaRichText | null | undefined,
): string | null => {
  if (value == null) return null;
  if (typeof value === "string") return value || null;
  return value.plain || value.markdown || null;
};

interface ArenaChannel {
  id: number;
  title: string;
  slug: string;
  counts: { blocks: number; contents: number };
}

interface ArenaDbRow {
  global_id: string;
  block_id: number;
  title: string | null;
  description: string | null;
  content: string | null;
  source_url: string | null;
  block_class: string;
  connected_at: string;
  channels: string;
  filename: string | null;
  width: number;
  height: number;
}

const API_ATTEMPTS = 6;
const DOWNLOAD_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2000;

const apiFetch = async (
  endpoint: string,
  token: string,
  params?: Record<string, string | number>,
): Promise<any> => {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }

  // An error thrown here propagates past every caller and aborts the whole
  // source for the run, so transient connection failures are retried.
  return withRetry(
    {
      label: endpoint,
      attempts: API_ATTEMPTS,
      backoff: { kind: "exponential", baseMs: BACKOFF_BASE_MS },
      log,
    },
    async () => {
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (e: any) {
        return { kind: "retry", reason: `network error (${e})` };
      }

      if (res.status === 429) {
        const reset = res.headers.get("X-RateLimit-Reset");
        const waitMs = reset
          ? Math.max(0, Number(reset) * 1000 - Date.now())
          : 60_000;
        return {
          kind: "retry-after",
          reason: "rate limited",
          waitMs: waitMs + 1000,
        };
      }

      if (res.status >= 500) {
        return { kind: "retry", reason: `API ${res.status}: ${endpoint}` };
      }

      if (!res.ok) {
        return { kind: "fail", reason: `API ${res.status}: ${endpoint}` };
      }

      return { kind: "done", value: await res.json() };
    },
  );
};

const fetchChannels = async (
  userSlug: string,
  token: string,
): Promise<ArenaChannel[]> => {
  const channels: ArenaChannel[] = [];
  let page = 1;

  while (true) {
    const data = await apiFetch(`/users/${userSlug}/contents`, token, {
      page,
      per: PER_PAGE,
    });

    const items = data.data ?? [];
    const channelItems = items.filter((item: any) => item.type === "Channel");
    channels.push(...channelItems);

    if (!data.meta?.has_more_pages) break;
    page++;
  }

  return channels;
};

const fetchChannelBlocks = async (
  slug: string,
  token: string,
): Promise<ArenaBlock[]> => {
  const blocks: ArenaBlock[] = [];
  let page = 1;

  while (true) {
    const data = await apiFetch(`/channels/${slug}/contents`, token, {
      page,
      per: PER_PAGE,
    });

    const items = data.data ?? [];
    for (const item of items) {
      if (item.base_type === "Block") {
        blocks.push(item);
      }
    }

    if (!data.meta?.has_more_pages) break;
    page++;
  }

  return blocks;
};

const downloadImage = async (
  url: string,
  blockId: number,
): Promise<{ filename: string; width: number; height: number } | null> => {
  try {
    return await withRetry(
      {
        label: `image for block ${blockId}`,
        attempts: DOWNLOAD_ATTEMPTS,
        backoff: { kind: "exponential", baseMs: BACKOFF_BASE_MS },
        log,
      },
      async () => {
        let res: Response;
        try {
          res = await fetch(url);
        } catch (e: any) {
          return { kind: "retry", reason: `network error (${e})` };
        }

        if (res.status >= 500) {
          return { kind: "retry", reason: `HTTP ${res.status}` };
        }
        if (!res.ok) {
          return { kind: "fail", reason: `HTTP ${res.status}` };
        }

        const buf = Buffer.from(await res.arrayBuffer());
        const ext = path.extname(new URL(url).pathname).split("?")[0] || ".jpg";
        const filename = `${blockId}${ext}`;
        const dest = path.join(ASSETS_PATH, filename);

        fs.writeFileSync(dest, buf);

        try {
          const size = imageSize(new Uint8Array(buf));
          return {
            kind: "done",
            value: {
              filename,
              width: size.width || 0,
              height: size.height || 0,
            },
          };
        } catch {
          return { kind: "done", value: { filename, width: 0, height: 0 } };
        }
      },
    );
  } catch (e: any) {
    // A null filename is recorded and reconsidered on the next run, so giving
    // up here costs an hour rather than the block's image.
    log.error("download failed for block %d: %s", blockId, e.message);
    return null;
  }
};

const downloadAttachmentAsGif = async (
  url: string,
  blockId: number,
): Promise<{ filename: string; width: number; height: number } | null> => {
  const mp4Path = path.join(ASSETS_PATH, `${blockId}.mp4`);
  const palettePath = path.join(ASSETS_PATH, `${blockId}.palette.png`);
  const gifFilename = `${blockId}.gif`;
  const gifPath = path.join(ASSETS_PATH, gifFilename);

  // cap width so palettegen on long, high-res screen recordings doesn't OOM;
  // 1920 keeps perceived quality high while bounding the per-frame memory cost
  const scaleFilter = "scale='min(1920,iw)':-2:flags=lanczos";
  const fpsFilter = "fps=15";

  try {
    // only the download is retried; a failed transcode means an unusable file,
    // and re-running ffmpeg on it is expensive and would fail the same way
    await withRetry(
      {
        label: `attachment for block ${blockId}`,
        attempts: DOWNLOAD_ATTEMPTS,
        backoff: { kind: "exponential", baseMs: BACKOFF_BASE_MS },
        log,
      },
      async () => {
        let res: Response;
        try {
          res = await fetch(url);
        } catch (e: any) {
          return { kind: "retry", reason: `network error (${e})` };
        }

        if (res.status >= 500) {
          return { kind: "retry", reason: `HTTP ${res.status}` };
        }
        if (!res.ok) {
          return { kind: "fail", reason: `HTTP ${res.status}` };
        }

        fs.writeFileSync(mp4Path, Buffer.from(await res.arrayBuffer()));
        return { kind: "done", value: null };
      },
    );

    // two-pass: palettegen is the memory hot spot; running it standalone (no
    // split filter holding both branches in flight) keeps peak RSS much lower
    await execFileAsync("ffmpeg", [
      "-i",
      mp4Path,
      "-vf",
      `${fpsFilter},${scaleFilter},palettegen=max_colors=256:stats_mode=diff`,
      "-update",
      "1",
      "-y",
      palettePath,
    ]);

    await execFileAsync("ffmpeg", [
      "-i",
      mp4Path,
      "-i",
      palettePath,
      "-lavfi",
      `${fpsFilter},${scaleFilter}[x];[x][1:v]paletteuse=dither=sierra2_4a`,
      "-y",
      gifPath,
    ]);

    fs.unlinkSync(mp4Path);
    fs.unlinkSync(palettePath);

    try {
      const size = imageSize(new Uint8Array(fs.readFileSync(gifPath)));
      return {
        filename: gifFilename,
        width: size.width || 0,
        height: size.height || 0,
      };
    } catch {
      return { filename: gifFilename, width: 0, height: 0 };
    }
  } catch (e: any) {
    log.error("attachment->gif failed for block %d: %s", blockId, e.message);
    for (const p of [mp4Path, palettePath, gifPath]) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    return null;
  }
};

const createThumbnails = async (db: Database.Database) => {
  fs.mkdirSync(THUMBS_PATH, { recursive: true });

  const rows = db
    .prepare("SELECT filename FROM arena WHERE filename IS NOT NULL")
    .all() as {
    filename: string;
  }[];

  for (const { filename } of rows) {
    const inputPath = path.join(ASSETS_PATH, filename);
    if (!fs.existsSync(inputPath)) continue;

    const outputName = path.parse(filename).name + ".png";
    const outputPath = path.join(THUMBS_PATH, outputName);

    if (!fs.existsSync(outputPath)) {
      log.info(`making thumbnail for ${inputPath} -> ${outputPath}`);
      try {
        const meta = await sharp(inputPath).metadata();
        const w = meta.width || 0;
        const h = meta.height || 0;
        // Always re-encode. libvips selects its loader from the file extension,
        // so copying e.g. heic bytes to a .png name yields an unreadable thumb.
        const image = sharp(inputPath);
        if (w > THUMB_SIZE || h > THUMB_SIZE) image.resize(THUMB_SIZE);
        await image.png().toFile(outputPath);
      } catch (e: any) {
        log.error("error making thumbnail for: %s %s", inputPath, String(e));
      }
    }
  }
};

const arena: SourceDefinition<"arena"> = {
  kind: "arena",

  setupStatements: [
    `CREATE TABLE IF NOT EXISTS arena (
      global_id TEXT PRIMARY KEY,
      block_id INTEGER NOT NULL UNIQUE,
      title TEXT,
      description TEXT,
      content TEXT,
      source_url TEXT,
      block_class TEXT NOT NULL,
      connected_at DATETIME,
      channels TEXT,
      filename TEXT,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS arena_fts
     USING FTS5(global_id, title, description, content, source_url, channels)`,
    `CREATE TRIGGER IF NOT EXISTS arena_fts_insert AFTER INSERT ON arena BEGIN
      INSERT INTO arena_fts(global_id, title, description, content, source_url, channels)
      VALUES (new.global_id, new.title, new.description, new.content, new.source_url, new.channels);
    END`,
    `CREATE TRIGGER IF NOT EXISTS arena_fts_delete AFTER DELETE ON arena BEGIN
      DELETE FROM arena_fts WHERE global_id = old.global_id;
    END`,
    `CREATE TRIGGER IF NOT EXISTS arena_fts_update AFTER UPDATE ON arena BEGIN
      DELETE FROM arena_fts WHERE global_id = old.global_id;
      INSERT INTO arena_fts(global_id, title, description, content, source_url, channels)
      VALUES (new.global_id, new.title, new.description, new.content, new.source_url, new.channels);
    END`,
  ],

  ftsTable: "arena_fts",
  dataTable: "arena",

  async fetch(db, config) {
    if (!config.accessToken) throw new Error("accessToken not provided");

    fs.mkdirSync(ASSETS_PATH, { recursive: true });
    fs.mkdirSync(THUMBS_PATH, { recursive: true });

    // get user slug from userId
    const me = await apiFetch("/me", config.accessToken);
    const userSlug: string = me.slug;

    const channels = await fetchChannels(userSlug, config.accessToken);
    log.info(`found ${channels.length} channels`);

    // fetch all blocks with their channel membership
    const blockChannels = new Map<number, Set<string>>();
    const blockData = new Map<number, ArenaBlock>();

    for (const channel of channels) {
      log.info(
        `fetching channel: ${channel.title} (${channel.counts.contents} blocks)`,
      );
      const blocks = await fetchChannelBlocks(channel.slug, config.accessToken);

      for (const block of blocks) {
        if (!blockChannels.has(block.id)) {
          blockChannels.set(block.id, new Set());
        }
        blockChannels.get(block.id)!.add(channel.title);

        if (!blockData.has(block.id)) {
          blockData.set(block.id, block);
        }
      }
    }

    log.info(`total unique blocks: ${blockData.size}`);

    const dbRows = db.prepare("SELECT * FROM arena").all() as ArenaDbRow[];
    const existingIds = new Set(dbRows.map((r) => r.block_id));
    const crawledIds = new Set(blockData.keys());

    // remove blocks no longer in any channel
    const removedRows = dbRows.filter((r) => !crawledIds.has(r.block_id));
    if (removedRows.length > 0) {
      const remove = db.prepare("DELETE FROM arena WHERE block_id = ?");
      for (const row of removedRows) {
        if (row.filename) {
          const filePath = path.join(ASSETS_PATH, row.filename);
          if (fs.existsSync(filePath)) {
            log.info(`unlinking ${filePath}`);
            fs.unlinkSync(filePath);
          }
          const thumbPath = path.join(
            THUMBS_PATH,
            path.parse(row.filename).name + ".png",
          );
          if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }
      }
      db.transaction((ids: number[]) => {
        for (const id of ids) remove.run(id);
      })(removedRows.map((r) => r.block_id));
      log.info(`removed ${removedRows.length} blocks`);
    }

    // A block whose download failed is stored with a null filename, so blocks
    // that should carry an asset but have none are retried on later runs
    // instead of staying imageless for good.
    const missingAsset = new Set(
      dbRows.filter((r) => !r.filename).map((r) => r.block_id),
    );
    const expectsAsset = (block: ArenaBlock): boolean =>
      !!block.image?.src ||
      !!block.attachment?.content_type?.startsWith("video/");

    const entries = [...blockData.entries()];
    const freshBlocks = entries.filter(([id]) => !existingIds.has(id));
    const assetRetryBlocks = entries.filter(
      ([id, block]) =>
        existingIds.has(id) && missingAsset.has(id) && expectsAsset(block),
    );
    const newBlocks = [...freshBlocks, ...assetRetryBlocks];

    log.info(
      `new blocks to fetch: ${freshBlocks.length} / retrying missing assets: ${assetRetryBlocks.length}`,
    );

    const insert = db.prepare(
      `INSERT OR REPLACE INTO arena (global_id, block_id, title, description, content, source_url, block_class, connected_at, channels, filename, width, height)
       VALUES (:global_id, :block_id, :title, :description, :content, :source_url, :block_class, :connected_at, :channels, :filename, :width, :height)`,
    );

    const concurrency = config.concurrency ?? 5;
    const queue = [...newBlocks];
    const results: ArenaDbRow[] = [];

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const [blockId, block] = queue.shift()!;
        const channelNames = [...(blockChannels.get(blockId) || [])].join("\t");

        let filename: string | null = null;
        let width = 0;
        let height = 0;

        const isVideo = block.attachment?.content_type?.startsWith("video/");
        let downloaded: {
          filename: string;
          width: number;
          height: number;
        } | null = null;

        if (isVideo && block.attachment) {
          downloaded = await downloadAttachmentAsGif(
            block.attachment.url,
            blockId,
          );
        }
        if (!downloaded && block.image?.src) {
          downloaded = await downloadImage(block.image.src, blockId);
        }
        if (downloaded) {
          filename = downloaded.filename;
          width = downloaded.width;
          height = downloaded.height;
        }

        results.push({
          global_id: globalId(blockId),
          block_id: blockId,
          title: block.title || null,
          description: richTextToPlain(block.description),
          content: richTextToPlain(block.content),
          source_url: block.source?.url || null,
          block_class: block.type,
          connected_at: block.connection?.connected_at || block.created_at,
          channels: channelNames,
          filename,
          width,
          height,
        });
      }
    });

    await Promise.all(workers);

    db.transaction((rows: ArenaDbRow[]) => {
      for (const row of rows) insert.run(row);
    })(results);

    // update channel membership for existing blocks
    const updateChannels = db.prepare(
      "UPDATE arena SET channels = :channels WHERE block_id = :block_id",
    );
    const existingBlocks = dbRows.filter((r) => crawledIds.has(r.block_id));
    let updatedCount = 0;
    for (const row of existingBlocks) {
      const newChannels = [...(blockChannels.get(row.block_id) || [])].join(
        "\t",
      );
      if (newChannels !== row.channels) {
        updateChannels.run({ channels: newChannels, block_id: row.block_id });
        updatedCount++;
      }
    }
    if (updatedCount > 0) {
      log.info(`updated channel membership for ${updatedCount} blocks`);
    }

    await createThumbnails(db);

    log.info(`inserted ${results.length} blocks`);
  },

  toSearchResult(row): SearchResult {
    const r = row as Record<string, any>;
    const hasImage = r.filename != null;

    let img = "";
    let thumbImg = "";
    if (hasImage) {
      img = path.join(ASSETS_PATH, r.filename);
      const thumbname = path.parse(r.filename).name + ".png";
      const thumbPath = path.join(THUMBS_PATH, thumbname);
      let thumbOk = false;
      try {
        const stat = fs.statSync(thumbPath);
        thumbOk = stat.size > 0;
      } catch {}
      thumbImg = thumbOk ? thumbPath : img;
    }

    const link = r.source_url || `https://www.are.na/block/${r.block_id}`;

    return {
      img,
      thumbImg,
      id: r.global_id,
      link,
      time: r.connected_at,
      width: r.width || 0,
      height: r.height || 0,
      meta: {
        source: "arena",
        title: r.title || undefined,
        note: r.description || r.content || undefined,
        tags: r.channels ? r.channels.split("\t").filter(Boolean) : [],
      },
    };
  },

  embeddingText(row): string {
    const r = row as Record<string, any>;
    return [r.title, r.description, r.content, r.source_url, r.channels]
      .filter(Boolean)
      .join(" ");
  },

  thumbPath(row): string {
    const r = row as Record<string, any>;
    if (!r.filename) return "";
    return path.join(THUMBS_PATH, path.parse(r.filename).name + ".png");
  },
};

export default arena;
