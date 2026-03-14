import assert from "assert";
import async from "async";
import * as chrome from "chrome-cookies-secure";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { chain, flatten } from "lodash";

import { createLogger } from "archivist-logger";
import type { PinterestOptions } from "../index";
import type { CrawledPin, CrawledPinWithMetadata } from "./index";

const log = createLogger("pinterest");

puppeteer.use(StealthPlugin());

const ROOT = "https://pinterest.com";

const sleep = (time: number) =>
  new Promise((resolve) => setTimeout(resolve, time));

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
    // string-based evaluate to avoid tsx __name injection in browser context
    ({ link, title, text, date } = await page.evaluate(`(()=>{
      var getLink = () => {
        var link = document.querySelector(".linkModuleActionButton");
        if (!link) return undefined;
        return link.href || link.parentNode.href;
      };
      var getTitle = () => {
        var titleCard = document.querySelector(".CloseupTitleCard h1");
        return titleCard ? titleCard.textContent : undefined;
      };
      var getText = () => {
        var pinText = document.querySelector("[data-test-id=safeTextDirection]");
        return pinText ? pinText.textContent : undefined;
      };
      var getDate = () => {
        try {
          var el = document.getElementById("__PWS_INITIAL_PROPS__");
          if (el) {
            var pins = JSON.parse(el.textContent).initialReduxState.pins;
            return Object.values(pins).map(p => p.created_at)[0];
          }
        } catch (e) {}
        try {
          var el2 = document.getElementById("__PWS_DATA__");
          if (el2) {
            var data = JSON.parse(el2.textContent);
            if (data.props && data.props.initialReduxState && data.props.initialReduxState.pins) {
              return Object.values(data.props.initialReduxState.pins).map(p => p.created_at)[0];
            }
          }
        } catch (e) {}
        return undefined;
      };
      var getData = () => ({ link: getLink(), title: getTitle(), date: getDate(), text: getText() });
      return new Promise((resolve) => {
        var data = getData();
        if (data.link || data.title || data.date) {
          resolve(data);
        } else {
          setTimeout(() => { resolve(getData()); }, 1000);
        }
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

  // string-based evaluate to avoid tsx __name injection in browser context
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
            } else {
              console.log("[archivist-pinterest-crawl]", "no a/img for", pin);
            }
          });
          if (foundKnown) {
            console.log("[archivist-pinterest-crawl]", "early stop: found known pin");
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
      const biggestSrc =
        pin.srcset.length > 0
          ? (
              chain(pin.srcset)
                .split(",")
                .last()
                .trim()
                .split(" ")
                .first()
                .value() as string
            ).trim()
          : pin.src;

      if (!biggestSrc || biggestSrc.length === 0) {
        log.warn("missing src for pin %o", pin);

        return null;
      }

      return {
        ...pin,
        biggestSrc,
      };
    })
    .filter((pin: any): pin is CrawledPin => pin != null);
};

const crawlProfile = async (
  page: any,
  profileUrl: string,
): Promise<string[]> => {
  log.info("crawling profile %s", profileUrl);

  await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });

  const boards = await page.evaluate(`
    Array.from(document.querySelectorAll('[aria-label="Board"]')).map(
      (el) => el.querySelector("a").href
    )
  `);

  return boards;
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
    chrome.getCookies(ROOT, "puppeteer", (err: any, cookies: any[]) => {
      page.setCookie(...cookies).then(() => {
        page.goto(ROOT, { waitUntil: "networkidle2" }).then(() => {
          resolve();
        });
      });
    });
  });

const createBrowser = async (options: PinterestOptions) => {
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
  options: PinterestOptions,
  recentPinIdsByBoard?: Map<string, string[]>,
): Promise<CrawledPin[]> => {
  const { browser, page } = await createBrowser(options);

  try {
    const boards = await crawlProfile(
      page,
      ROOT + "/" + options.profile + "/boards",
    );

    return await new Promise((resolve) => {
      async.mapSeries(
        boards,
        (board: string, callback: (err: null, pins: CrawledPin[]) => void) => {
          const boardName = chain(board)
            .split("/")
            .takeRight(2)
            .first()
            .value() as string;
          const knownPinIds = recentPinIdsByBoard?.get(boardName);
          return crawlBoard(page, board, knownPinIds)
            .then((pins) => {
              log.info("board pins: %s %d", board, pins.length);

              callback(
                null,
                pins.map((pin) => ({
                  ...pin,
                  board: chain(board)
                    .split("/")
                    .takeRight(2)
                    .first()
                    .value() as string,
                })),
              );
            })
            .catch((e) => {
              log.error("error crawling board %s: %s", board, e.message);
              callback(null, []);
            });
        },
        (_err: any, res: any) => {
          resolve(flatten(res as CrawledPin[][]));
        },
      );
    });
  } finally {
    await browser.close();
  }
};

export const crawlPinMetadata = async (
  options: PinterestOptions,
  pins: CrawledPin[],
): Promise<CrawledPinWithMetadata[]> => {
  const { browser } = await createBrowser(options);

  try {
    return await new Promise((resolve) => {
      async.mapLimit(
        pins,
        options.concurrency || 4,
        (
          pin: CrawledPin,
          callback: (err: null, result: CrawledPinWithMetadata) => void,
        ) => {
          crawlPin(browser, pin.url)
            .then(({ link, title, text, date }) => {
              callback(null, { ...pin, title, text, link, createdAt: date });
            })
            .catch((e) => {
              log.error("error crawling pin %s: %s", pin.url, e.message);
              callback(null, { ...pin });
            });
        },
        (_err: any, res: any) => {
          resolve(res as CrawledPinWithMetadata[]);
        },
      );
    });
  } finally {
    await browser.close();
  }
};
