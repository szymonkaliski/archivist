const createPinterest = require("pinterest-node-api");
const envPaths = require("env-paths");
const mkdirp = require("mkdirp");

const getToken = require("./get-token");

const DATA_PATH = envPaths("archivist-pinterest").data;
const CONFIG_PATH = envPaths("archivist-pinterest").config;

mkdirp(DATA_PATH);
mkdirp(CONFIG_PATH);

getToken((error, token) => {
  if (error) {
    console.log(error);
    process.exit(1);
  }

  console.log({ token })

  const pinterest = createPinterest(token);

  pinterest.users.getUserBoards().then(boards => {
    console.log(boards)

    pinterest.boards.getBoardPins(boards.data[0]).then(pins => {
      console.log(pins);
    });
  });
});

// pinterest.pins
//   .getUserPins()
//   .then(res => {
//     console.log(res);
//   })
//   .catch(e => console.log("err", e));
