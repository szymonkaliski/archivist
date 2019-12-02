const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const async = require("async");

const ROOT = "https://pinterest.com";

const crawlBoard = async (browser, boardUrl) => {
  console.log(boardUrl);

  const page = await browser.newPage();
  await page.goto(boardUrl, { waitUntil: "networkidle0" });

  // scroll down to bottom (hopefully)
  const scrollResult = await page.evaluate(
    () =>
      new Promise(resolve => {
        let lastScrollPosition = 0;

        const scrollDown = () => {
          window.scrollTo(0, 9999999);

          setTimeout(() => {
            console.log("here", window.scrollY);

            const hasSecondaryBoard = document.querySelector("[data-test-id=secondaryBoardGrid]");

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

  console.log({ scrollResult });

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

  console.log(gridItems);
};

const run = async () => {
  const headless = false;
  const browser = await puppeteer.launch({ headless });
  const page = await browser.newPage();

  await page.goto(ROOT + "/szymon_k/");

  const content = await page.content();
  const $ = cheerio.load(content);

  const boardEls = $(".boardLinkWrapper");

  const boards = boardEls
    .map((_, el) => {
      const href = $(el).attr("href");
      return href;
    })
    .get();

  // TODO: async.mapLimit(board)
  await crawlBoard(browser, ROOT + boards[0]);

  // await browser.close();
};

run();
