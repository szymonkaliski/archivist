import fs from "fs";
import { randomUUID } from "crypto";
import isReachable from "is-reachable";
import md5 from "md5";
import path from "path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { JSDOM } from "jsdom";

import { createLogger } from "../../logger";
import { sourceAssetsDir, sourceFrozenDir } from "../../paths";
import { fetchWithDeadline } from "../../http";
import { withRetry, type Attempt } from "../../retry";
import { FREEZE_DRY_SRC } from "./assets/freeze-dry-source";

const log = createLogger("pinboard");

const ASSETS_PATH = sourceAssetsDir("pinboard");
const FROZEN_PATH = sourceFrozenDir("pinboard");

// freeze-dry inlines every subresource as a data URI, so a media-heavy page
// legitimately takes minutes; this is a backstop against a page that never
// finishes, not a latency target
const FREEZE_TIMEOUT_MS = 240_000;

// Puppeteer aborts any single evaluate that outlives its protocolTimeout, which
// defaults to 180s - short enough that a slow freeze died as an opaque "Target
// closed" instead of our own timeout. Keeping it strictly above the freeze
// deadline means our timer always fires first, so the failure stays legible.
const PROTOCOL_TIMEOUT_MS = 300_000;

// The availability API (archive.org/wayback/available) throttles per client and
// stays 429 for a long while once tripped. This endpoint answers the same
// question with a 302 to the nearest snapshot and is not rate limited - 8 rapid
// requests returned 302 while the availability API refused every one.
const WAYBACK_REDIRECT = "http://web.archive.org/web/2/";
const ARCHIVE_TODAY_BASE = "https://archive.today/newest/";

// both archives are best-effort fallbacks for a dead link, and a stalled lookup
// would block one of the fetch workers for the rest of the run
const ARCHIVE_TIMEOUT_MS = 30_000;
const ARCHIVE_ATTEMPTS = 4;
const ARCHIVE_BACKOFF_MS = 15_000;
// Spacing for every archive request, lookups and snapshot loads alike.
// Measured: ten back-to-back requests to the redirect endpoint drew no 429 and
// no 503, and at 5s this gate was eating a third of the run's wall clock. It is
// courtesy pacing, not a limit archive.org imposes.
const ARCHIVE_MIN_INTERVAL_MS = 1_500;
// when a whole archive host is down, every link pays the full timeout before
// failing; after this many consecutive failures it is skipped for the run
const ARCHIVE_GIVE_UP_AFTER = 5;

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

type CaptureOutcome =
  | { kind: "captured"; paths: SavedPaths }
  | { kind: "failed" };

// Whether an archive HAS the page is only knowable when the archive actually
// answered. Its lookup endpoint fails often enough that conflating "answered,
// nothing here" with "could not ask" would write off recoverable links.
type ArchiveLookup =
  | { kind: "found"; url: string }
  | { kind: "none" }
  | { kind: "unavailable" };

type SavePageResult =
  | { kind: "saved"; paths: SavedPaths }
  | { kind: "permanently_failed" };

type FreezeResult =
  | { kind: "frozen" }
  | { kind: "timed_out" }
  | { kind: "empty"; bytes: number; rendered: number }
  | { kind: "failed"; error: string };

type Capture =
  | { kind: "ok" }
  | { kind: "junk"; reason: string }
  | { kind: "transient"; reason: string };

// 404/410 mean the resource genuinely is not there. 429 and the 5xx family
// mean "not right now" - web.archive.org answers 503 when crawled too fast, and
// treating that as junk permanently drops a link over a rate limit.
const isTransientStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const NAV_TIMEOUT_MS = 45_000;
const CAPTURE_ATTEMPTS = 3;
const CAPTURE_BACKOFF_MS = 10_000;

