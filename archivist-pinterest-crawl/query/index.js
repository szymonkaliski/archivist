const envPaths = require("env-paths");
const Database = require("better-sqlite3");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
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
        FROM ft_search JOIN data ON ft_search.pinid = data.pinid
        WHERE ft_search MATCH :search
        ORDER BY createdat DESC
        ${limitSql}
        `
      )
      .all({ search: `${text}*` });
  } else {
    search = db
      .prepare(
        `
        SELECT * FROM data
        ORDER BY createdat DESC
        ${limitSql}
        `
      )
      .all();
  }

  return search.map((d) => {
    const thumbname = path.parse(d.filename).name + ".jpg";

    return {
      img: path.join(ASSETS_PATH, d.filename),
      thumbImg: path.join(THUMBS_PATH, thumbname),

      link: d.link,
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

module.exports = query;
