import fs from "fs";
import { CONFIG_FILE, ensureDirs } from "./paths";
import { createLogger } from "./logger";
import type { AppConfig, SourceKind, SourceConfigMap } from "./types";

const log = createLogger("config");

const VALID_SOURCES: Set<string> = new Set<SourceKind>([
  "pinboard",
  "pinterest",
  "screenshot",
]);

export const loadConfig = (): AppConfig => {
  ensureDirs();

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (e) {
    log.error(`failed to read config at ${CONFIG_FILE}: ${e}`);
    process.exit(1);
  }

  const config: AppConfig = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!VALID_SOURCES.has(key)) {
      log.warn(`unknown source "${key}" in config, skipping`);
      continue;
    }
    (config as any)[key] = value;
  }

  return config;
};

export const configuredSources = (
  config: AppConfig,
): Array<{ kind: SourceKind; config: SourceConfigMap[SourceKind] }> =>
  (Object.entries(config) as Array<[SourceKind, SourceConfigMap[SourceKind]]>)
    .filter(([, cfg]) => cfg != null)
    .map(([kind, cfg]) => ({ kind, config: cfg }));

export { CONFIG_FILE };