// A soft 404 answers 200 with an error body, so the status alone cannot tell a
// dead link from a live one. Rather than pattern-match error wording - which
// needs a vocabulary per language and drifts every time a site rewords its
// page - ask the origin directly what a missing page looks like there, by
// requesting a path that cannot exist.
type OriginBehavior =
  | { kind: "hard_404" }
  | { kind: "soft_404"; signature: Set<string> }
  | { kind: "unknown" };

// below this a capture carries no recoverable content - wayback redirect stubs
// come back at ~70 characters
const MIN_TEXT_CHARS = 200;
const PROBE_TIMEOUT_MS = 20_000;
// two probes agreeing on fewer tokens than this is too thin a signature to
// discard a real page over
const MIN_SIGNATURE_TOKENS = 5;
const SOFT_404_SIMILARITY = 0.7;

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
};

const renderedText = async (page: Page): Promise<string> =>
  (await page
    .evaluate(`(document.body ? document.body.innerText : "").trim()`)
    .catch(() => "")) as string;

// Asked at the root, where a random path cannot resolve to anything real.
// Shaping the probe like the target instead looks smarter but is not: on a
// /<id>/<slug> URL the slug is decorative, so replacing it returns the very
// article being judged, and the comparison matched itself and discarded it.
const missingUrlFor = (url: string): string => {
  try {
    return `${new URL(url).origin}/${randomUUID()}`;
  } catch {
    return url;
  }
};

const originKeyFor = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

// A request for a specific page that lands on the bare origin has not found
// that page - the site is answering with its front page instead. It happens
// when a domain is taken over or restructured, and the origin probe cannot see
// it: a squatter running a real CMS still answers 404 for nonsense paths, so
// the origin looks honest while every old article silently becomes the new
// homepage. Storing that homepage is not the capture that was asked for.
const redirectedToRoot = (requested: string, final: string): boolean => {
  let from: URL;
  let to: URL;
  try {
    from = new URL(requested);
    to = new URL(final);
  } catch {
    return false;
  }

  const asked = from.pathname.replace(/\/+$/, "");
  // a bare origin has nothing more specific to lose, and an index document is
  // the same page as the directory holding it
  if (asked.length <= 1) return false;
  if (/^\/(index|home|default)\.\w+$/i.test(asked)) return false;

  return to.pathname.replace(/\/+$/, "") === "" && !from.search;
};

