import assert from "assert";
import fs from "fs";
import * as chrome from "chrome-cookies-secure";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { createLogger } from "../../logger";
import { sourceSessionDir } from "../../paths";
import type { PinterestConfig } from "../../types";
import { withRetry } from "../../retry";

const log = createLogger("pinterest");

puppeteer.use(StealthPlugin());

const ROOT = "https://pinterest.com";

const NAV_TIMEOUT = 60000;
const LOGIN_TIMEOUT = 60000;
// boards that respond at all do so in a few seconds, so a miss is cheap to
// detect and retrying costs far less than a long single attempt
const BOARD_FEED_TIMEOUT = 20000;
const BOARD_ATTEMPTS = 3;
const PROFILE_ATTEMPTS = 3;
const PROFILE_BACKOFF_BASE_MS = 2000;

// present only once the authenticated shell has rendered
const LOGGED_IN_SELECTOR =
  '[data-test-id=header-profile], [data-test-id=homefeed-feed], [aria-label="Saved"]';

const LOCKOUT_RE = /too many login attempts|zbyt wiele prób/i;

// Pinterest authenticates through this XHR and stays on the same document, so
// the submit never performs a navigation that could be awaited.
const SESSION_ENDPOINT = "/resource/UserSessionResource/create/";

// The logged-out page also carries an off-screen signup form owning plain
// #email / #password, so the login modal's own fields are addressed explicitly.
const LOGIN_EMAIL = "#streamlined-login-email";
const LOGIN_PASSWORD = "#streamlined-login-password";
const LOGIN_SUBMIT = `form:has(${LOGIN_PASSWORD}) button[type="submit"]`;

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

const crawlBoardOnce = async (
  page: any,
  boardUrl: string,
  profile: string,
  knownPinIds?: string[],
): Promise<CrawledPin[]> => {
  const boardName = boardUrl.split("/").filter(Boolean).pop()!;

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
    { timeout: BOARD_FEED_TIMEOUT },
  );

  await page.goto(boardUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
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
};

// The feed request is intermittently not observed within the timeout; a fresh
// navigation recovers it. Throws once the attempts are spent, because an empty
// result here is indistinguishable from a board whose pins were all removed.
const crawlBoard = async (
  page: any,
  boardUrl: string,
  profile: string,
  knownPinIds?: string[],
): Promise<CrawledPin[]> => {
  log.info("crawling board %s", boardUrl);

  return withRetry(
    {
      label: `board ${boardUrl}`,
      attempts: BOARD_ATTEMPTS,
      backoff: { kind: "immediate" },
      log,
    },
    async () => ({
      kind: "done",
      value: await crawlBoardOnce(page, boardUrl, profile, knownPinIds),
    }),
  );
};

// An empty board list aborts the whole source, and Pinterest intermittently
// serves the profile before the board grid renders, so an empty result is
// retried rather than trusted.
const crawlProfile = async (
  page: any,
  profileUrl: string,
): Promise<string[]> => {
  log.info("crawling profile %s", profileUrl);

  return withRetry(
    {
      label: `profile ${profileUrl}`,
      attempts: PROFILE_ATTEMPTS,
      backoff: { kind: "exponential", baseMs: PROFILE_BACKOFF_BASE_MS },
      log,
    },
    async () => {
      await page.goto(profileUrl, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
      const boards: string[] = await page.evaluate(`
        Array.from(document.querySelectorAll('[aria-label="Board"]')).map(
          (el) => el.querySelector("a").href
        )
      `);

      if (boards.length === 0) {
        return { kind: "retry", reason: "no boards on profile page" };
      }
      return { kind: "done", value: boards };
    },
  );
};

const isLoggedIn = (page: any): Promise<boolean> =>
  page
    .evaluate(`!!document.querySelector(${JSON.stringify(LOGGED_IN_SELECTOR)})`)
    .catch(() => false);

const isLockedOut = async (page: any): Promise<boolean> => {
  const text = await page
    .evaluate(`document.body ? document.body.innerText.slice(0, 2000) : ""`)
    .catch(() => "");
  return LOCKOUT_RE.test(String(text));
};

// A consent dialog covers the page in the EU and swallows the login click.
const dismissCookieConsent = async (page: any) => {
  const dismissed = await page
    .evaluate(
      `(() => {
        var btn = Array.from(document.querySelectorAll("button")).find(function (b) {
          return /accept all|akceptuj wszystk/i.test(b.innerText || "");
        });
        if (!btn) return false;
        btn.click();
        return true;
      })()`,
    )
    .catch(() => false);

  if (dismissed) {
    log.info("dismissed cookie consent");
    await sleep(2000);
  }
};

const loginWithCreds = async (page: any, email: string, password: string) => {
  await dismissCookieConsent(page);

  await page.click("[data-test-id=simple-login-button] > button");
  await page.waitForSelector(LOGIN_EMAIL, {
    visible: true,
    timeout: LOGIN_TIMEOUT,
  });

  await page.type(LOGIN_EMAIL, email);
  await sleep(1000);
  await page.type(LOGIN_PASSWORD, password);
  await sleep(1000);

  // Armed before the click so a fast response cannot land first.
  const authStatus = page
    .waitForResponse((r: any) => r.url().includes(SESSION_ENDPOINT), {
      timeout: LOGIN_TIMEOUT,
    })
    .then((r: any) => r.status())
    .catch(() => null);

  await page.click(LOGIN_SUBMIT);

  const status = await authStatus;
  if (status === 401 || status === 403) {
    throw new Error(`credentials rejected (HTTP ${status})`);
  }
  if (status === 429) {
    throw new Error("login rate limited by pinterest, wait before retrying");
  }

  // The authenticated shell renders after the XHR resolves, so success is
  // confirmed against the DOM rather than the status code alone.
  const deadline = Date.now() + LOGIN_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return;
    if (await isLockedOut(page)) {
      throw new Error(
        "pinterest answered the login with a rate-limit challenge, wait before retrying",
      );
    }
    await sleep(1000);
  }

  throw new Error(`login did not complete (url: ${page.url()})`);
};

