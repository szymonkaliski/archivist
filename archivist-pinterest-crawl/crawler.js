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

  await page.goto(pinUrl, { waitUntil: "networkidle2" });

  const content = await page.content();
  const $ = cheerio.load(content);

  //   const img = $("[data-test-id=closeup-image] > div > img");
  //   const imgSrcFromPage = img.attr("src");
  //   const imgSrc = imgSrcFromPage.replace(
  //     /pinimg.com\/...x\//,
  //     "pinimg.com/originals/"
  //   );
  //   const imgAlt = img.attr("alt");

  const link = $(".linkModuleActionButton").attr("href");

  await page.close();

  return { link };
};

const crawlBoard = async (page, boardUrl) => {
  console.log("crawling board", boardUrl);

  await page.goto(boardUrl, { waitUntil: "networkidle2" });

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
                const a = pin.querySelector("a");
                const img = pin.querySelector("img");

                if (a && img) {
                  const url = a.href;
                  const src = img.src;
                  const srcset = img.srcset;
                  const alt = img.alt;

                  allPins[url] = { url, src, alt, srcset };
                } else {
                  console.log("no a/img for", pin);
                }
              }
            );

            if (window.scrollY === lastScrollPosition) {
              resolve(Object.values(allPins));
            } else {
              lastScrollPosition = window.scrollY;
              scrollDown();
            }
          }, 100);
        };

        scrollDown();
      })
  );

  return scrollResult.map(pin => {
    return {
      ...pin,
      biggestSrc: chain(pin.srcset)
        .split(",")
        .last()
        .trim()
        .split(" ")
        .first()
        .value()
    };
  });
};

const crawlProfile = async (page, profileUrl) => {
  console.log("crawling profile", profileUrl);

  await page.goto(profileUrl, { waitUntil: "networkidle2" });

  const boards = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("[draggable=true]")).map(el => {
      return el.querySelector("a").href;
    });
  });

  return boards;
};

const loginWithCreds = async page => {
  await page.goto(ROOT, { waitUntil: "networkidle2" });
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
        page.goto(ROOT, { waitUntil: "networkidle2" }).then(() => {
          resolve();
        });
      });
    });
  });

const run = async () => {
  const headless = false;
  const browser = await puppeteer.launch({ headless });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  await loginWithCookiesFromChrome(page);
  // await loginWithCreds(page); // breaks when logging in too much(?)

  const boards = await crawlProfile(page, ROOT + "/szymon_k/");

  return new Promise(resolve => {
    async.mapSeries(
      boards,
      (board, callback) =>
        crawlBoard(page, board).then(pins => {
          console.log("board pins:", board, pins.length);

          callback(
            null,
            pins.map(pin => ({
              ...pin,
              board: chain(board)
                .split("/")
                .takeRight(2)
                .first()
                .value()
            }))
          );
        }),
      (err, res) => {
        async.mapLimit(
          flatten(res),
          4,
          (pin, callback) => {
            crawlPin(browser, pin.url).then(({ link }) => {
              callback(null, { ...pin, link });
            });
          },
          (err, res) => {
            browser.close().then(() => {
              resolve(res);
            });
          }
        );
      }
    );
  });
};

module.exports = run;