const ARCHIVE_HOSTS = /(^|\.)(archive\.org|archive\.today)$/;
const isArchiveUrl = (url: string): boolean => {
  try {
    return ARCHIVE_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

// Renders a path that cannot exist, twice. What the two renders share is the
// origin's not-found template; what differs is the echoed URL, so intersecting
// them strips the part that varies per request. Rendering rather than fetching
// matters for single-page apps, whose raw HTML is the same shell either way.
const probeOrigin = async (
  browser: Browser,
  url: string,
): Promise<OriginBehavior> => {
  let status: number;
  try {
    const res = await fetchWithDeadline(missingUrlFor(url), PROBE_TIMEOUT_MS);
    status = res.status;
  } catch {
    return { kind: "unknown" };
  }

  // the origin reports missing pages honestly, so its status is trustworthy and
  // a 200 on the real link means real content
  if (status >= 400) return { kind: "hard_404" };

  const texts: string[] = [];
  for (let i = 0; i < 2; i++) {
    let page: Page | undefined;
    try {
      page = await browser.newPage();
      await page.goto(missingUrlFor(url), {
        waitUntil: "load",
        timeout: PROBE_TIMEOUT_MS,
      });
      texts.push(await renderedText(page));
    } catch {
      return { kind: "unknown" };
    } finally {
      await page?.close().catch(() => {});
    }
  }

  const [first, second] = texts.map(tokenize);
  const signature = new Set([...first].filter((token) => second.has(token)));
  if (signature.size < MIN_SIGNATURE_TOKENS) return { kind: "unknown" };

  return { kind: "soft_404", signature };
};

// One probe per origin per run, shared by every link that hits it.
const createOriginProbe = (browser: Browser) => {
  const cache = new Map<string, Promise<OriginBehavior>>();
  return (url: string): Promise<OriginBehavior> => {
    const key = originKeyFor(url);
    let pending = cache.get(key);
    if (!pending) {
      pending = probeOrigin(browser, url);
      cache.set(key, pending);
    }
    return pending;
  };
};

type OriginProbe = ReturnType<typeof createOriginProbe>;

const classifyCapture = async (
  page: Page,
  url: string,
  status: number | undefined,
  probeFor: OriginProbe,
): Promise<Capture> => {
  if (redirectedToRoot(url, page.url())) {
    return {
      kind: "junk",
      reason: "redirected to the site root; the page itself is gone",
    };
  }

  if (status !== undefined && status >= 400) {
    if (isTransientStatus(status)) {
      return { kind: "transient", reason: `HTTP ${status}` };
    }
    return { kind: "junk", reason: `HTTP ${status}` };
  }

  const text = await renderedText(page);
  if (text.length < MIN_TEXT_CHARS) {
    return {
      kind: "junk",
      reason: `only ${text.length} chars of text`,
    };
  }

  // An archive replays the original document, title included, so a capture from
  // an archive host with no title is the archive's own "snapshot not ready"
  // chrome instead of the page. It answers 200 with a few thousand characters
  // of boilerplate, which every other check reads as a healthy page. Retrying
  // is the right response - the snapshot usually is there, just not yet - so
  // this never discards the link. 97% of captures carry a title, and the ones
  // that do not are exactly this.
  if (isArchiveUrl(url)) {
    const title = String(
      await page.evaluate(`document.title || ""`).catch(() => "x"),
    ).trim();
    if (!title) {
      return {
        kind: "transient",
        reason: "archive chrome without a page title",
      };
    }
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { kind: "ok" };
  }

  // anything short of a confirmed soft-404 origin leaves the capture alone, so
  // a failed or inconclusive probe never discards a real page
  const behavior = await probeFor(url);
  if (behavior.kind !== "soft_404") return { kind: "ok" };

  const similarity = jaccard(tokenize(text), behavior.signature);
  if (similarity >= SOFT_404_SIMILARITY) {
    return {
      kind: "junk",
      reason: `matches the not-found page of ${origin} (similarity ${similarity.toFixed(2)})`,
    };
  }

  return { kind: "ok" };
};

const freezePage = async (
  page: Page,
  frozenPath: string,
): Promise<FreezeResult> => {
  // page.evaluate imposes no timeout of its own, so the injection runs under
  // the same deadline as the freeze; a wedged renderer would otherwise park a
  // fetch worker for the rest of the run.
  const injectAndFreeze = async (): Promise<unknown> => {
    try {
      await page.evaluate(FREEZE_DRY_SRC);
    } catch (e: any) {
      throw new Error(`injecting freeze-dry: ${e.message}`);
    }
    return page.evaluate(`window.freezeDry()`);
  };

  // A bare timer resolving `undefined` would make a slow freeze
  // indistinguishable from freezeDry returning a non-string, so the deadline
  // resolves a sentinel the caller can tell apart.
  const TIMED_OUT = Symbol("timed_out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), FREEZE_TIMEOUT_MS);
  });

  try {
    const frozen = await Promise.race([injectAndFreeze(), deadline]);

    if (frozen === TIMED_OUT) return { kind: "timed_out" };
    if (typeof frozen !== "string") {
      return { kind: "failed", error: `freezeDry returned ${typeof frozen}` };
    }

    // freeze-dry sometimes yields just a doctype. Markup that is shorter than
    // the text the page rendered cannot be holding that text, and storing it
    // would record an empty file as a successful archive.
    const rendered = (await renderedText(page)).length;
    if (frozen.length < rendered) {
      return { kind: "empty", bytes: frozen.length, rendered };
    }

    fs.writeFileSync(frozenPath, frozen, "utf-8");
    return { kind: "frozen" };
  } catch (e: any) {
    return { kind: "failed", error: e.message };
  } finally {
    clearTimeout(timer);
  }
};

const captureOnce = async (
  browser: Browser,
  link: string,
  screenshotPath: string,
  frozenPath: string,
  probeFor: OriginProbe,
): Promise<Attempt<CaptureOutcome>> => {
  const page = await browser.newPage();
  page.on("error", () => {
    void page.close().catch(() => {});
  });

  // Sites enforcing Trusted Types reject the DOM writes freeze-dry performs,
  // failing the capture with "This document requires 'TrustedScriptURL'".
  // Archiving is exactly the case the policy is not aimed at, and disabling it
  // turned a hard failure into a 15MB capture on the pages that hit this.
  await page.setBypassCSP(true).catch(() => {});

  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

  // loading a snapshot counts against the same budget as looking one up, and
  // going back to back through them is what draws 503s
  if (isArchiveUrl(link)) await spaceArchiveRequest();

  let status: number | undefined;
  let didOpen = false;
  try {
    // "load" fires before a client-rendered page has populated the DOM, which
    // both misjudges it as empty and freezes a blank shell. Waiting for the
    // network to settle is what makes the archive match what a reader sees.
    const response = await page.goto(link, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });
    status = response?.status();
    didOpen = true;
  } catch (e: any) {
    // A page holding a connection open never reaches networkidle2, but its
    // document may be fully rendered, so take what is there rather than
    // throwing away a real page over a settle timeout.
    if ((await renderedText(page)).length >= MIN_TEXT_CHARS) {
      log.warn("navigation did not settle, capturing anyway: %s", link);
      didOpen = true;
    } else {
      log.error("error navigating: %s %s", link, e.toString());
    }
  }

  // a navigation that never opened is handed straight to the archives rather
  // than retried, so a dead domain does not cost the full backoff
  if (!didOpen) {
    await page.close().catch(() => {});
    return { kind: "done", value: { kind: "failed" } };
  }

  // Checked before the screenshot and freeze so an error page costs neither the
  // work nor the disk; returning null lets the caller try the archives, which
  // is the whole point of noticing.
  const capture = await classifyCapture(page, link, status, probeFor);

  if (capture.kind !== "ok") {
    await page.close().catch(() => {});
    if (capture.kind === "transient") {
      return { kind: "retry", reason: `${link} ${capture.reason}` };
    }
    log.info("discarding capture of %s (%s)", link, capture.reason);
    return { kind: "done", value: { kind: "failed" } };
  }

  let didScreenshot: boolean;
  try {
    log.debug("screenshot: %s", link);
    await page.screenshot({ path: screenshotPath });
    didScreenshot = true;
  } catch {
    didScreenshot = false;
  }

  log.debug("freeze: %s", link);
  const freeze = await freezePage(page, frozenPath);
  let didFreeze: boolean;
  switch (freeze.kind) {
    case "frozen":
      didFreeze = true;
      break;
    case "timed_out":
      log.warn("freeze timed out after %dms: %s", FREEZE_TIMEOUT_MS, link);
      didFreeze = false;
      break;
    case "empty":
      log.warn(
        "freeze produced %d bytes for %d chars of text, discarding: %s",
        freeze.bytes,
        freeze.rendered,
        link,
      );
      didFreeze = false;
      break;
    case "failed":
      log.error("freeze failed for %s: %s", link, freeze.error);
      didFreeze = false;
      break;
  }

  await page.close().catch(() => {});

  return {
    kind: "done",
    value: {
      kind: "captured",
      paths: {
        screenshot: didScreenshot ? path.basename(screenshotPath) : undefined,
        frozen: didFreeze ? path.basename(frozenPath) : undefined,
      },
    },
  };
};

