import assert from "assert";
import fs from "fs";
import * as chrome from "chrome-cookies-secure";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { z } from "zod";

import { createLogger } from "../../logger";
import { sourceSessionDir } from "../../paths";
import type { PinterestConfig } from "../../types";
import { withRetry } from "../../retry";
import {
  formatZodError,
  nonEmptyString,
  verifyPageSelectors,
} from "../../validation";

const log = createLogger("pinterest");

puppeteer.use(StealthPlugin());

const ROOT = "https://pinterest.com";

const NAV_TIMEOUT = 60000;
const LOGIN_TIMEOUT = 60000;
// Measured over 32 board loads: the request arrives 1.7-2.4s after the
// navigation starts, or not at all - two boards still had not issued it after
// 25s. A miss is an absent request rather than a slow one, and what recovers it
// is the re-navigation the retry performs, not a longer wait. So this only has
// to outrun the slowest real arrival; every second beyond that is spent waiting
// for a request that is never coming.
const BOARD_FEED_TIMEOUT = 6000;
// the pagination loop runs inside the page, where page.evaluate imposes no
// timeout of its own, so a feed request that stalls would hang the crawl for
// the rest of the run. Aborting throws out of the page and costs one attempt.
const FEED_REQUEST_TIMEOUT = 30000;
const BOARD_ATTEMPTS = 3;
const PROFILE_ATTEMPTS = 3;
const PROFILE_BACKOFF_BASE_MS = 2000;
const PIN_ATTEMPTS = 3;
const PIN_BACKOFF_BASE_MS = 2000;

// present only once the authenticated shell has rendered
const LOGGED_IN_SELECTOR =
  '[data-test-id=header-profile], [data-test-id=homefeed-feed], [aria-label="Saved"]';

const PROFILE_BOARD_LINK_SELECTOR = '[aria-label="Board"] a[href]';

const LOCKOUT_RE = /too many login attempts|zbyt wiele prób/i;

// Pinterest authenticates through this XHR and stays on the same document, so
// the submit never performs a navigation that could be awaited.
const SESSION_ENDPOINT = "/resource/UserSessionResource/create/";

// The logged-out page also carries an off-screen signup form owning plain
// #email / #password, so the login modal's own fields are addressed explicitly.
const LOGIN_OPEN_BUTTON = "[data-test-id=simple-login-button] > button";
const LOGIN_EMAIL = "#streamlined-login-email";
const LOGIN_PASSWORD = "#streamlined-login-password";
const LOGIN_SUBMIT = `form:has(${LOGIN_PASSWORD}) button[type="submit"]`;

// libvips and browser <img> tags cannot decode Apple HEIC/HEIF uploads; when a
// pin's original asset is HEIC, fall back to the largest JPEG variant.
const UNSUPPORTED_IMAGE_RE = /\.(heic|heif)(\?|$)/i;

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

export type PinCrawlOutcome =
  | { kind: "ok"; meta: PinMetadata }
  | { kind: "drifted"; reason: string }
  | { kind: "failed"; reason: string };

