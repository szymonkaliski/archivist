const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const isReachable = require("is-reachable");
const md5 = require("md5");
const mkdirp = require("mkdirp");
const path = require("path");
const puppeteer = require("puppeteer");
const wayback = require("wayback-machine");
const { JSDOM } = require("jsdom");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

mkdirp(ASSETS_PATH);
mkdirp(FROZEN_PATH);

const FREEZE_DRY_PATH = path.join(
  __dirname,
  "./assets/freeze-dry-browserified.js"
);

const FREEZE_DRY_SRC = fs.readFileSync(FREEZE_DRY_PATH, "utf-8");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const savePageInternal = async (browser, link, url) => {
  const screenshotPath = path.join(ASSETS_PATH, `${md5(url)}.png`);
  const frozenPath = path.join(FROZEN_PATH, `${md5(url)}.html`);

  let didScreenshot, didFreeze, didOpen;

  // don't re-download stuff
  if (fs.existsSync(screenshotPath) && fs.existsSync(frozenPath)) {
    console.log("[archivist-pinboard]", "already downloaded:", link);
    return {
      screenshot: path.basename(screenshotPath),
      frozen: path.basename(frozenPath),
    };
  }

  console.log("[archivist-pinboard]", "saving:", link);

  const page = await browser.newPage();

  page.on("error", async () => {
    await page.close();

    return null;
  });

  await page.setViewport({ width: 1920, height: 1080, deviceScaleRatio: 2 });

  try {
    // await page.goto(link, { waitUntil: "networkidle2" });
    await page.goto(link, { waitUntil: "load" });

    didOpen = true;
  } catch (e) {
    console.log(
      "[archivist-pinboard]",
      "error navigating:",
      link,
      e.toString()
    );

    didOpen = false;
  }

  if (!didOpen) {
    await page.close();
    return null;
  }

  try {
    console.log("[archivist-pinboard]", "screenshot:", link);
    await page.screenshot({ path: screenshotPath });

    didScreenshot = true;
  } catch (e) {
    didScreenshot = false;
  }

  try {
    console.log("[archivist-pinboard]", "freeze:", link);
    await page.evaluate(FREEZE_DRY_SRC);

    const frozen = await Promise.race([
      page.evaluate(async () => await window.freezeDry()),
      wait(5000),
    ]);

    fs.writeFileSync(frozenPath, frozen, "utf-8");

    didFreeze = true;
  } catch (e) {
    didFreeze = false;
  }

  await page.close();

  return {
    screenshot:
      didScreenshot === true ? path.basename(screenshotPath) : undefined,
    frozen: didFreeze === true ? path.basename(frozenPath) : undefined,
  };
};

const savePage = async (browser, link) => {
  const isOnline = await isReachable(link);

  if (!isOnline) {
    console.log("[archivist-pinboard]", "offline, trying wayback for:", link);

    return new Promise((resolve) => {
      wayback.getClosest(link, (err, closest) => {
        const isError = !!err;
        const isClosest = closest && !!closest.available && !!closest.url;

        if (isError || !isClosest) {
          console.log(
            "[archivist-pinboard]",
            "couldn't find wayback for:",
            link
          );
          resolve(null);
        } else {
          console.log(
            "[archivist-pinboard]",
            "found wayback for",
            link,
            "->",
            closest.url
          );

          savePageInternal(browser, closest.url, link).then((paths) =>
            resolve(paths)
          );
        }
      });
    });
  }

  return await savePageInternal(browser, link, link);
};

const getFulltext = async (frozenPath) => {
  const DOM = await JSDOM.fromFile(frozenPath);
  return DOM.window.document.body.textContent;
};

const run = async (links) => {
  const headless = 'new';
  const browser = await puppeteer.launch({ headless, ignoreHTTPSErrors: true });

  return new Promise((resolve, reject) => {
    async.mapLimit(
      links,
      10,
      (link, callback) => {
        savePage(browser, link.href)
          .then(async (paths) => {
            const fulltext = paths.frozen
              ? await getFulltext(path.join(FROZEN_PATH, paths.frozen))
              : "";

            callback(null, { ...link, fulltext, paths });
          })
          .catch((e) => {
            console.log(
              "[archivist-pinboard]",
              "uncatched error",
              link.href,
              e.toString()
            );
            // ignoring errors for now
            callback(null, null);
          });
      },
      (err, res) => {
        browser.close().then(() => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        });
      }
    );
  });
};

module.exports = run;
