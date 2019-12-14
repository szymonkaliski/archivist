const path = require("path");
const browserify = require("browserify");

const freezeDryFunction = require("fs").createWriteStream(
  path.resolve(__dirname, "../assets/freeze-dry-browserified.js")
);

freezeDryFunction.write("window.freezeDry = (async () => {\n");

browserify()
  .require(path.resolve(__dirname, "../node_modules/freeze-dry/lib/index.js"), {
    expose: "freeze-dry"
  })
  .bundle()
  .on("end", () => {
    freezeDryFunction.write('return await require("freeze-dry").default()})');
    freezeDryFunction.end();
  })
  .pipe(freezeDryFunction, { end: false });
