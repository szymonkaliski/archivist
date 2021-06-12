const { search } = require("archivist-cli/lib");
const express = require("express");

const app = express();

// TODO: query params
app.get("/search", (req, res) => {
  const query = undefined;

  search(query).then((found) => {
    res.send(found.value());
  });
});

app.listen(4000);
