const createPinterest = require("pinterest-node-api");
const envPaths = require("env-paths");
const level = require("level");
const mkdirp = require("mkdirp");
const path = require("path");

const getToken = require("./get-token");

const DATA_PATH = envPaths("archivist-pinterest").data;
const CONFIG_PATH = envPaths("archivist-pinterest").config;

mkdirp(DATA_PATH);
mkdirp(CONFIG_PATH);

const db = level(path.join(DATA_PATH, "db"));

getToken((error, token) => {
  if (error) {
    console.log(error);
    process.exit(1);
  }

  console.log({ token });

  const pinterest = createPinterest(token);

  pinterest.pins
    .getUserPins({
      limit: 100,
      fields: "id,image,url,link,board,created_at,note,media,image,metadata"
    })
    .then(res => {
      console.log(res);

      // const cursor = res.page.cursor; -> https://github.com/vijaypatoliya/pinterest-node-api/issues/5
    })
    .catch(e => console.log("err", e));

  // pinterest.users.getUserBoards().then(boards => {
  //   console.log(boards)

  //   pinterest.boards.getBoardPins(boards.data[0].id).then(pins => {
  //     console.log(pins);
  //   });
  // });
});

// pinterest.pins
//   .getUserPins()
//   .then(res => {
//     console.log(res);
//   })
//   .catch(e => console.log("err", e));
