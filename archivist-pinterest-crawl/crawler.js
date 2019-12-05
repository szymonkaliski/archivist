const async = require("async");
const cheerio = require("cheerio");
const chrome = require("chrome-cookies-secure");
const puppeteer = require("puppeteer");
const { chain } = require("lodash");

const ROOT = "https://pinterest.com";
const CREDS = require("./.creds.json");

const sleep = time =>
  new Promise(resolve => {
    setTimeout(resolve, time);
  });

const crawlPin = async (page, pinUrl) => {
  await page.goto(pinUrl, { waitUntil: "networkidle0" });

  const content = await page.content();
  const $ = cheerio.load(content);

  const img = $("[data-test-id=closeup-image] > div > img");
  const imgSrc = img.attr("src");
  const imgAlt = img.attr("alt");

  const linkHref = $(".linkModuleActionButton").attr("href");

  return { pinUrl, imgSrc, imgAlt, linkHref };
};

const crawlBoard = async (page, boardUrl) => {
  await page.goto(boardUrl);

  // scroll down to bottom (hopefully)
  const scrollResult = await page.evaluate(
    () =>
      new Promise(resolve => {
        let lastScrollPosition = 0;

        const scrollDown = () => {
          window.scrollTo(0, 9999999);

          setTimeout(() => {
            const hasSecondaryBoard = document.querySelector(
              "[data-test-id=secondaryBoardGrid]"
            );

            const hasMoreIdeasOnBoard = document.querySelector(
              ".moreIdeasOnBoard"
            );

            if (
              hasSecondaryBoard ||
              hasMoreIdeasOnBoard ||
              window.scrollY === lastScrollPosition
            ) {
              resolve(lastScrollPosition);
            } else {
              lastScrollPosition = window.scrollY;
              scrollDown();
            }
          }, 1000);
        };

        scrollDown();
      })
  );

  console.log({ scrollResult });

  const content = await page.content();
  const $ = cheerio.load(content);

  const pinsEls = $("[data-test-id=pinWrapper]");

  const pins = pinsEls
    .map((_, el) => {
      const link = $(el).find("a");
      const img = link.find("img");

      return {
        src: img.attr("src"),
        alt: img.attr("alt"),
        url: link.attr("href")
      };
    })
    .get();

  return pins;
};

const crawlProfile = async (page, profileUrl) => {
  await page.goto(profileUrl);

  const boards = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("[draggable=true]")).map(el => {
      return el.querySelector("a").href;
    });
  });

  return boards;
};

const loginWithCreds = async page => {
  await page.goto(ROOT, { waitUntil: "networkidle0" });
  await page.click("[data-test-id=login-button] > button");

  await page.type("#email", CREDS.email);
  await sleep(2000);
  await page.type("#password", CREDS.password);
  await sleep(2000);

  await page.click(".SignupButton");
  await page.waitForNavigation();
};

const loginWithCookiesFromChrome = async page =>
  new Promise(resolve => {
    chrome.getCookies(ROOT, "puppeteer", (err, cookies) => {
      page.setCookie(...cookies).then(() => {
        page.goto(ROOT).then(() => {
          resolve();
        });
      });
    });
  });

const run = async () => {
  // const headless = true;
  // const browser = await puppeteer.launch({ headless });

  // const page = await browser.newPage();
  // await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  // await loginWithCookiesFromChrome(page);
  // await loginWithCreds(page); // breaks when logging in too much(?)

  // const boards = await crawlProfile(page, ROOT + "/szymon_k/");
  // const pins = await crawlBoard(page, boards[0]); // TODO: async.mapLimit(board)
  // const pin = await crawlPin(page, pins[0]);

  const pin = {
    pinUrl: "https://www.pinterest.com/pin/393994667385066863/",
    imgSrc:
      "https://i.pinimg.com/236x/52/aa/ae/52aaaeaf341127c2be07dbc9984fbc57.jpg",
    imgAlt: "minimal tatt by Axel Ejsmont, Berlin",
    linkHref:
      "http://axelejsmont.tumblr.com/post/131815025507/axelejsmont-tattoo-geometry-berlin"
  };

  const pinExtended = {
    ...pin,
    board: chain("https://pl.pinterest.com/szymon_k/ink/")
      .split("/")
      .takeRight(2)
      .first()
      .value()
  };

  // await browser.close();

  return [pinExtended];
};

module.exports = run;