const ImageVariantSchema = z.object({
  url: z.string().url(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const BoardFeedPinSchema = z.object({
  type: z.literal("pin"),
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  grid_title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  alt_text: z.string().nullable().optional(),
  auto_alt_text: z.string().nullable().optional(),
  images: z.object({
    orig: ImageVariantSchema,
    "1200x": ImageVariantSchema.optional(),
    "736x": ImageVariantSchema.optional(),
    "564x": ImageVariantSchema.optional(),
    "474x": ImageVariantSchema.optional(),
  }),
});

export type BoardFeedPin = z.infer<typeof BoardFeedPinSchema>;

export const selectPinImages = (
  images: BoardFeedPin["images"],
): { biggestSrc: string; src: string } => {
  const origUrl = images.orig.url;
  const biggestSrc = UNSUPPORTED_IMAGE_RE.test(origUrl)
    ? (images["1200x"]?.url ??
      images["736x"]?.url ??
      images["564x"]?.url ??
      images["474x"]?.url ??
      origUrl)
    : origUrl;
  const src = images["474x"]?.url ?? biggestSrc;
  return { biggestSrc, src };
};

export const toCrawledPin = (
  p: BoardFeedPin,
  origin: string,
  board: string,
): CrawledPin => {
  const { biggestSrc, src } = selectPinImages(p.images);
  const alt =
    nonEmptyString(p.description) ??
    nonEmptyString(p.grid_title) ??
    nonEmptyString(p.title) ??
    nonEmptyString(p.alt_text) ??
    nonEmptyString(p.auto_alt_text) ??
    "";

  return {
    url: `${origin}/pin/${p.id}/`,
    biggestSrc,
    src,
    alt,
    srcset: "",
    board,
  };
};

export const PinterestPinDetailSchema = z.object({
  id: z.string().min(1).optional(),
  link: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  grid_title: z.string().nullable().optional(),
  closeup_unified_title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  closeup_description: z.string().nullable().optional(),
  closeup_unified_description: z.string().nullable().optional(),
  closeup_user_note: z.string().nullable().optional(),
  alt_text: z.string().nullable().optional(),
  auto_alt_text: z.string().nullable().optional(),
  created_at: z.string().min(1),
  is_promoted: z.boolean().nullable().optional(),
  is_active_ad: z.boolean().nullable().optional(),
  has_been_boost_promoted: z.boolean().nullable().optional(),
  promoted_is_lead_ad: z.boolean().nullable().optional(),
  board: z
    .object({
      url: z.string().nullable().optional(),
      owner: z
        .object({
          username: z.string().min(1).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  pinner: z
    .object({
      username: z.string().min(1).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type PinterestPinDetail = z.infer<typeof PinterestPinDetailSchema>;

export const extractPinMetadata = (p: PinterestPinDetail): PinMetadata => {
  const boardOwner =
    nonEmptyString(p.board?.owner?.username) ??
    (p.board?.url
      ? nonEmptyString(p.board.url.split("/").filter(Boolean)[0])
      : undefined);
  const pinner = nonEmptyString(p.pinner?.username);
  const isPromoted = Boolean(
    p.is_promoted ||
    p.is_active_ad ||
    p.has_been_boost_promoted ||
    p.promoted_is_lead_ad,
  );

  return {
    link: nonEmptyString(p.link),
    title:
      nonEmptyString(p.grid_title) ??
      nonEmptyString(p.closeup_unified_title) ??
      nonEmptyString(p.title),
    text:
      nonEmptyString(p.description) ??
      nonEmptyString(p.closeup_unified_description) ??
      nonEmptyString(p.closeup_description) ??
      nonEmptyString(p.closeup_user_note) ??
      nonEmptyString(p.alt_text) ??
      nonEmptyString(p.auto_alt_text),
    createdAt: nonEmptyString(p.created_at),
    boardOwner,
    pinner,
    isPromoted,
  };
};

type RawPinPageEval =
  { status: "ok"; rawPin: unknown } | { status: "drifted"; reason: string };

export const crawlPin = async (
  browser: any,
  pinUrl: string,
): Promise<PinCrawlOutcome> => {
  log.debug("crawling pin %s", pinUrl);
  let lastDriftedReason: string | null = null;

  try {
    const meta = await withRetry(
      {
        label: `pin ${pinUrl}`,
        attempts: PIN_ATTEMPTS,
        backoff: { kind: "exponential", baseMs: PIN_BACKOFF_BASE_MS },
        log,
      },
      async () => {
        lastDriftedReason = null;
        const page = await browser.newPage();
        await page.setViewport({
          width: 1600,
          height: 900,
          deviceScaleFactor: 2,
        });

        try {
          // #__PWS_INITIAL_PROPS__ is embedded in the SSR document, so waiting
          // for networkidle2 only stalls on background analytics and video XHRs.
          await page.goto(pinUrl, {
            waitUntil: "domcontentloaded",
            timeout: NAV_TIMEOUT,
          });

          const evalResult = (await page.evaluate(`(() => {
            var pinId = location.pathname.split("/").filter(Boolean).pop();
            var readState = function() {
              var el = document.getElementById("__PWS_INITIAL_PROPS__");
              if (!el || !el.textContent) {
                var title = (document.title || "").replace(/\\s+/g, " ").trim();
                var htmlLen = document.documentElement ? document.documentElement.outerHTML.length : 0;
                return {
                  status: "drifted",
                  reason: "missing #__PWS_INITIAL_PROPS__ (url=" + location.href + ", title=\\"" + title + "\\", " + htmlLen + " bytes)",
                };
              }
              var parsed;
              try {
                parsed = JSON.parse(el.textContent);
              } catch (e) {
                return { status: "drifted", reason: "invalid JSON in #__PWS_INITIAL_PROPS__: " + String(e) };
              }
              var redux = parsed && parsed.initialReduxState;
              if (!redux || typeof redux !== "object") {
                return { status: "drifted", reason: "missing initialReduxState in #__PWS_INITIAL_PROPS__" };
              }
              var pins = redux.pins;
              if (!pins || typeof pins !== "object") {
                return { status: "drifted", reason: "missing initialReduxState.pins in #__PWS_INITIAL_PROPS__" };
              }
              var pin = pins[pinId] || pins[Object.keys(pins)[0]];
              if (!pin) {
                return { status: "drifted", reason: "pin " + pinId + " absent from initialReduxState.pins" };
              }
              return { status: "ok", rawPin: pin };
            };
            return new Promise(function(resolve) {
              var first = readState();
              if (first.status === "ok") { resolve(first); return; }
              setTimeout(function() { resolve(readState()); }, 1500);
            });
          })()`)) as RawPinPageEval;

          if (evalResult.status === "drifted") {
            lastDriftedReason = evalResult.reason;
            return { kind: "retry", reason: evalResult.reason };
          }

          const parsed = PinterestPinDetailSchema.safeParse(evalResult.rawPin);
          if (!parsed.success) {
            lastDriftedReason = `initialReduxState.pins schema mismatch (${formatZodError(parsed.error)})`;
            return { kind: "retry", reason: lastDriftedReason };
          }

          return { kind: "done", value: extractPinMetadata(parsed.data) };
        } finally {
          await page.close().catch(() => {});
        }
      },
    );

    return { kind: "ok", meta };
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    if (lastDriftedReason) {
      log.warn("pin detail UI/schema drifted for %s: %s", pinUrl, reason);
      return { kind: "drifted", reason: lastDriftedReason };
    }
    log.error("error crawling pin %s: %s", pinUrl, reason);
    return { kind: "failed", reason };
  }
};

type BoardFeedPaginateResult =
  | {
      kind: "ok";
      origin: string;
      rawItemsSeen: number;
      stoppedAtKnown: boolean;
      firstNonMatchingItem: { type?: unknown; keys: string[] } | null;
      rawPins: unknown[];
    }
  | { kind: "drifted"; reason: string }
  | { kind: "http_error"; status: number };

// Paginate a board's BoardFeedResource by replaying the page's own feed request
// (valid session/CSRF headers). The first page is forced by stripping any captured
// `bookmarks`; subsequent pages follow `bookmark` until it's absent or "-end-".
// This feed contains ONLY pins saved to the board - Pinterest serves "More ideas"
// recommendations from a separate endpoint - so there is nothing to scrape or
// boundary-detect, and it is independent of UI text/locale.
export const PIN_PAGINATE = `(async (firstUrl, headers, knownIds) => {
  var known = new Set(knownIds || []);
  var seen = {};
  var rawPins = [];
  var rawItemsSeen = 0;
  var firstNonMatchingItem = null;
  var bookmark = null;
  var pages = 0;
  var stop = false;
  for (;;) {
    var u = new URL(firstUrl);
    var dataParam = u.searchParams.get("data");
    if (!dataParam) {
      return { kind: "drifted", reason: "BoardFeedResource URL missing data query parameter" };
    }
    var data = JSON.parse(dataParam);
    if (!data.options) data.options = {};
    if (bookmark) data.options.bookmarks = [bookmark];
    else delete data.options.bookmarks;
    u.searchParams.set("data", JSON.stringify(data));
    u.searchParams.set("_", String(Date.now()));
    var r = await fetch(u.toString(), { headers: headers, credentials: "include", signal: AbortSignal.timeout(${FEED_REQUEST_TIMEOUT}) });
    if (!r.ok) {
      return { kind: "http_error", status: r.status };
    }
    var j = await r.json();
    var rr = j && j.resource_response;
    if (!rr || !Array.isArray(rr.data)) {
      return { kind: "drifted", reason: "BoardFeedResource response missing resource_response.data array" };
    }
    var arr = rr.data;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (!p || typeof p !== "object") continue;
      rawItemsSeen++;
      if (p.type !== "pin" || !p.id) {
        if (!firstNonMatchingItem) {
          firstNonMatchingItem = { type: p.type, keys: Object.keys(p).slice(0, 10) };
        }
        continue;
      }
      if (seen[p.id]) continue;
      if (known.size > 0 && known.has(p.id)) { stop = true; break; }
      seen[p.id] = true;
      rawPins.push({
        id: p.id,
        type: p.type,
        title: p.title,
        grid_title: p.grid_title,
        description: p.description,
        alt_text: p.alt_text,
        auto_alt_text: p.auto_alt_text,
        images: p.images,
      });
    }
    pages++;
    if (stop) break;
    if (arr.length === 0) break;
    if (!("bookmark" in rr)) break;
    var nextBookmark = rr.bookmark;
    if (!nextBookmark || nextBookmark === "-end-" || nextBookmark === bookmark) break;
    bookmark = nextBookmark;
    if (pages > 300) break;
    await new Promise(function (res) { setTimeout(res, 120); });
  }
  return {
    kind: "ok",
    origin: location.origin,
    rawItemsSeen: rawItemsSeen,
    stoppedAtKnown: stop,
    firstNonMatchingItem: firstNonMatchingItem,
    rawPins: rawPins,
  };
})`;

export const validateBoardFeedResult = (
  result: BoardFeedPaginateResult,
  boardUrl: string,
  boardName: string,
): CrawledPin[] => {
  if (result.kind === "drifted") {
    throw new Error(
      `pinterest BoardFeedResource drifted on ${boardUrl}: ${result.reason}`,
    );
  }
  if (result.kind === "http_error") {
    throw new Error(
      `pinterest BoardFeedResource HTTP ${result.status} on ${boardUrl}`,
    );
  }

  if (
    result.rawItemsSeen > 0 &&
    !result.stoppedAtKnown &&
    result.rawPins.length === 0
  ) {
    throw new Error(
      `pinterest BoardFeedResource drifted on ${boardUrl}: ${result.rawItemsSeen} feed items contained no type="pin" entries (sample=${JSON.stringify(result.firstNonMatchingItem)})`,
    );
  }

  const pins: CrawledPin[] = [];
  let firstValidationError: string | null = null;

  for (const rawPin of result.rawPins) {
    const parsed = BoardFeedPinSchema.safeParse(rawPin);
    if (!parsed.success) {
      const err = formatZodError(parsed.error);
      if (!firstValidationError) {
        firstValidationError = err;
      }
      log.warn("skipping invalid board feed pin on %s: %s", boardUrl, err);
      continue;
    }
    pins.push(toCrawledPin(parsed.data, result.origin, boardName));
  }

  if (result.rawPins.length > 0 && pins.length === 0 && firstValidationError) {
    throw new Error(
      `pinterest BoardFeedResource pin schema drifted on ${boardUrl}: all ${result.rawPins.length} pins failed validation (${firstValidationError})`,
    );
  }

  return pins;
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeBoardPath = (value: string): string =>
  safeDecodeURIComponent(value).replace(/\/+$/, "").toLowerCase();

export const matchesBoardFeedUrl = (
  u: string,
  profile: string,
  boardName: string,
): boolean => {
  if (!/\/resource\/BoardFeedResource\/get\//.test(u)) return false;

  const expected = normalizeBoardPath(`/${profile}/${boardName}`);
  try {
    const parsed = new URL(u);
    const sourceUrl = parsed.searchParams.get("source_url");
    if (sourceUrl) {
      return normalizeBoardPath(sourceUrl.split(/[?#]/)[0]) === expected;
    }
  } catch {
    return false;
  }

  return normalizeBoardPath(safeDecodeURIComponent(u)).includes(`${expected}/`);
};

const crawlBoardOnce = async (
  browser: any,
  boardUrl: string,
  profile: string,
  knownPinIds?: string[],
): Promise<CrawledPin[]> => {
  const boardName = boardUrl.split("/").filter(Boolean).pop()!;
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });

  try {
    // require the captured feed request to belong to THIS board (its source_url
    // carries the board path) so we never replay a neighbouring board's request
    const waitFirst = page.waitForResponse(
      (r: any) => matchesBoardFeedUrl(r.url(), profile, boardName),
      { timeout: BOARD_FEED_TIMEOUT },
    );

    // The wait is armed before the navigation so a feed request issued during it
    // is not missed, which means it can reject while only the goto below is being
    // awaited. Marking it handled here keeps that from tearing down the process;
    // the await further down still sees the rejection and spends the attempt.
    void waitFirst.catch(() => {});

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

    const feedResult = (await page.evaluate(
      `(${PIN_PAGINATE})(${JSON.stringify(firstUrl)}, ${JSON.stringify(headers)}, ${JSON.stringify(knownPinIds ?? [])})`,
    )) as BoardFeedPaginateResult;

    return validateBoardFeedResult(feedResult, boardUrl, boardName);
  } finally {
    await page.close().catch(() => {});
  }
};

// The feed request is intermittently not observed within the timeout; a fresh
// navigation recovers it. Throws once the attempts are spent, because an empty
// result here is indistinguishable from a board whose pins were all removed.
const crawlBoard = async (
  browser: any,
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
      value: await crawlBoardOnce(browser, boardUrl, profile, knownPinIds),
    }),
  );
};

const BoardUrlsSchema = z.array(z.string().url()).min(1);

// An empty board list aborts the whole source, and Pinterest intermittently
// serves the profile before the board grid renders, so an empty result is
// retried rather than trusted.
const crawlProfile = async (
  browser: any,
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
      const page = await browser.newPage();
      await page.setViewport({
        width: 1600,
        height: 900,
        deviceScaleFactor: 2,
      });

      try {
        await page.goto(profileUrl, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });

        const loggedIn = await isLoggedIn(page);
        const check = await verifyPageSelectors(page, [
          PROFILE_BOARD_LINK_SELECTOR,
        ]);
        if (check.kind === "drifted") {
          if (!loggedIn) {
            return {
              kind: "fail",
              reason: `pinterest profile page is not logged in (url=${check.url}, title="${check.title}")`,
            };
          }
          return {
            kind: "retry",
            reason: `pinterest profile UI missing selector "${check.missingSelector}" (url=${check.url}, title="${check.title}", ${check.htmlLen} bytes)`,
          };
        }

        const rawBoards = await page.evaluate(`
          Array.from(document.querySelectorAll('[aria-label="Board"]'))
            .map((el) => {
              var a = el.querySelector("a[href]");
              return a ? a.href : null;
            })
            .filter(Boolean)
        `);

        const parsed = BoardUrlsSchema.safeParse(rawBoards);
        if (!parsed.success) {
          return {
            kind: "retry",
            reason: `pinterest profile board links invalid (${formatZodError(parsed.error)})`,
          };
        }

        return { kind: "done", value: parsed.data };
      } finally {
        await page.close().catch(() => {});
      }
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

  const openCheck = await verifyPageSelectors(page, [LOGIN_OPEN_BUTTON]);
  if (openCheck.kind === "drifted") {
    throw new Error(
      `pinterest login UI drifted: missing selector "${openCheck.missingSelector}" (url=${openCheck.url}, title="${openCheck.title}")`,
    );
  }

  await page.click(LOGIN_OPEN_BUTTON);
  await page.waitForSelector(LOGIN_EMAIL, {
    visible: true,
    timeout: LOGIN_TIMEOUT,
  });

  const modalCheck = await verifyPageSelectors(page, [
    LOGIN_EMAIL,
    LOGIN_PASSWORD,
    LOGIN_SUBMIT,
  ]);
  if (modalCheck.kind === "drifted") {
    throw new Error(
      `pinterest login modal UI drifted: missing selector "${modalCheck.missingSelector}" (url=${modalCheck.url}, title="${modalCheck.title}")`,
    );
  }

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

  throw new Error(
    `login did not complete: authenticated shell selector "${LOGGED_IN_SELECTOR}" not found (url: ${page.url()})`,
  );
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
    try {
      await page.setViewport({
        width: 1600,
        height: 900,
        deviceScaleFactor: 2,
      });
      await page.goto(ROOT, {
        waitUntil: "networkidle2",
        timeout: NAV_TIMEOUT,
      });

      if (await isLoggedIn(page)) {
        log.info("reusing stored session");
        return { browser };
      }

      log.info(
        "stored session invalid, logging in via %s",
        options.loginMethod,
      );
      if (options.loginMethod === "cookies") {
        await loginWithCookiesFromChrome(page);
      } else if (options.loginMethod === "password") {
        await loginWithCreds(page, options.username!, options.password!);
      } else {
        throw new Error("invalid login option");
      }

      return { browser };
    } finally {
      await page.close().catch(() => {});
    }
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
  knownPinIdsByBoard?: Map<string, string[]>,
): Promise<BoardCrawl> => {
  const { browser } = session;

  const boards = await crawlProfile(
    browser,
    ROOT + "/" + options.profile + "/boards",
  );

  const pins: CrawledPin[] = [];
  const failedBoards: string[] = [];
  for (const board of boards) {
    const boardName = board.split("/").filter(Boolean).pop()!;
    const knownPinIds = knownPinIdsByBoard?.get(boardName);
    try {
      const boardPins = await crawlBoard(
        browser,
        board,
        options.profile!,
        knownPinIds,
      );
      log.info("board pins: %s %d", board, boardPins.length);
      pins.push(...boardPins);
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
  if (pins.length === 0) return [];

  const { browser } = session;
  const concurrency = options.concurrency || 4;

  const profile = options.profile?.toLowerCase();

  const results: CrawledPinWithMetadata[] = [];
  const queue = [...pins];
  let droppedPromoted = 0;
  let droppedForeign = 0;
  let okCount = 0;
  const driftedReasons: string[] = [];

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const pin = queue.shift()!;
      const outcome = await crawlPin(browser, pin.url);
      if (outcome.kind === "drifted") {
        driftedReasons.push(`${pin.url}: ${outcome.reason}`);
        results.push({ ...pin });
        continue;
      }
      if (outcome.kind === "failed") {
        results.push({ ...pin });
        continue;
      }

      okCount++;
      const { meta } = outcome;

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
    }
  });

  await Promise.all(workers);

  if (okCount === 0 && driftedReasons.length > 0) {
    throw new Error(
      `pinterest pin detail UI/schema drifted on all ${driftedReasons.length} pins (first: ${driftedReasons[0]})`,
    );
  }

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
