import async from "async";
import envPaths from "env-paths";
import fs from "fs";
import os from "os";
import path from "path";
import { chain } from "lodash";

import { createLogger } from "archivist-logger";

const log = createLogger("cli");

const CONFIG_PATH = envPaths("archivist").config;
const CONFIG_FILE = path.join(CONFIG_PATH, "config.json");

fs.mkdirSync(CONFIG_PATH, { recursive: true });

const loadConfig = (): Record<string, any> => {
  let config: Record<string, any>;

  try {
    config = require(CONFIG_FILE);
  } catch (e) {
    log.error(e);
    process.exit(1);
  }

  return config;
};

const loadCrawler = (name: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    let crawler: any;

    try {
      crawler = require(name);
    } catch (e) {
      return reject(e);
    }

    resolve(crawler.default || crawler);
  });
};

const fetch = () => {
  return new Promise<void>((resolve) => {
    const entries = Object.entries(loadConfig());
    const errors: string[] = [];

    async.eachLimit(
      entries,
      os.cpus().length,
      ([name, config]: [string, any], callback: (err?: any) => void) => {
        loadCrawler(name)
          .then((crawler: any) =>
            crawler(config)
              .fetch()
              .then(() => callback())
              .catch((e: any) => {
                log.error(`[${name}] fetching error ${e}`);
                errors.push(name);
                callback();
              }),
          )
          .catch((e: any) => {
            log.error(`[${name}] fetching error ${e}`);
            errors.push(name);
            callback();
          });
      },
      () => {
        if (errors.length > 0) {
          log.warn(`${errors.length} crawler(s) failed: ${errors.join(", ")}`);
        }

        resolve();
      },
    );
  });
};

const search = (query: string, limit?: number) => {
  return new Promise((resolve) => {
    const errors: string[] = [];

    async.map(
      Object.entries(loadConfig()),
      (
        [name, config]: [string, any],
        callback: (err: any, result?: any) => void,
      ) => {
        loadCrawler(`${name}/query`)
          .then((crawlerQuery: any) => {
            const queryFn = crawlerQuery.default || crawlerQuery;
            queryFn(config, query, limit)
              .then((result: any) => callback(null, result))
              .catch((e: any) => {
                log.error(`[${name}] search error ${e}`);
                errors.push(name);
                callback(null, []);
              });
          })
          .catch((e: any) => {
            log.error(`[${name}] search error ${e}`);
            errors.push(name);
            callback(null, []);
          });
      },
      (_err: any, result: any) => {
        if (errors.length > 0) {
          log.warn(`${errors.length} crawler(s) failed: ${errors.join(", ")}`);
        }

        const sortedResult = chain(result)
          .flatten()
          .sortBy((d: any) => new Date(d.time));

        resolve(sortedResult);
      },
    );
  });
};

export { loadConfig, loadCrawler, fetch, search, CONFIG_FILE };
