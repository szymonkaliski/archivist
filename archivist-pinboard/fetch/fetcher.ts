import async from "async";
import envPaths from "env-paths";
import fs from "fs";
import isReachable from "is-reachable";
import md5 from "md5";
import path from "path";
import puppeteer, { type Browser } from "puppeteer";
import { JSDOM } from "jsdom";

import { createLogger } from "archivist-logger";

const log = createLogger("pinboard");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

fs.mkdirSync(ASSETS_PATH, { recursive: true });
fs.mkdirSync(FROZEN_PATH, { recursive: true });

const FREEZE_DRY_PATH = path.join(
  __dirname,
  "./assets/freeze-dry-browserified.js",
);

const FREEZE_DRY_SRC = fs.readFileSync(FREEZE_DRY_PATH, "utf-8");

const WAYBACK_API = "https://archive.org/wayback/available?url=";

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

const savePageInternal = async (
  browser: Browser,
  link: string,
  url: string,
): Promise<SavedPaths | null> => {
  const screenshotPath = path.join(ASSETS_PATH, `${md5(url)}.png`);
  const frozenPath = path.join(FROZEN_PATH, `${md5(url)}.html`);

  let didScreenshot: boolean, didFreeze: boolean, didOpen: boolean;

  if (fs.existsSync(screenshotPath) && fs.existsSync(frozenPath)) {
    log.info("already downloaded: %s", link);
    return {
      screenshot: path.basename(screenshotPath),
      frozen: path.basename(frozenPath),
    };
  }

  log.info("saving: %s", link);

  const page = await browser.newPage();

  page.on("error", async () => {
    await page.close();

    return null;
  });

  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

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

  try {
    log.debug("screenshot: %s", link);
    await page.screenshot({ path: screenshotPath });

    didScreenshot = true;
  } catch (e) {
    didScreenshot = false;
  }

  try {
    log.debug("freeze: %s", link);
    await page.evaluate(FREEZE_DRY_SRC);

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
  } catch (e) {
    didFreeze = false;
  }

  await page.close();

  return {
    screenshot:
      didScreenshot === true ? path.basename(screenshotPath) : undefined,
    frozen: didFreeze === true ? path.basename(frozenPath) : undefined,
  };
};

const savePage = async (
  browser: Browser,
  link: string,
): Promise<SavedPaths | null> => {
  const isOnline = await isReachable(link);

  if (!isOnline) {
    log.info("offline, trying wayback for: %s", link);

    try {
      const res = await globalThis.fetch(
        `${WAYBACK_API}${encodeURIComponent(link)}`,
      );
      const data = await res.json();
      const closest = data?.archived_snapshots?.closest;
      const isClosest = closest && !!closest.available && !!closest.url;

      if (!isClosest) {
        log.warn("couldn't find wayback for: %s", link);
        return null;
      }

      log.info("found wayback for %s -> %s", link, closest.url);

      return await savePageInternal(browser, closest.url, link);
    } catch (e: any) {
      log.error("wayback lookup failed for: %s %s", link, e.toString());
      return null;
    }
  }

  return await savePageInternal(browser, link, link);
};

const getFulltext = async (frozenPath: string): Promise<string> => {
  const DOM = await JSDOM.fromFile(frozenPath);
  return DOM.window.document.body.textContent || "";
};

const run = async (links: PinboardLink[], concurrency = 10) => {
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
  });

  return new Promise((resolve, reject) => {
    async.mapLimit(
      links,
      concurrency,
      (link: PinboardLink, callback: (err: any, result?: any) => void) => {
        savePage(browser, link.href)
          .then(async (paths) => {
            if (!paths) {
              callback(null, null);
              return;
            }

            const fulltext = paths.frozen
              ? await getFulltext(path.join(FROZEN_PATH, paths.frozen))
              : "";

            callback(null, { ...link, fulltext, paths });
          })
          .catch((e) => {
            log.error("uncaught error %s %s", link.href, e.toString());
            callback(null, null);
          });
      },
      (err: any, res: any) => {
        browser.close().then(() => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        });
      },
    );
  });
};

export default run;
