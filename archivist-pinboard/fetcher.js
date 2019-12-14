const async = require("async");
const envPaths = require("env-paths");
const fs = require("fs");
const md5 = require("md5");
const mkdirp = require("mkdirp");
const path = require("path");
const puppeteer = require("puppeteer");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

mkdirp(ASSETS_PATH);
mkdirp(FROZEN_PATH);

const FREEZE_DRY_PATH = path.join(
  __dirname,
  "assets/freeze-dry-browserified.js"
);

const FREEZE_DRY_SRC = fs.readFileSync(FREEZE_DRY_PATH, "utf-8");

const screenshotPage = async (browser, link) => {
  console.log("screenshotting:", link);

  const screenshotPath = path.join(ASSETS_PATH, `${md5(link)}.png`);
  const frozenPath = path.join(FROZEN_PATH, `${md5(link)}.html`);

  const page = await browser.newPage();

  await page.setViewport({ width: 1920, height: 1080, deviceScaleRatio: 2 });
  await page.goto(link, { waitUntil: "networkidle2" });
  await page.screenshot({ path: screenshotPath });

  await page.evaluate(FREEZE_DRY_SRC);
  const frozen = await page.evaluate(async () => await window.freezeDry());
  fs.writeFileSync(frozenPath, frozen, "utf-8");

  await page.close();

  return {
    screenshot: path.basename(screenshotPath),
    frozen: path.basename(frozenPath)
  };
};

const run = async links => {
  const headless = true;
  const browser = await puppeteer.launch({ headless });

  return new Promise((resolve, reject) => {
    async.mapLimit(
      links,
      10,
      (link, callback) => {
        screenshotPage(browser, link.href)
          .then(paths => {
            callback(null, { ...link, paths });
          })
          .catch(() => {
            console.log("error navigating/downloading:", link.href);
            // ignoring errors for now
            callback(null);
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
