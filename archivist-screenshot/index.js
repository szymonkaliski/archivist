const query = require("./query");

module.exports = options => ({
  fetch: () => Promise.resolve(),
  get: () => query(options),
  query: text => query(options, text)
});
