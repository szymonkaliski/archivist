#!/usr/bin/env node

const fs = require("fs");
const { spawn } = require("child_process");

const { fetch, search, CONFIG_FILE } = require("./lib");

const yargs = require("yargs")
  .command("config", "open configuration file")
  .command("fetch", "fetch all configured crawlers")
  .command("search", "search all crawlers", (yargs) => {
    yargs.option("json", { description: "output as JSON" });
  })
  .demandCommand(1, "you need to provide a command")
  .help();

const args = yargs.argv;
const [TYPE] = args._;

if (TYPE === "config") {
  const editor = process.env.EDITOR || "vim";

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      CONFIG_FILE,
      "utf-8"
    );
  }

  spawn(editor, [CONFIG_FILE], { stdio: "inherit" });
} else if (TYPE === "fetch") {
  fetch();
} else if (TYPE === "search") {
  search(args._[1]).then((result) => {
    if (args.json) {
      console.log(JSON.stringify(result.value(), null, 2));
    } else {
      result.forEach((d) => console.log(JSON.stringify(d))).value();
    }
  });
} else {
  yargs.showHelp();
}
