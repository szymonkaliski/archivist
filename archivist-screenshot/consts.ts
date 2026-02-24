import envPaths from "env-paths";
import fs from "fs";
import path from "path";

const DATA_PATH = envPaths("archivist-screenshots").data;
const THUMBS_PATH = path.join(DATA_PATH, "thumbs");
const DB_PATH = path.join(DATA_PATH, "data.db");

fs.mkdirSync(THUMBS_PATH, { recursive: true });

export { DATA_PATH, THUMBS_PATH, DB_PATH };
