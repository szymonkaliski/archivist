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

interface ArenaBlock {
  id: number;
  type: "Image" | "Text" | "Link" | "Media" | "Attachment";
  base_type: "Block" | "Channel";
  title: string | null;
  description: string | { plain: string } | null;
  content: string | null;
  created_at: string;
  updated_at: string;
  source: ArenaSource | null;
  image: ArenaImage | null;
  attachment: ArenaAttachment | null;
  connection: {
    connected_at: string;
  };
}

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

const MAX_RETRIES = 5;

const apiFetch = async (
  endpoint: string,
  token: string,
  params?: Record<string, string | number>,
  retries = 0,
): Promise<any> => {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    if (retries >= MAX_RETRIES) {
      throw new Error(`rate limited after ${MAX_RETRIES} retries: ${endpoint}`);
    }
    const reset = res.headers.get("X-RateLimit-Reset");
    const waitMs = reset
      ? Math.max(0, Number(reset) * 1000 - Date.now())
      : 60_000;
    log.warn(
      `rate limited, waiting ${Math.ceil(waitMs / 1000)}s (retry ${retries + 1}/${MAX_RETRIES})`,
    );
    await new Promise((r) => setTimeout(r, waitMs + 1000));
    return apiFetch(endpoint, token, params, retries + 1);
  }

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${endpoint}`);
  }

  return res.json();
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
    const res = await fetch(url);
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(new URL(url).pathname).split("?")[0] || ".jpg";
    const filename = `${blockId}${ext}`;
    const dest = path.join(ASSETS_PATH, filename);

    fs.writeFileSync(dest, buf);

    try {
      const size = imageSize(new Uint8Array(buf));
      return { filename, width: size.width || 0, height: size.height || 0 };
    } catch {
      return { filename, width: 0, height: 0 };
    }
  } catch (e: any) {
    log.error("download failed for block %d: %s", blockId, e.message);
    return null;
  }
};

const downloadAttachmentAsGif = async (
  url: string,
  blockId: number,
): Promise<{ filename: string; width: number; height: number } | null> => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    const mp4Path = path.join(ASSETS_PATH, `${blockId}.mp4`);
    const gifFilename = `${blockId}.gif`;
    const gifPath = path.join(ASSETS_PATH, gifFilename);

    fs.writeFileSync(mp4Path, buf);

    await execFileAsync("ffmpeg", [
      "-i",
      mp4Path,
      "-vf",
      "fps=15,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a",
      "-y",
      gifPath,
    ]);

    fs.unlinkSync(mp4Path);

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
        if (w <= THUMB_SIZE && h <= THUMB_SIZE) {
          fs.copyFileSync(inputPath, outputPath);
        } else {
          await sharp(inputPath).resize(THUMB_SIZE).png().toFile(outputPath);
        }
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

    // insert new blocks
    const newBlocks = [...blockData.entries()].filter(
      ([id]) => !existingIds.has(id),
    );

    log.info(`new blocks to fetch: ${newBlocks.length}`);

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
        if (isVideo && block.attachment) {
          const downloaded = await downloadAttachmentAsGif(
            block.attachment.url,
            blockId,
          );
          if (downloaded) {
            filename = downloaded.filename;
            width = downloaded.width;
            height = downloaded.height;
          }
        } else if (block.image?.src) {
          const downloaded = await downloadImage(block.image.src, blockId);
          if (downloaded) {
            filename = downloaded.filename;
            width = downloaded.width;
            height = downloaded.height;
          }
        }

        results.push({
          global_id: globalId(blockId),
          block_id: blockId,
          title: block.title || null,
          description:
            (typeof block.description === "object"
              ? block.description?.plain
              : block.description) || null,
          content: block.content || null,
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
