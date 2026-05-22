import assert from "assert";
import * as chrome from "chrome-cookies-secure";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { createLogger } from "../../logger";
import type { PinterestConfig } from "../../types";

const log = createLogger("pinterest");

puppeteer.use(StealthPlugin());

const ROOT = "https://pinterest.com";

const sleep = (time: number) =>
  new Promise((resolve) => setTimeout(resolve, time));

export interface CrawledPin {
  url: string;
  src: string;
  alt: string;
  srcset: string;
  biggestSrc: string;
  board: string;
}

export interface PinMetadata {
  link?: string;
  title?: string;
  text?: string;
  createdAt?: string;
  boardOwner?: string;
  pinner?: string;
  isPromoted?: boolean;
}

export type CrawledPinWithMetadata = CrawledPin & PinMetadata;

const crawlPin = async (browser: any, pinUrl: string): Promise<PinMetadata> => {
  log.debug("crawling pin %s", pinUrl);

  let page: any;
  try {
    page = await browser.newPage();
  } catch (e: any) {
    log.error("error opening page for %s %s", pinUrl, e.message);
    return {};
  }

  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });

  try {
    await page.goto(pinUrl, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e: any) {
    log.error("error when going to %s: %s", pinUrl, e.message);
    try {
      await page.close();
    } catch (_) {}
    return {};
  }

  let meta: PinMetadata = {};
  try {
    meta = (await page.evaluate(`(()=>{
      var pinId = location.pathname.split("/").filter(Boolean).pop();
      var readPin = function() {
        try {
          var el = document.getElementById("__PWS_INITIAL_PROPS__");
          if (!el) return null;
          var pins = JSON.parse(el.textContent).initialReduxState.pins;
          if (!pins) return null;
          return pins[pinId] || pins[Object.keys(pins)[0]] || null;
        } catch (e) { return null; }
      };
      var extract = function(p) {
        if (!p) return {};
        var board = p.board || {};
        var boardOwner = (board.owner && board.owner.username)
          || (board.url ? board.url.split("/").filter(Boolean)[0] : undefined);
        var pinner = p.pinner && p.pinner.username;
        var isPromoted = !!(p.is_promoted || p.is_active_ad
          || p.has_been_boost_promoted || p.promoted_is_lead_ad);
        return {
          link: p.link || undefined,
          title: p.grid_title || p.closeup_unified_title || undefined,
          text: p.description || p.closeup_unified_description || undefined,
          createdAt: p.created_at || undefined,
          boardOwner: boardOwner || undefined,
          pinner: pinner || undefined,
          isPromoted: isPromoted,
        };
      };
      return new Promise(function(resolve) {
        var data = extract(readPin());
        if (data.createdAt || data.link || data.title) { resolve(data); return; }
        // redux state is sometimes filled after initial render
        setTimeout(function() { resolve(extract(readPin())); }, 1500);
      });
    })()`)) as PinMetadata;
  } catch (e: any) {
    log.error("error evaluating pin %s: %s", pinUrl, e.message);
  }

  try {
    await page.close();
  } catch (_) {}

  return meta;
};

// Paginate a board's BoardFeedResource by replaying the page's own feed request
// (valid session/CSRF headers). The first page is forced by stripping any captured
// `bookmarks`; subsequent pages follow `bookmark` until it's absent (end-of-feed).
// This feed contains ONLY pins saved to the board - Pinterest serves "More ideas"
// recommendations from a separate endpoint - so there is nothing to scrape or
// boundary-detect, and it is independent of UI text/locale.
const PIN_PAGINATE = `(async (firstUrl, headers, knownIds) => {
  var known = new Set(knownIds || []);
  var seen = {};
  var pins = [];
  var bookmark = null;
  var pages = 0;
  var stop = false;
  for (;;) {
    var u = new URL(firstUrl);
    var data = JSON.parse(u.searchParams.get("data"));
    if (!data.options) data.options = {};
    if (bookmark) data.options.bookmarks = [bookmark];
    else delete data.options.bookmarks;
    u.searchParams.set("data", JSON.stringify(data));
    u.searchParams.set("_", String(Date.now()));
    var r = await fetch(u.toString(), { headers: headers, credentials: "include" });
    if (!r.ok) break;
    var j = await r.json();
    var rr = j.resource_response || {};
    var arr = Array.isArray(rr.data) ? rr.data : [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (!p || p.type !== "pin" || !p.id || seen[p.id]) continue;
      if (known.size > 0 && known.has(p.id)) { stop = true; break; }
      seen[p.id] = true;
      var imgs = p.images || {};
      var orig = imgs.orig || {};
      pins.push({
        url: location.origin + "/pin/" + p.id + "/",
        biggestSrc: orig.url || "",
        src: (imgs["474x"] && imgs["474x"].url) || orig.url || "",
        alt: p.description || p.grid_title || p.title || "",
        srcset: "",
      });
    }
    pages++;
    if (stop) break;
    if (!("bookmark" in rr)) break;
    bookmark = rr.bookmark;
    if (!bookmark) break;
    if (pages > 300) break;
    await new Promise(function (res) { setTimeout(res, 120); });
  }
  return pins;
})`;

