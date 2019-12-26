const assert = require("assert");
const async = require("async");
const chrome = require("chrome-cookies-secure");
const puppeteer = require("puppeteer");
const { chain, flatten } = require("lodash");

const ROOT = "https://pinterest.com";

const sleep = time => new Promise(resolve => setTimeout(resolve, time));

const crawlPin = async (browser, pinUrl) => {
  console.log("[archivist-pinterest-crawl]", "crawling pin", pinUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  await page.goto(pinUrl, { waitUntil: "networkidle2" });

  const link = await page.evaluate(() => {
    const getLink = () => {
      const link = document.querySelector(".linkModuleActionButton");
      return link ? link.href : undefined;
    };

    return new Promise(resolve => {
      const link = getLink();

      if (link) {
        resolve(link);
      } else {
        // try once more and give up
        setTimeout(() => {
          resolve(getLink());
        }, 500);
      }
    });
  });

  const date = await page.evaluate(() => {
    const getDate = () => {
      let date;

      try {
        date = Object.values(
          JSON.parse(document.getElementById("initial-state").innerText).pins
        ).map(p => p.created_at)[0];
      } catch (e) {}

      return date;
    };

    return new Promise(resolve => {
      const date = getDate();

      if (date) {
        resolve(date);
      } else {
        // try once more and give up
        setTimeout(() => {
          resolve(getDate());
        }, 500);
      }
    });
  });

  await page.close();

  return { link, date };
};

const crawlBoard = async (page, boardUrl) => {
  console.log("[archivist-pinterest-crawl]", "crawling board", boardUrl);

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
                  console.log(
                    "[archivist-pinterest-crawl]",
                    "no a/img for",
                    pin
                  );
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
  console.log("[archivist-pinterest-crawl]", "crawling profile", profileUrl);

  await page.goto(profileUrl, { waitUntil: "networkidle2" });

  const boards = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("[draggable=true]")).map(el => {
      return el.querySelector("a").href;
    });
  });

  return boards;
};

const loginWithCreds = async (page, email, password) => {
  await page.goto(ROOT, { waitUntil: "networkidle2" });
  await page.click("[data-test-id=login-button] > button");

  await page.type("#email", email);
  await sleep(2000);
  await page.type("#password", password);
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

const run = async options => {
  const headless = true;
  const browser = await puppeteer.launch({ headless });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  if (options.loginMethod === "cookies") {
    await loginWithCookiesFromChrome(page);
  } else if (options.loginMethod === "password") {
    await loginWithCreds(page, options.username, options.password);
  } else {
    throw new Error("invalid login option");
  }

  assert(options.profile, "requires profile option");

  const boards = await crawlProfile(page, ROOT + "/" + options.profile);

  return new Promise(resolve => {
    async.mapSeries(
      boards,
      (board, callback) =>
        crawlBoard(page, board).then(pins => {
          console.log(
            "[archivist-pinterest-crawl]",
            "board pins:",
            board,
            pins.length
          );

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
            crawlPin(browser, pin.url).then(({ link, date }) => {
              callback(null, { ...pin, link, createdAt: date });
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