const savePageInternal = async (
  browser: Browser,
  link: string,
  url: string,
  probeFor: OriginProbe,
): Promise<CaptureOutcome> => {
  const screenshotPath = path.join(ASSETS_PATH, `${md5(url)}.png`);
  const frozenPath = path.join(FROZEN_PATH, `${md5(url)}.html`);

  if (fs.existsSync(screenshotPath) && fs.existsSync(frozenPath)) {
    log.info("already downloaded: %s", link);
    return {
      kind: "captured",
      paths: {
        screenshot: path.basename(screenshotPath),
        frozen: path.basename(frozenPath),
      },
    };
  }

  log.info("saving: %s", link);

  try {
    return await withRetry(
      {
        label: `capture ${link}`,
        attempts: CAPTURE_ATTEMPTS,
        backoff: { kind: "exponential", baseMs: CAPTURE_BACKOFF_MS },
        log,
      },
      () => captureOnce(browser, link, screenshotPath, frozenPath, probeFor),
    );
  } catch {
    // attempts spent on a transient status; the caller still gets to try the
    // archives before the link is given up on
    return { kind: "failed" };
  }
};

// Every worker funnels through the same host, and archive.org answers a burst
// with 429 and an HTML body - which then fails to parse as JSON and looked like
// "no snapshot exists". Lookups are spaced rather than issued concurrently.
let nextArchiveSlot = 0;
const spaceArchiveRequest = async () => {
  const now = Date.now();
  const slot = Math.max(now, nextArchiveSlot);
  nextArchiveSlot = slot + ARCHIVE_MIN_INTERVAL_MS;
  if (slot > now)
    await new Promise((resolve) => setTimeout(resolve, slot - now));
};

