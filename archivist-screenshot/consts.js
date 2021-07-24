const envPaths = require("env-paths");
const mkdirp = require("mkdirp");
const path = require("path");

const DATA_PATH = envPaths("archivist-screenshots").data;
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");

mkdirp(THUMBS_PATH);

module.exports = { DATA_PATH, THUMBS_PATH };
