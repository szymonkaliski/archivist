import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { loadEmbeddings } from "archivist-embeddings";

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

const query = async (
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
      id: d.id,
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

export const getEmbeddings = () => loadEmbeddings(DB_PATH);

export default query;
