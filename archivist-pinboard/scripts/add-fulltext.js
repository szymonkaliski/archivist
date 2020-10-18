#!/usr/bin/env node

const Database = require("better-sqlite3");
const envPaths = require("env-paths");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const DATA_PATH = envPaths("archivist-pinboard").data;
const ASSETS_PATH = path.join(DATA_PATH, "assets");
const FROZEN_PATH = path.join(DATA_PATH, "frozen");

const getFulltext = async (frozenPath) => {
  const DOM = await JSDOM.fromFile(frozenPath);
  return DOM.window.document.body.textContent;
};

const db = new Database(path.join(DATA_PATH, "data.db"));

const search = db
  .prepare("SELECT * FROM data WHERE frozen IS NOT NULL AND fulltext IS NULL")
  .all();

const update = db.prepare(`
  UPDATE data
  SET fulltext = :fulltext
  WHERE frozen = :frozen
`);

const run = async () => {
  let i = 0;

  for await (const item of search) {
    console.log(item.href, item.description, i, search.length);

    const frozenPath = path.join(FROZEN_PATH, item.frozen);
    const fulltext = await getFulltext(frozenPath);

    update.run({ frozen: item.frozen, fulltext });

    i++;
  }
};

run();
