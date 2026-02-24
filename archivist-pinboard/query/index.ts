import envPaths from "env-paths";
import Database from "better-sqlite3";
import path from "path";

import type { PinboardOptions } from "../index";

interface SearchResult {
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

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

const query = async (
  _: PinboardOptions,
  text?: string,
  limit?: number,
): Promise<SearchResult[]> => {
  const db = new Database(path.join(DATA_PATH, "data.db"));
  let search: any[];
  const limitSql = limit ? `LIMIT ${limit}` : "";

  if (text) {
    search = db
      .prepare(
        `
        SELECT *
        FROM ft_search JOIN data ON ft_search.hash = data.hash
        WHERE ft_search MATCH :search
        ORDER BY time DESC
        ${limitSql}
        `,
      )
      .all({ search: `${text}*` });
  } else {
    search = db
      .prepare(
        `
        SELECT * FROM data
        ORDER BY time DESC
        ${limitSql}
        `,
      )
      .all();
  }

  return search
    .filter((d: any) => d.screenshot)
    .map((d: any) => {
      const thumbname = path.parse(d.screenshot).name + ".png";

      return {
        img: path.join(ASSETS_PATH, d.screenshot),
        thumbImg: path.join(THUMBS_PATH, thumbname),

        link: d.href,
        id: d.hash,
        time: d.time,

        width: 1920,
        height: 1080,

        meta: {
          source: "pinboard",
          title: d.description,
          note: d.extended,
          tags: d.tags.split(" "),
          static: d.frozen ? path.join(FROZEN_PATH, d.frozen) : undefined,
        },
      };
    });
};

export default query;