const loginWithCookiesFromChrome = async (page: any) => {
  const cookies = await new Promise<any[]>((resolve, reject) => {
    chrome.getCookies(ROOT, "puppeteer", (err: any, result: any[]) => {
      if (err) reject(err);
      else resolve(result ?? []);
    });
  });

  await page.setCookie(...cookies);
  await page.goto(ROOT, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });

  if (!(await isLoggedIn(page))) {
    throw new Error("chrome cookies did not produce a logged-in session");
  }
};

export interface PinterestSession {
  browser: any;
  page: any;
}

const openSession = async (
  options: PinterestConfig,
): Promise<PinterestSession> => {
  assert(options.profile, "requires profile option");

  // Chrome persists its cookie jar here, so a session survives across runs and
  // the credential login is only reached when it has actually expired.
  const sessionDir = sourceSessionDir("pinterest");
  fs.mkdirSync(sessionDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 0,
    userDataDir: sessionDir,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
    await page.goto(ROOT, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });

    if (await isLoggedIn(page)) {
      log.info("reusing stored session");
      return { browser, page };
    }

    log.info("stored session invalid, logging in via %s", options.loginMethod);
    if (options.loginMethod === "cookies") {
      await loginWithCookiesFromChrome(page);
    } else if (options.loginMethod === "password") {
      await loginWithCreds(page, options.username!, options.password!);
    } else {
      throw new Error("invalid login option");
    }

    return { browser, page };
  } catch (e) {
    await browser.close();
    throw e;
  }
};

// One browser for the whole run: the profile directory is locked by the running
// Chrome, and each login costs a credential attempt against Pinterest's limiter.
export const withSession = async <T>(
  options: PinterestConfig,
  fn: (session: PinterestSession) => Promise<T>,
): Promise<T> => {
  const session = await openSession(options);
  try {
    return await fn(session);
  } finally {
    await session.browser.close();
  }
};

export interface BoardCrawl {
  pins: CrawledPin[];
  failedBoards: string[];
  totalBoards: number;
}

export const crawlBoards = async (
  session: PinterestSession,
  options: PinterestConfig,
  recentPinIdsByBoard?: Map<string, string[]>,
): Promise<BoardCrawl> => {
  const { page } = session;

  const boards = await crawlProfile(
    page,
    ROOT + "/" + options.profile + "/boards",
  );

  const pins: CrawledPin[] = [];
  const failedBoards: string[] = [];
  for (const board of boards) {
    const boardName = board.split("/").filter(Boolean).pop()!;
    const knownPinIds = recentPinIdsByBoard?.get(boardName);
    try {
      const boardPins = await crawlBoard(
        page,
        board,
        options.profile!,
        knownPinIds,
      );
      log.info("board pins: %s %d", board, boardPins.length);
      pins.push(...boardPins.map((pin) => ({ ...pin, board: boardName })));
    } catch (e: any) {
      log.error("giving up on board %s: %s", board, e.message);
      failedBoards.push(boardName);
    }
  }
  return { pins, failedBoards, totalBoards: boards.length };
};

export const crawlPinMetadata = async (
  session: PinterestSession,
  options: PinterestConfig,
  pins: CrawledPin[],
): Promise<CrawledPinWithMetadata[]> => {
  const { browser } = session;
  const concurrency = options.concurrency || 4;

  const profile = options.profile?.toLowerCase();

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
};
