const mdfind = require("mdfind");
const path = require("path");

const { THUMBS_PATH } = require("../consts");

const first = (xs) => {
  if (!xs) {
    return;
  }

  return xs[0];
};

module.exports = (options, text = "Screenshot", limit) => {
  const response = mdfind({
    query: text,
    attributes: [
      "kMDItemFSCreationDate",
      "kMDItemFinderComment",
      "kMDItemWhereFroms",
      "kMDItemPixelHeight",
      "kMDItemPixelWidth",
    ],
    limit,
    directories: [options.directory],
  });

  const data = [];

  return new Promise((resolve) => {
    response.output.on("data", (d) => data.push(d));
    response.output.on("end", () =>
      resolve(
        data.map((d) => {
          const width = parseInt(d.kMDItemPixelWidth);
          const height = parseInt(d.kMDItemPixelHeight);

          const time = d.kMDItemFSCreationDate
            .replace(" +0000", "")
            .replace(/-/g, "/");

          const filename = path.basename(d.kMDItemPath);
          const thumbname = path.parse(filename).name + ".jpg";
          const thumbImg = path.join(THUMBS_PATH, thumbname);

          return {
            img: d.kMDItemPath,
            thumbImg,
            id: d.kMDItemPath,
            link: first(d.kMDItemWhereFroms),
            time,

            width,
            height,

            meta: {
              source: "screenshot",
              note: d.kMDItemFinderComment,
            },
          };
        })
      )
    );
  });
};
