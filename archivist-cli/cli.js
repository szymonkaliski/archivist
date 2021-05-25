#!/usr/bin/env node

const fs = require("fs");
const { spawn } = require("child_process");

const { fetch, search, CONFIG_FILE } = require("./lib");

const yargs = require("yargs")
  .command("config", "open configuration file")
  .command("fetch", "fetch all configured crawlers")
  .command({
    command: "search",
    aliases: ["query"],
    desc: "search all crawlers",
    builder: (yargs) => {
      yargs.option("limit", {
        type: "number",
        description: "limit amount of results returned",
      });
      yargs.option("json", { description: "output as JSON" });
    },
  })
  .demandCommand(1, "you need to provide a command")
  .help();

const args = yargs.argv;
const [TYPE] = args._;

if (TYPE === "config") {
  const editor = process.env.EDITOR || "vim";

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(
      JSON.stringify(`{}`, null, 2),
      CONFIG_FILE,
      "utf-8"
    );
  }

  spawn(editor, [CONFIG_FILE], { stdio: "inherit" });
} else if (TYPE === "fetch") {
  fetch();
} else if (TYPE === "search" || TYPE === "query") {
  search(args._[1], args.limit).then((result) => {
    if (args.json) {
      console.log(JSON.stringify(result.value(), null, 2));
    } else {
      result.forEach((d) => console.log(JSON.stringify(d))).value();
    }
  });
} else {
  yargs.showHelp();
}
