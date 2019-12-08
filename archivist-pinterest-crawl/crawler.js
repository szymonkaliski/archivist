const async = require("async");
const cheerio = require("cheerio");
const chrome = require("chrome-cookies-secure");
const puppeteer = require("puppeteer");
const { chain, flatten } = require("lodash");

const ROOT = "https://pinterest.com";
const CREDS = require("./.creds.json");

const sleep = time =>
  new Promise(resolve => {
    setTimeout(resolve, time);
  });

const crawlPin = async (browser, pinUrl) => {
  console.log("crawling pin", pinUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  await page.goto(pinUrl, { waitUntil: "networkidle0" });

  const content = await page.content();
  const $ = cheerio.load(content);

  const img = $("[data-test-id=closeup-image] > div > img");

  const imgSrcFromPage = img.attr("src");
  const imgSrc = imgSrcFromPage.replace(
    /pinimg.com\/...x\//,
    "pinimg.com/originals/"
  );

  const imgAlt = img.attr("alt");

  const link = $(".linkModuleActionButton").attr("href");

  await page.close();

  return { pinUrl, imgSrc, imgSrcFromPage, imgAlt, link };
};

const crawlBoard = async (page, boardUrl) => {
  console.log("crawling board", boardUrl);

  await page.goto(boardUrl, { waitUntil: "networkidle0" });

  // scroll down to bottom (hopefully)
  const scrollResult = await page.evaluate(
    () =>
      new Promise(resolve => {
        let lastScrollPosition = 0;
        const allPins = {};

        const scrollDown = () => {
          window.scrollTo(0, window.scrollY + 100);

          setTimeout(() => {
            Array.from(document.querySelectorAll("[data-test-id=pin]")).forEach(
              pin => {
                const url = pin.querySelector("a").href;
                const src = pin.querySelector("img").src;
                const alt = pin.querySelector("img").alt;

                allPins[url] = { url, src, alt };
              }
            );

            if (window.scrollY === lastScrollPosition) {
              resolve(Object.values(allPins));
            } else {
              lastScrollPosition = window.scrollY;
              scrollDown();
            }
          }, 10);
        };

        scrollDown();
      })
  );

  return scrollResult;
};

const crawlProfile = async (page, profileUrl) => {
  console.log("crawling profile", profileUrl);

  await page.goto(profileUrl, { waitUntil: "networkidle0" });

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
        page.goto(ROOT, { waitUntil: "networkidle0" }).then(() => {
          resolve();
        });
      });
    });
  });

const run = async () => {
  const headless = true;
  const browser = await puppeteer.launch({ headless });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  await loginWithCookiesFromChrome(page);
  // await loginWithCreds(page); // breaks when logging in too much(?)

  const boards = await crawlProfile(page, ROOT + "/szymon_k/");

  const allPins = await Promise.all(
    boards.map(async board => {
      const pins = await crawlBoard(page, board);

      return pins.map(pin => ({
        ...pin,
        board: chain(board)
          .split("/")
          .takeRight(2)
          .first()
          .value()
      }));
    })
  );

  return new Promise(resolve => {
    async.mapLimit(
      flatten(allPins),
      4,
      async pinData => {
        const pinDetail = await crawlPin(browser, pinData.url);
        return { ...pinDetail, board: pinData.board };
      },
      async (err, res) => {
        await browser.close();
        resolve(res);
      }
    );
  });
};

module.exports = run;
