import async from "async";
import envPaths from "env-paths";
import fs from "fs";
import md5 from "md5";
import path from "path";
import sizeOf from "image-size";
import tmp from "tmp";
import wget from "node-wget";

import { createLogger } from "archivist-logger";
import type { CrawledPinWithMetadata, FetchedPin } from "./index";

const log = createLogger("pinterest");

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");

fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(ASSETS_PATH, { recursive: true });

const download = async (
  url: string,
): Promise<{ filename: string; width: number; height: number }> => {
  log.debug("downloading %s", url);

  const tempPath = tmp.tmpNameSync();

  return new Promise((resolve, reject) =>
    (wget as any)(
      { url, dest: tempPath },
      (error: any, _: any, body: string) => {
        if (error) {
          return reject(error);
        }

        const ext = path.extname(url);
        const hash = md5(body);
        const filename = `${hash}${ext}`;
        const finalPath = path.join(ASSETS_PATH, filename);

        fs.renameSync(tempPath, finalPath);

        sizeOf(finalPath, (err: any, size: any) => {
          if (err) {
            log.warn(`image-size error: ${err} (${finalPath})`);

            resolve({ filename, width: 0, height: 0 });
          } else {
            resolve({ filename, ...size });
          }
        });
      },
    ),
  );
};

export default async (
  crawledPins: CrawledPinWithMetadata[],
  concurrency = 10,
): Promise<(FetchedPin | null)[]> => {
  return new Promise((resolve) => {
    async.mapLimit(
      crawledPins,
      concurrency,
      async (pin: CrawledPinWithMetadata) => {
        const { filename, width, height } = await download(pin.biggestSrc);
        return { ...pin, filename, width, height };
      },
      (_err: any, res: any) => {
        resolve(res);
      },
    );
  });
};
