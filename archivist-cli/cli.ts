import fs from "fs";
import { spawn } from "child_process";

import Yargs from "yargs";
import { fetch, search, CONFIG_FILE } from "./lib";

const parser = Yargs(process.argv.slice(2))
  .command("config", "open configuration file")
  .command("fetch", "fetch all configured crawlers")
  .command("search [query]", "search all crawlers", (yargs) =>
    yargs
      .positional("query", { type: "string" })
      .option("limit", {
        type: "number",
        description: "limit amount of results returned",
      })
      .option("json", { type: "boolean", description: "output as JSON" }),
  )
  .command("query [query]", false)
  .demandCommand(1, "you need to provide a command")
  .help();

const args = parser.parseSync();
const [TYPE] = args._;

if (TYPE === "config") {
  const editor = process.env.EDITOR || "vim";

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2), "utf-8");
  }

  spawn(editor, [CONFIG_FILE], { stdio: "inherit" });
} else if (TYPE === "fetch") {
  fetch();
} else if (TYPE === "search" || TYPE === "query") {
  search(args._[1] as string, args.limit as number | undefined).then(
    (result: any) => {
      if (args.json) {
        console.log(JSON.stringify(result.value()));
      } else {
        result.forEach((d: any) => console.log(JSON.stringify(d))).value();
      }
    },
  );
} else {
  parser.showHelp();
}