// archive.org throttles by client, not by request rate: once tripped, even a
// single isolated lookup answers 429 for a long while. Spacing requests further
// apart cannot clear that, so after enough consecutive failures wayback is
// dropped for the rest of the run and the remaining links are captured live. A
// later run gets a fresh process and retries it.
let waybackFailures = 0;

const tryWayback = async (link: string): Promise<ArchiveLookup> => {
  if (waybackFailures >= ARCHIVE_GIVE_UP_AFTER) return { kind: "unavailable" };

  try {
    return await withRetry(
      {
        label: `wayback ${link}`,
        attempts: ARCHIVE_ATTEMPTS,
        backoff: { kind: "exponential", baseMs: ARCHIVE_BACKOFF_MS },
        log,
      },
      async (): Promise<Attempt<ArchiveLookup>> => {
        await spaceArchiveRequest();
        const res = await fetchWithDeadline(
          `${WAYBACK_REDIRECT}${link}`,
          ARCHIVE_TIMEOUT_MS,
          { redirect: "manual" },
        );

        if (isTransientStatus(res.status)) {
          const retryAfter = Number(res.headers.get("retry-after"));
          return Number.isFinite(retryAfter) && retryAfter > 0
            ? {
                kind: "retry-after",
                reason: `HTTP ${res.status}`,
                waitMs: retryAfter * 1000,
              }
            : { kind: "retry", reason: `HTTP ${res.status}` };
        }

        waybackFailures = 0;

        // the redirect target is the snapshot itself, so no second lookup is
        // needed to resolve it
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (location) {
            log.info("found wayback for %s -> %s", link, location);
            return { kind: "done", value: { kind: "found", url: location } };
          }
        }
        // wayback answered and has no snapshot - the one case that licenses
        // calling a link absent
        log.warn("couldn't find wayback for: %s", link);
        return { kind: "done", value: { kind: "none" } };
      },
    );
  } catch (e: any) {
    waybackFailures++;
    if (waybackFailures === ARCHIVE_GIVE_UP_AFTER) {
      log.warn(
        "wayback refused %d lookups in a row, skipping it for this run",
        waybackFailures,
      );
    }
    log.warn("wayback unavailable for %s: %s", link, e.message);
    return { kind: "unavailable" };
  }
};

// archive.today is periodically unreachable altogether, and every link then
// waits out the full timeout before failing. Consecutive failures trip a break
// for the rest of the run; a single success clears it.
let archiveTodayFailures = 0;

