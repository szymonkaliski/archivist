const config = require("./config");

const crawlers = config.crawlers.map(module => ({
  name: module,
  crawler: require(module)
}));

const command = process.argv[2];
const args = process.argv[3];

if (command === "query") {
  Promise.all(crawlers.map(({ crawler }) => crawler.query(args))).then(
    result => {
      console.log(JSON.stringify(result.flat()));
    }
  );
}
