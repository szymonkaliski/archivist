const async = require("async");
const cheerio = require("cheerio");
const chrome = require("chrome-cookies-secure");
const puppeteer = require("puppeteer");

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

  return [page, { pinUrl, imgSrc, imgAlt, linkHref }];
};

const crawlBoard = async (page, boardUrl) => {
  await page.goto(boardUrl, { waitUntil: "networkidle0" });

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

            if (hasSecondaryBoard || window.scrollY === lastScrollPosition) {
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

  const content = await page.content();
  const $ = cheerio.load(content);

  const gridItemsEls = $(".Grid__Container .Grid__Item");

  const gridItems = gridItemsEls
    .map((_, el) => {
      const link = $(el).find(".GrowthUnauthPinImage > a");
      const img = link.find("img");

      return {
        src: img.attr("src"),
        alt: img.attr("alt"),
        url: link.attr("href")
      };
    })
    .get();

  return [page, gridItems];
};

const crawlProfile = async (page, profileUrl) => {
  await page.goto(profileUrl);

  const content = await page.content();
  const $ = cheerio.load(content);

  const boardEls = $(".boardLinkWrapper");

  const boards = boardEls
    .map((_, el) => {
      const href = $(el).attr("href");
      return href;
    })
    .get();

  return [page, boards];
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

  return page;
};

const loginWithCookiesFromChrome = async page =>
  new Promise(resolve => {
    chrome.getCookies(ROOT, "puppeteer", (err, cookies) => {
      page.setCookie(...cookies).then(() => {
        page.goto(ROOT, { waitUntil: "networkidle0" }).then(() => {
          resolve(page);
        });
      });
    });
  });

const run = async () => {
  let boards, pins, page;

  const headless = false;
  const browser = await puppeteer.launch({ headless });

  page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  page = await loginWithCookiesFromChrome(page);
  // page = await loginWithCreds(page); // breaks when logging in too much(?)

  // [page, boards] = await crawlProfile(page, ROOT + "/szymon_k/");

  // let [page, pins] = await crawlBoard(page, ROOT + boards[0]); // TODO: async.mapLimit(board)

  [page, pin] = await crawlPin(
    page,
    "https://www.pinterest.com/pin/658299670515511626/"
  );

  console.log({ pin });

  await browser.close();
};

run();
