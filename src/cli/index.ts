import fs from "fs";
import { spawn } from "child_process";
import Yargs from "yargs";

import { createLogger } from "../logger";
import { loadConfig, configuredSources, CONFIG_FILE } from "../config";
import { openDb } from "../db";
import { SOURCES } from "../sources/registry";
import { search } from "../search";
import { generateEmbeddings, type EmbedItem } from "../embeddings";
import { ensureDirs } from "../paths";
import type { SourceKind } from "../types";

const log = createLogger("cli");

const parser = Yargs(process.argv.slice(2))
  .command("config", "open configuration file")
  .command("fetch [source]", "fetch all (or one) configured source", (yargs) =>
    yargs.positional("source", { type: "string", describe: "source to fetch" }),
  )
  .command("search [query]", "search all sources", (yargs) =>
    yargs
      .positional("query", { type: "string" })
      .option("limit", { type: "number", description: "limit results" })
      .option("json", { type: "boolean", description: "output as JSON" }),
  )
  .command("query [query]", false)
  .demandCommand(1, "you need to provide a command")
  .help();

const args = parser.parseSync();
const [TYPE] = args._;

if (TYPE === "config") {
  ensureDirs();
  const editor = process.env.EDITOR || "vim";
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2), "utf-8");
  }
  spawn(editor, [CONFIG_FILE], { stdio: "inherit" });
} else if (TYPE === "fetch") {
  const config = loadConfig();
  const db = openDb();
  const sources = configuredSources(config);
  const sourceFilter = args.source as string | undefined;

  const toFetch = sourceFilter
    ? sources.filter((s) => s.kind === sourceFilter)
    : sources;

  if (toFetch.length === 0) {
    log.warn("no sources to fetch");
    process.exit(0);
  }

  (async () => {
    for (const { kind, config: cfg } of toFetch) {
      const source = SOURCES[kind];
      log.info(`fetching ${kind}...`);
      try {
        await source.fetch(db, cfg as any);

        // generate embeddings for this source
        const rows = db
          .prepare(`SELECT * FROM ${source.dataTable}`)
          .all() as Record<string, unknown>[];

        const items: EmbedItem[] = rows
          .map((row) => ({
            id: row.global_id as string,
            thumbPath: source.thumbPath(row),
            text: source.embeddingText(row),
          }))
          .filter((item) => item.thumbPath.length > 0);

        await generateEmbeddings(db, items);
      } catch (e) {
        log.error(`[${kind}] fetch error: ${e}`);
      }
    }
    db.close();
    process.exit(0);
  })();
} else if (TYPE === "search" || TYPE === "query") {
  const config = loadConfig();
  const db = openDb();
  const query = args._[1] as string | undefined;
  const limit = args.limit as number | undefined;

  const result = search(db, {
    text: query,
    limit,
  });

  if (args.json) {
    console.log(JSON.stringify(result.items));
  } else {
    for (const item of result.items) {
      console.log(JSON.stringify(item));
    }
  }

  db.close();
  process.exit(0);
} else {
  parser.showHelp();
}
