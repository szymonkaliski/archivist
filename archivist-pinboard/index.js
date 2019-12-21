const fetch = require("./fetch");
const query = require("./query");

module.exports = {
  fetch,
  get: () => query(),
  query
};
