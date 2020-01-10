const envPaths = require("env-paths");
const Database = require("better-sqlite3");
const path = require("path");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

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
          description LIKE :query OR
          extended LIKE :query OR
          tags LIKE :query OR
          href LIKE :query
        `
      )
      .all({ query: `%${text}%` });
  } else {
    search = db.prepare("SELECT * FROM data").all();
  }

  return search.map(d => ({
    img: path.join(ASSETS_PATH, d.screenshot),
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
      static: d.frozen ? path.join(FROZEN_PATH, d.frozen) : undefined
    }
  }));
};

module.exports = query;
