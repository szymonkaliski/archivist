import fs from "fs";
import isReachable from "is-reachable";
import md5 from "md5";
import path from "path";
import puppeteer, { type Browser } from "puppeteer";
import { JSDOM } from "jsdom";

import { createLogger } from "../../logger";
import { sourceAssetsDir, sourceFrozenDir } from "../../paths";

const log = createLogger("pinboard");

const ASSETS_PATH = sourceAssetsDir("pinboard");
const FROZEN_PATH = sourceFrozenDir("pinboard");

const FREEZE_DRY_PATH = path.join(
  import.meta.dirname,
  "assets/freeze-dry-browserified.js",
);

let FREEZE_DRY_SRC: string;
const getFreezeDrySrc = () => {
  if (!FREEZE_DRY_SRC) {
    FREEZE_DRY_SRC = fs.readFileSync(FREEZE_DRY_PATH, "utf-8");
  }
  return FREEZE_DRY_SRC;
};

const WAYBACK_API = "https://archive.org/wayback/available?url=";
const ARCHIVE_TODAY_BASE = "https://archive.today/newest/";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SavedPaths {
  screenshot?: string;
  frozen?: string;
}

export interface PinboardLink {
  href: string;
  hash: string;
  meta: string;
  description: string;
  extended: string;
  tags: string;
  time: string;
}

export type FetcherResult =
  | { kind: "saved"; link: PinboardLink; fulltext: string; paths: SavedPaths }
  | { kind: "permanently_failed"; link: PinboardLink };

type SavePageResult =
  | { kind: "saved"; paths: SavedPaths }
  | { kind: "permanently_failed" };

const savePageInternal = async (
  browser: Browser,
  link: string,
  url: string,
): Promise<SavedPaths | null> => {
  const screenshotPath = path.join(ASSETS_PATH, `${md5(url)}.png`);
  const frozenPath = path.join(FROZEN_PATH, `${md5(url)}.html`);

  if (fs.existsSync(screenshotPath) && fs.existsSync(frozenPath)) {
    log.info("already downloaded: %s", link);
    return {
      screenshot: path.basename(screenshotPath),
      frozen: path.basename(frozenPath),
    };
  }

  log.info("saving: %s", link);

  const page = await browser.newPage();
  page.on("error", async () => { await page.close(); });

  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

  let didOpen: boolean;
  try {
    await page.goto(link, { waitUntil: "load" });
    didOpen = true;
  } catch (e: any) {
    log.error("error navigating: %s %s", link, e.toString());
    didOpen = false;
  }

  if (!didOpen) {
    await page.close();
    return null;
  }

  let didScreenshot: boolean;
  try {
    log.debug("screenshot: %s", link);
    await page.screenshot({ path: screenshotPath });
    didScreenshot = true;
  } catch {
    didScreenshot = false;
  }

  let didFreeze: boolean;
  try {
    log.debug("freeze: %s", link);
    await page.evaluate(getFreezeDrySrc());
    const frozen = await Promise.race([
      page.evaluate(`window.freezeDry()`),
      wait(5000),
    ]);
    if (typeof frozen === "string") {
      fs.writeFileSync(frozenPath, frozen, "utf-8");
      didFreeze = true;
    } else {
      didFreeze = false;
    }
  } catch {
    didFreeze = false;
  }

  await page.close();

  return {
    screenshot: didScreenshot ? path.basename(screenshotPath) : undefined,
    frozen: didFreeze ? path.basename(frozenPath) : undefined,
  };
};

const tryWayback = async (link: string): Promise<string | null> => {
  try {
    const res = await globalThis.fetch(
      `${WAYBACK_API}${encodeURIComponent(link)}`,
    );
    const data = await res.json();
    const closest = data?.archived_snapshots?.closest;
    if (closest?.available && closest?.url) {
      log.info("found wayback for %s -> %s", link, closest.url);
      return closest.url;
    }
    log.warn("couldn't find wayback for: %s", link);
  } catch (e: any) {
    log.error("wayback lookup failed for: %s %s", link, e.toString());
  }
  return null;
};

const tryArchiveToday = async (link: string): Promise<string | null> => {
  try {
    const res = await globalThis.fetch(`${ARCHIVE_TODAY_BASE}${link}`, {
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        log.info("found archive.today for %s -> %s", link, location);
        return location;
      }
    }
    log.warn("couldn't find archive.today for: %s", link);
  } catch (e: any) {
    log.error("archive.today lookup failed for: %s %s", link, e.toString());
  }
  return null;
};

const savePage = async (
  browser: Browser,
  link: string,
): Promise<SavePageResult> => {
  const isOnline = await isReachable(link);

  const tryArchives = async (): Promise<SavePageResult> => {
    const waybackUrl = await tryWayback(link);
    if (waybackUrl) {
      const paths = await savePageInternal(browser, waybackUrl, link);
      if (paths) return { kind: "saved", paths };
    }
    const archiveTodayUrl = await tryArchiveToday(link);
    if (archiveTodayUrl) {
      const paths = await savePageInternal(browser, archiveTodayUrl, link);
      if (paths) return { kind: "saved", paths };
    }
    return { kind: "permanently_failed" };
  };

  if (!isOnline) {
    log.info("offline, trying archives for: %s", link);
    return tryArchives();
  }

  const paths = await savePageInternal(browser, link, link);
  if (paths) return { kind: "saved", paths };

  log.info("navigation failed, trying archives for: %s", link);
  return tryArchives();
};

const getFulltext = async (frozenPath: string): Promise<string> => {
  try {
    const DOM = await JSDOM.fromFile(frozenPath);
    return DOM.window.document.body.textContent || "";
  } catch (e: any) {
    log.warn("failed to extract fulltext from %s: %s", frozenPath, e.message);
    return "";
  }
};

export const fetchLinks = async (
  links: PinboardLink[],
  concurrency = 10,
): Promise<(FetcherResult | null)[]> => {
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
  });

  try {
    const results: (FetcherResult | null)[] = [];
    const queue = [...links];

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const link = queue.shift()!;
        try {
          const result = await savePage(browser, link.href);
          if (result.kind === "permanently_failed") {
            results.push({ kind: "permanently_failed", link });
          } else {
            const fulltext = result.paths.frozen
              ? await getFulltext(path.join(FROZEN_PATH, result.paths.frozen))
              : "";
            results.push({ kind: "saved", link, fulltext, paths: result.paths });
          }
        } catch (e: any) {
          log.error("uncaught error %s %s", link.href, e.toString());
          results.push(null);
        }
      }
    });

    await Promise.all(workers);
    return results;
  } finally {
    await browser.close();
  }
};