const crawlBoard = async (
  page: any,
  boardUrl: string,
  profile: string,
  knownPinIds?: string[],
): Promise<CrawledPin[]> => {
  log.info("crawling board %s", boardUrl);
  const boardName = boardUrl.split("/").filter(Boolean).pop()!;

  try {
    // require the captured feed request to belong to THIS board (its source_url
    // carries the board path) so we never replay a neighbouring board's request
    const waitFirst = page.waitForResponse(
      (r: any) => {
        const u = r.url();
        return (
          /\/resource\/BoardFeedResource\/get\//.test(u) &&
          decodeURIComponent(u).includes(`/${profile}/${boardName}/`)
        );
      },
      { timeout: 45000 },
    );

    await page.goto(boardUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const firstReq = (await waitFirst).request();
    const firstUrl = firstReq.url();
    const rawHeaders = firstReq.headers();
    const skip = new Set([
      "cookie",
      "host",
      "content-length",
      "accept-encoding",
      "connection",
      "content-type",
    ]);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (k.startsWith(":") || skip.has(k.toLowerCase())) continue;
      headers[k] = v as string;
    }

    const pins = (await page.evaluate(
      `(${PIN_PAGINATE})(${JSON.stringify(firstUrl)}, ${JSON.stringify(headers)}, ${JSON.stringify(knownPinIds ?? [])})`,
    )) as CrawledPin[];

    return pins.filter((pin) => pin.biggestSrc && pin.biggestSrc.length > 0);
  } catch (e: any) {
    log.error("error crawling board %s: %s", boardUrl, e.message);
    return [];
  }
};

const crawlProfile = async (
  page: any,
  profileUrl: string,
): Promise<string[]> => {
  log.info("crawling profile %s", profileUrl);
  await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });
  return await page.evaluate(`
    Array.from(document.querySelectorAll('[aria-label="Board"]')).map(
      (el) => el.querySelector("a").href
    )
  `);
};

const loginWithCreds = async (page: any, email: string, password: string) => {
  await page.goto(ROOT, { waitUntil: "networkidle2", timeout: 60000 });
  await page.click("[data-test-id=simple-login-button] > button");
  await sleep(2000);
  await page.type("#email", email);
  await sleep(2000);
  await page.type("#password", password);
  await sleep(2000);
  await page.click("[data-test-id=registerFormSubmitButton] > button");
  await page.waitForNavigation();
};

const loginWithCookiesFromChrome = async (page: any) =>
  new Promise<void>((resolve) => {
    chrome.getCookies(ROOT, "puppeteer", (_err: any, cookies: any[]) => {
      page.setCookie(...cookies).then(() => {
        page.goto(ROOT, { waitUntil: "networkidle2" }).then(() => {
          resolve();
        });
      });
    });
  });

const createBrowser = async (options: PinterestConfig) => {
  assert(options.profile, "requires profile option");

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 0,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });

  if (options.loginMethod === "cookies") {
    await loginWithCookiesFromChrome(page);
  } else if (options.loginMethod === "password") {
    await loginWithCreds(page, options.username!, options.password!);
  } else {
    throw new Error("invalid login option");
  }

  return { browser, page };
};

export const crawlBoards = async (
  options: PinterestConfig,
  recentPinIdsByBoard?: Map<string, string[]>,
): Promise<CrawledPin[]> => {
  const { browser, page } = await createBrowser(options);

  try {
    const boards = await crawlProfile(
      page,
      ROOT + "/" + options.profile + "/boards",
    );

    const allPins: CrawledPin[] = [];
    for (const board of boards) {
      const boardName = board.split("/").filter(Boolean).pop()!;
      const knownPinIds = recentPinIdsByBoard?.get(boardName);
      try {
        const pins = await crawlBoard(
          page,
          board,
          options.profile!,
          knownPinIds,
        );
        log.info("board pins: %s %d", board, pins.length);
        allPins.push(...pins.map((pin) => ({ ...pin, board: boardName })));
      } catch (e: any) {
        log.error("error crawling board %s: %s", board, e.message);
      }
    }
    return allPins;
  } finally {
    await browser.close();
  }
};

export const crawlPinMetadata = async (
  options: PinterestConfig,
  pins: CrawledPin[],
): Promise<CrawledPinWithMetadata[]> => {
  const { browser } = await createBrowser(options);
  const concurrency = options.concurrency || 4;

  const profile = options.profile?.toLowerCase();

  try {
    const results: CrawledPinWithMetadata[] = [];
    const queue = [...pins];
    let droppedPromoted = 0;
    let droppedForeign = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const pin = queue.shift()!;
        try {
          const meta = await crawlPin(browser, pin.url);

          if (meta.isPromoted) {
            droppedPromoted++;
            log.warn(
              "dropping promoted pin %s (owner=%s pinner=%s)",
              pin.url,
              meta.boardOwner,
              meta.pinner,
            );
            continue;
          }

          // "More ideas" recommendations aren't promoted; drop pins owned by others
          // (undefined owner = crawl failure, keep to avoid losing real pins).
          if (
            profile &&
            meta.boardOwner &&
            meta.boardOwner.toLowerCase() !== profile
          ) {
            droppedForeign++;
            log.warn(
              "dropping foreign pin %s (owner=%s, not %s)",
              pin.url,
              meta.boardOwner,
              options.profile,
            );
            continue;
          }

          results.push({ ...pin, ...meta });
        } catch (e: any) {
          log.error("error crawling pin %s: %s", pin.url, e.message);
          results.push({ ...pin });
        }
      }
    });

    await Promise.all(workers);
    if (droppedPromoted) {
      log.info("dropped %d promoted pins", droppedPromoted);
    }
    if (droppedForeign) {
      log.info(
        "dropped %d foreign pins (not owned by %s)",
        droppedForeign,
        options.profile,
      );
    }
    return results;
  } finally {
    await browser.close();
  }
};
