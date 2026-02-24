import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import { THUMBS_PATH, DB_PATH } from "../consts";
import type { ScreenshotOptions } from "../index";

export interface SearchResult {
  img: string;
  thumbImg: string;
  id: string;
  link?: string;
  time: string;
  width: number;
  height: number;
  meta: {
    source: string;
    title?: string;
    note?: string;
    tags?: string[];
    static?: string;
  };
}

const first = <T>(xs: T[] | undefined): T | undefined => {
  if (!xs) {
    return;
  }

  return xs[0];
};

const isMac = process.platform === "darwin";

const queryLinux = async (
  _options: ScreenshotOptions,
  text?: string,
  limit?: number,
): Promise<SearchResult[]> => {
  const db = new Database(DB_PATH, { readonly: true });

  const limitSql = limit ? `LIMIT ${limit}` : "";
  let rows: any[];

  if (text) {
    rows = db
      .prepare(
        `
        SELECT data.*
        FROM ft_search JOIN data ON ft_search.filepath = data.filepath
        WHERE ft_search MATCH :search
        ORDER BY time DESC
        ${limitSql}
        `,
      )
      .all({ search: `${text}*` });
  } else {
    rows = db
      .prepare(
        `
        SELECT * FROM data
        ORDER BY time DESC
        ${limitSql}
        `,
      )
      .all();
  }

  db.close();

  return rows.map((d: any) => {
    const thumbname = path.parse(d.filename).name + ".png";
    const thumbImg = path.join(THUMBS_PATH, thumbname);
    const hasThumb = fs.existsSync(thumbImg);

    return {
      img: d.filepath,
      thumbImg: hasThumb ? thumbImg : d.filepath,
      id: d.filepath,
      link: d.link || undefined,
      time: d.time,
      width: d.width,
      height: d.height,
      meta: {
        source: "screenshot",
        note: d.note || undefined,
      },
    };
  });
};

const queryMac = (
  options: ScreenshotOptions,
  text = "Screenshot",
  limit?: number,
): Promise<SearchResult[]> => {
  const mdfind = require("mdfind");

  const response = mdfind({
    query: text,
    attributes: [
      "kMDItemFSCreationDate",
      "kMDItemFinderComment",
      "kMDItemWhereFroms",
      "kMDItemPixelHeight",
      "kMDItemPixelWidth",
    ],
    limit,
    directories: [options.directory],
  });

  const data: any[] = [];

  return new Promise((resolve) => {
    response.output.on("data", (d: any) => data.push(d));
    response.output.on("end", () =>
      resolve(
        data.map((d: any) => {
          const width = parseInt(d.kMDItemPixelWidth);
          const height = parseInt(d.kMDItemPixelHeight);

          const time = d.kMDItemFSCreationDate
            .replace(" +0000", "")
            .replace(/-/g, "/");

          const filename = path.basename(d.kMDItemPath);
          const thumbname = path.parse(filename).name + ".png";
          const thumbImg = path.join(THUMBS_PATH, thumbname);
          const hasThumb = fs.existsSync(thumbImg);
          const imgPath = d.kMDItemPath;

          let link: string | undefined = first(d.kMDItemWhereFroms) as
            | string
            | undefined;
          let note = d.kMDItemFinderComment;

          if (!link && note) {
            const firstLine = note.split("\n")[0];
            if (
              firstLine.startsWith("http://") ||
              firstLine.startsWith("https://") ||
              firstLine.startsWith("file://")
            ) {
              link = firstLine;
              note = note.slice(firstLine.length + 1).replace(/^\n/, "");
            }
          }

          return {
            img: imgPath,
            thumbImg: hasThumb ? thumbImg : imgPath,
            id: d.kMDItemPath,
            link,
            time,

            width,
            height,

            meta: {
              source: "screenshot",
              note,
            },
          };
        }),
      ),
    );
  });
};

export default (options: ScreenshotOptions, text?: string, limit?: number) =>
  isMac ? queryMac(options, text, limit) : queryLinux(options, text, limit);
