const envPaths = require("env-paths");
const Database = require("better-sqlite3");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

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
          description LIKE :query OR
          extended LIKE :query OR
          tags LIKE :query
        `
      )
      .all({ query: `%${text}%` });
  } else {
    search = db.prepare("SELECT * FROM data").all();
  }

  return search.map(d => ({
    // must-have
    img: path.join(ASSETS_PATH, d.screenshot),
    link: d.href,
    id: d.hash,
    time: new Date(d.time),

    // TODO: editable meta
    meta: {
      title: d.description,
      note: d.extended,
      tags: d.tags.split(" "),
      static: path.join(FROZEN_PATH, d.frozen)
    }
  }));
};

module.exports = query;
