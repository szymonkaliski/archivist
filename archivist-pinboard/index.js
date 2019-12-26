const fetch = require("./fetch");
const query = require("./query");

module.exports = options => ({
  fetch: () => fetch(options),
  get: () => query(options),
  query: text => query(options, text)
});
