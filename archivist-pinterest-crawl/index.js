const crawler = require("./crawler");

const run = async () => {
  const results = await crawler();

  console.log(results);
};

run();
