const envPaths = require("env-paths");
const Database = require("better-sqlite3");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");

const query = async (_, text) => {
  const db = new Database(path.join(DATA_PATH, "data.db"));
  let search;

  if (text) {
    search = db
      .prepare(
        `
        SELECT *
        FROM data
        WHERE
          board LIKE :query OR
          text LIKE :query OR
          title LIKE :query OR
          link LIKE :query
        `
      )
      .all({ query: `%${text}%` });
  } else {
    search = db.prepare("SELECT * FROM data").all();
  }

  return search.map(d => ({
    img: path.join(ASSETS_PATH, d.filename),
    link: d.link,
    id: d.pinid,
    time: d.createdat || d.crawldate,

    width: d.width,
    height: d.height,

    meta: {
      source: "pinterest",
      title: d.title,
      note: d.text,
      tags: [d.board]
    }
  }));
};

module.exports = query;
