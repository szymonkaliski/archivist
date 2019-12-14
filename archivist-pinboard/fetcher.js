const async = require("async");
const puppeteer = require("puppeteer");
const envPaths = require("env-paths");
const mkdirp = require("mkdirp");
const md5 = require("md5");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");

mkdirp(ASSETS_PATH);

const screenshotPage = async (browser, link) => {
  const screenshotPath = path.join(ASSETS_PATH, `${md5(link)}.png`);

  const page = await browser.newPage();

  await page.setViewport({ width: 1920, height: 1080, deviceScaleRatio: 2 });
  await page.goto(link, { waitUntil: "networkidle2" });
  await page.screenshot({ path: screenshotPath });
  await page.close();

  return screenshotPath;
};

const run = async links => {
  const headless = false;
  const browser = await puppeteer.launch({ headless });

  return new Promise((resolve, reject) => {
    async.mapLimit(
      links.slice(0, 10),
      5,
      (link, callback) => {
        screenshotPage(browser, link.href).then(screenshotPath => {
          callback(null, { ...link, screenshotPath });
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
