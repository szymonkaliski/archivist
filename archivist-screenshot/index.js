const query = require("./query");

module.exports = options => ({
  fetch: () => Promise.resolve(),
  get: () => query(options),
  query: (...args) => query(options, ...args)
});