const tryArchiveToday = async (link: string): Promise<ArchiveLookup> => {
  if (archiveTodayFailures >= ARCHIVE_GIVE_UP_AFTER) {
    return { kind: "unavailable" };
  }

  try {
    const res = await fetchWithDeadline(
      `${ARCHIVE_TODAY_BASE}${link}`,
      ARCHIVE_TIMEOUT_MS,
      {
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      },
    );
    archiveTodayFailures = 0;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        log.info("found archive.today for %s -> %s", link, location);
        return { kind: "found", url: location };
      }
    }
    log.warn("couldn't find archive.today for: %s", link);
    return { kind: "none" };
  } catch (e: any) {
    archiveTodayFailures++;
    if (archiveTodayFailures === ARCHIVE_GIVE_UP_AFTER) {
      log.warn(
        "archive.today failed %d times in a row, skipping it for this run",
        archiveTodayFailures,
      );
    }
    log.error("archive.today lookup failed for: %s %s", link, e.toString());
  }
  return { kind: "unavailable" };
};

const savePage = async (
  browser: Browser,
  link: string,
  probeFor: OriginProbe,
): Promise<SavePageResult> => {
  const isOnline = await isReachable(link);

  const tryArchives = async (): Promise<SavePageResult> => {
    const wayback = await tryWayback(link);
    if (wayback.kind === "found") {
      const outcome = await savePageInternal(
        browser,
        wayback.url,
        link,
        probeFor,
      );
      if (outcome.kind === "captured") {
        return { kind: "saved", paths: outcome.paths };
      }
    }

    const today = await tryArchiveToday(link);
    if (today.kind === "found") {
      const outcome = await savePageInternal(
        browser,
        today.url,
        link,
        probeFor,
      );
      if (outcome.kind === "captured") {
        return { kind: "saved", paths: outcome.paths };
      }
    }

    return { kind: "permanently_failed" };
  };

  if (!isOnline) {
    log.info("offline, trying archives for: %s", link);
    return tryArchives();
  }

  const outcome = await savePageInternal(browser, link, link, probeFor);
  if (outcome.kind === "captured") {
    return { kind: "saved", paths: outcome.paths };
  }

  log.info("no usable live capture, trying archives for: %s", link);
  return tryArchives();
};

const getFulltext = async (frozenPath: string): Promise<string> => {
  try {
    const DOM = await JSDOM.fromFile(frozenPath);
    const { document } = DOM.window;

    // textContent walks every text node, and in a frozen page the style and
    // script elements hold megabytes of inlined base64. Indexing that buries
    // the real prose - on one LessWrong capture it was 97% of the text.
    for (const el of document.querySelectorAll("style, script, noscript")) {
      el.remove();
    }

    return document.body.textContent || "";
  } catch (e: any) {
    log.warn("failed to extract fulltext from %s: %s", frozenPath, e.message);
    return "";
  }
};

// Parsing a frozen capture with JSDOM costs several times the file's size in
// heap, which a 100MB archive turns into gigabytes. Callers working through a
// large backlog can defer it and extract the text in a separate local pass.
export const fetchLinks = async (
  links: PinboardLink[],
  concurrency = 10,
  extractFulltext = true,
): Promise<(FetcherResult | null)[]> => {
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  });

  const probeFor = createOriginProbe(browser);

  try {
    const results: (FetcherResult | null)[] = [];
    const queue = [...links];

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const link = queue.shift()!;
        try {
          const result = await savePage(browser, link.href, probeFor);
          if (result.kind === "permanently_failed") {
            results.push({ kind: "permanently_failed", link });
          } else {
            const fulltext =
              extractFulltext && result.paths.frozen
                ? await getFulltext(path.join(FROZEN_PATH, result.paths.frozen))
                : "";
            results.push({
              kind: "saved",
              link,
              fulltext,
              paths: result.paths,
            });
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
