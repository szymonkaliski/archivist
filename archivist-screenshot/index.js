const query = require("./query");

const noop = () => {}

module.exports = options => ({
  fetch: noop,
  get: () => query(options),
  query: text => query(options, text)
});
