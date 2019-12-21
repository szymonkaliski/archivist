const envPaths = require("env-paths");
const Database = require("better-sqlite3");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinterest").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");

const query = async text => {
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
          link LIKE :query
        `
      )
      .all({ query: `%${text}%` });
  } else {
    search = db.prepare("SELECT * FROM data").all();
  }

  return search.map(d => ({
    // must-have
    img: path.join(ASSETS_PATH, d.filename),
    link: d.link,
    id: d.pinid,
    time: d.crawldate,

    // TODO: editable meta
    meta: {
      // title
      // static
      note: d.text,
      tags: [d.board]
    }
  }));
};

module.exports = query;
