const envPaths = require("env-paths");
const Database = require("better-sqlite3");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

const query = async (_, text, limit) => {
  const db = new Database(path.join(DATA_PATH, "data.db"));
  let search;
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
        `
      )
      .all({ search: `${text}*` });
  } else {
    search = db
      .prepare(
        `
        SELECT * FROM data
        ORDER BY time DESC
        ${limitSql}
        `
      )
      .all();
  }

  const thumbname = path.parse(d.screenshot).name + ".jpg";

  return search.map((d) => ({
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
  }));
};

module.exports = query;
