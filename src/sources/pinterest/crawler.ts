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

export interface CrawledPinWithMetadata extends CrawledPin {
  title?: string;
  text?: string;
  link?: string;
  createdAt?: string;
}

interface PinMetadata {
  link?: string;
  title?: string;
  text?: string;
  date?: string;
}

const crawlPin = async (browser: any, pinUrl: string): Promise<PinMetadata> => {
  log.debug("crawling pin %s", pinUrl);

  let page: any;
  try {
    page = await browser.newPage();
  } catch (e: any) {
    log.error("error opening page for %s %s", pinUrl, e.message);
    return {
      link: undefined,
      title: undefined,
      text: undefined,
      date: undefined,
    };
  }

  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });

  try {
    await page.goto(pinUrl, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e: any) {
    log.error("error when going to %s: %s", pinUrl, e.message);
    try {
      await page.close();
    } catch (_) {}
    return {
      link: undefined,
      title: undefined,
      text: undefined,
      date: undefined,
    };
  }

  let link: string | undefined,
    title: string | undefined,
    text: string | undefined,
    date: string | undefined;
  try {
    ({ link, title, text, date } = await page.evaluate(`(()=>{
      var fromRelay = () => {
        for (var s of document.querySelectorAll("script")) {
          var t = s.textContent || "";
          if (!t.includes("__PWS_RELAY_REGISTER_COMPLETED_REQUEST__")) continue;
          if (!t.includes("createdAt")) continue;
          var match = t.match(/window\\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\\("[^"]+",\\s*({.+})\\)/);
          if (!match) continue;
          try {
            var data = JSON.parse(match[1]);
            var pin = data && data.data && data.data.v3GetPinQueryv2 && data.data.v3GetPinQueryv2.data;
            if (pin && pin.createdAt) {
              return {
                link: pin.link || undefined,
                title: pin.gridTitle || pin.richMetadata && pin.richMetadata.title || undefined,
                text: pin.description || pin.gridDescription || undefined,
                date: pin.createdAt || undefined,
              };
            }
          } catch (e) {}
        }
        return null;
      };
      var fromDom = () => {
        var link, title, text, date;
        var linkEl = document.querySelector(".linkModuleActionButton");
        if (linkEl) link = linkEl.href || linkEl.parentNode.href;
        var titleEl = document.querySelector(".CloseupTitleCard h1");
        if (titleEl) title = titleEl.textContent;
        var textEl = document.querySelector("[data-test-id=safeTextDirection]");
        if (textEl) text = textEl.textContent;
        try {
          var el = document.getElementById("__PWS_INITIAL_PROPS__");
          if (el) {
            var pins = JSON.parse(el.textContent).initialReduxState.pins;
            date = Object.values(pins).map(function(p) { return p.created_at; })[0];
          }
        } catch (e) {}
        if (!date) {
          try {
            var el2 = document.getElementById("__PWS_DATA__");
            if (el2) {
              var data = JSON.parse(el2.textContent);
              if (data.props && data.props.initialReduxState && data.props.initialReduxState.pins) {
                date = Object.values(data.props.initialReduxState.pins).map(function(p) { return p.created_at; })[0];
              }
            }
          } catch (e) {}
        }
        return { link: link, title: title, text: text, date: date };
      };
      return new Promise(function(resolve) {
        var data = fromRelay();
        if (data) { resolve(data); return; }
        var dom = fromDom();
        if (dom.link || dom.title || dom.date) { resolve(dom); }
        else { setTimeout(function() { resolve(fromRelay() || fromDom()); }, 1000); }
      });
    })()`));
  } catch (e: any) {
    log.error("error evaluating pin %s: %s", pinUrl, e.message);
  }

  try {
    await page.close();
  } catch (_) {}

  return { link, title, text, date };
};

const crawlBoard = async (
  page: any,
  boardUrl: string,
  knownPinIds?: string[],
): Promise<CrawledPin[]> => {
  log.info("crawling board %s", boardUrl);

  try {
    await page.goto(boardUrl, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e: any) {
    log.error("error navigating to board %s: %s", boardUrl, e.message);
    return [];
  }

  await sleep(2000);

  const knownIdsJson = JSON.stringify(knownPinIds ?? []);

  const scrollResult = await page.evaluate(`(()=>{
    var knownIds = new Set(${knownIdsJson});
    return new Promise((resolve) => {
      var lastScrollPosition = 0;
      var allPins = {};
      var scrollDown = () => {
        window.scrollTo(0, window.scrollY + 10);
        setTimeout(() => {
          var foundKnown = false;
          Array.from(document.querySelectorAll("[data-test-id=pin]")).forEach((pin) => {
            if (foundKnown) return;
            var a = pin.querySelector("a");
            var img = pin.querySelector("img");
            if (a && img) {
              var url = a.href;
              if (allPins[url]) return;
              if (knownIds.size > 0 && knownIds.has(url.split("/").slice(-2, -1)[0])) {
                foundKnown = true;
                return;
              }
              var src = img.src;
              var srcset = img.srcset;
              var alt = img.alt;
              allPins[url] = { url, src, alt, srcset };
            }
          });
          if (foundKnown) {
            resolve(Object.values(allPins));
          } else if (window.scrollY === lastScrollPosition) {
            resolve(Object.values(allPins));
          } else {
            lastScrollPosition = window.scrollY;
            scrollDown();
          }
        }, 10);
      };
      scrollDown();
    });
  })()`);

  return (scrollResult as any[])
    .map((pin: any) => {
      const srcsetParts = pin.srcset.split(",");
      const biggestSrc =
        pin.srcset.length > 0
          ? srcsetParts[srcsetParts.length - 1].trim().split(" ")[0].trim()
          : pin.src;

      if (!biggestSrc || biggestSrc.length === 0) {
        log.warn("missing src for pin %o", pin);
        return null;
      }

      return { ...pin, biggestSrc };
    })
    .filter((pin: any): pin is CrawledPin => pin != null);
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

  assert(options.profile, "requires profile option");

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
        const pins = await crawlBoard(page, board, knownPinIds);
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

  try {
    const results: CrawledPinWithMetadata[] = [];
    const queue = [...pins];

    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const pin = queue.shift()!;
        try {
          const { link, title, text, date } = await crawlPin(browser, pin.url);
          results.push({ ...pin, title, text, link, createdAt: date });
        } catch (e: any) {
          log.error("error crawling pin %s: %s", pin.url, e.message);
          results.push({ ...pin });
        }
      }
    });

    await Promise.all(workers);
    return results;
  } finally {
    await browser.close();
  }
};
