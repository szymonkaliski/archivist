import envPaths from "env-paths";
import Database from "better-sqlite3";
import path from "path";

import type { PinterestOptions } from "../index";

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

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

const query = async (
  _: PinterestOptions,
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
        FROM ft_search JOIN data ON ft_search.pinid = data.pinid
        WHERE ft_search MATCH :search
        ORDER BY createdat DESC
        ${limitSql}
        `,
      )
      .all({ search: `${text}*` });
  } else {
    search = db
      .prepare(
        `
        SELECT * FROM data
        ORDER BY createdat DESC
        ${limitSql}
        `,
      )
      .all();
  }

  return search.map((d: any) => {
    const thumbname = path.parse(d.filename).name + ".png";

    return {
      img: path.join(ASSETS_PATH, d.filename),
      thumbImg: path.join(THUMBS_PATH, thumbname),

      link: d.link || d.pinurl,
      id: d.pinid,
      time: d.createdat || d.crawldate,

      width: d.width,
      height: d.height,

      meta: {
        source: "pinterest",
        title: d.title,
        note: d.text,
        tags: [d.board],
      },
    };
  });
};

export default query;
