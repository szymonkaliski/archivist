const assert = require("assert");
const async = require("async");
const chrome = require("chrome-cookies-secure");
const puppeteer = require("puppeteer");
const { chain, flatten } = require("lodash");

const ROOT = "https://pinterest.com";

const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time));

const identity = (x) => x;

const crawlPin = async (browser, pinUrl) => {
  console.log("[archivist-pinterest-crawl]", "crawling pin", pinUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleRatio: 2 });

  try {
    await page.goto(pinUrl, { waitUntil: "networkidle2" });
  } catch (e) {
    console.log("[archivist-pinterest-crawl]", "error when going to", pinUrl);
    console.log(e);
  }

  const { link, title, date } = await page.evaluate(() => {
    const getLink = () => {
      const link = document.querySelector(".linkModuleActionButton");
      if (!link) {
        return undefined;
      }
      return link.href || link.parentNode.href;
    };

    const getTitle = () => {
      const titleCard = document.querySelector(".CloseupTitleCard h1");
      return titleCard ? titleCard.textContent : undefined;
    };

    const getDate = () => {
      let date = undefined;

      try {
        date = Object.values(
          JSON.parse(document.getElementById("initial-state").innerText).pins
        ).map((p) => p.created_at)[0];
      } catch (e) {}

      // new format?
      if (!date) {
        try {
          const jsonString = document.getElementById("__PWS_DATA__").innerText;
          const json = JSON.parse(jsonString);
          const pins = json.props.initialReduxState.pins;
          const pin = Object.values(pins)[0];
          date = pin.created_at;
        } catch (e) {}
      }

      return date;
    };

    const getData = () => ({
      link: getLink(),
      title: getTitle(),
      date: getDate(),
    });

    return new Promise((resolve) => {
      const data = getData();

      if (data.link || data.title || data.date) {
        resolve(data);
      } else {
        // try once more and give up
        setTimeout(() => {
          resolve(getData());
        }, 1000);
      }
    });
  });

  await page.close();

  return { link, title, date };
};

const crawlBoard = async (page, boardUrl) => {
  console.log("[archivist-pinterest-crawl]", "crawling board", boardUrl);

  await page.goto(boardUrl, { waitUntil: "networkidle2" });

  await sleep(2000); // boards load slowly, but "networkidle0" causes timeout

  // scroll down to bottom (hopefully)
  const scrollResult = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let lastScrollPosition = 0;
        const allPins = {};

        const scrollDown = () => {
          window.scrollTo(0, window.scrollY + 10);

          setTimeout(() => {
            Array.from(document.querySelectorAll("[data-test-id=pin]")).forEach(
              (pin) => {
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
          }, 10);
        };

        scrollDown();
      })
  );

  return scrollResult
    .map((pin) => {
      const biggestSrc =
        pin.srcset.length > 0
          ? chain(pin.srcset)
              .split(",")
              .last()
              .trim()
              .split(" ")
              .first()
              .value()
              .trim()
          : pin.src;

      if (!biggestSrc || biggestSrc.length === 0) {
        console.log("[archivist-pinterest-crawl]", "missing src for pin", pin);

        return null;
      }

      return {
        ...pin,
        biggestSrc,
      };
    })
    .filter(identity);
};

const crawlProfile = async (page, profileUrl) => {
  console.log("[archivist-pinterest-crawl]", "crawling profile", profileUrl);

  await page.goto(profileUrl, { waitUntil: "networkidle2" });

  const boards = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("[draggable=true]")).map(
      (el) => {
        return el.querySelector("a").href;
      }
    );
  });

  return boards;
};

const loginWithCreds = async (page, email, password) => {
  await page.goto(ROOT, { waitUntil: "networkidle2" });
  await page.click("[data-test-id=simple-login-button] > button");

  await sleep(2000);
  await page.type("#email", email);
  await sleep(2000);
  await page.type("#password", password);
  await sleep(2000);

  await page.click(".SignupButton");
  await page.waitForNavigation();
};

const loginWithCookiesFromChrome = async (page) =>
  new Promise((resolve) => {
    chrome.getCookies(ROOT, "puppeteer", (err, cookies) => {
      page.setCookie(...cookies).then(() => {
        page.goto(ROOT, { waitUntil: "networkidle2" }).then(() => {
          resolve();
        });
      });
    });
  });

const createBrowser = async (options) => {
  const headless = "new";
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

  return { browser, page };
};

const crawlBoards = async (options) => {
  const { browser, page } = await createBrowser(options);

  const boards = await crawlProfile(
    page,
    ROOT + "/" + options.profile + "/boards"
  );

  return new Promise((resolve) => {
    async.mapSeries(
      boards,
      (board, callback) =>
        crawlBoard(page, board).then((pins) => {
          console.log(
            "[archivist-pinterest-crawl]",
            "board pins:",
            board,
            pins.length
          );

          callback(
            null,
            pins.map((pin) => ({
              ...pin,
              board: chain(board).split("/").takeRight(2).first().value(),
            }))
          );
        }),
      (err, res) => {
        browser.close().then(() => {
          resolve(flatten(res));
        });
      }
    );
  });
};

const crawlPinMetadata = async (options, pins) => {
  const { browser } = await createBrowser(options);

  return new Promise((resolve) => {
    async.mapLimit(
      pins,
      4,
      (pin, callback) => {
        crawlPin(browser, pin.url).then(({ link, title, date }) => {
          callback(null, { ...pin, title, link, createdAt: date });
        });
      },
      (err, res) => {
        browser.close().then(() => {
          resolve(res);
        });
      }
    );
  });
};

module.exports = { crawlBoards, crawlPinMetadata };
