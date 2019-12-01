require("dotenv").config();

const envPaths = require("env-paths");
const express = require("express");
const fs = require("fs");
const getPort = require("get-port");
const https = require("https");
const path = require("path");
const request = require("request");

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const STATE_PARAM = process.env.STATE_PARAM;

const CONFIG_PATH = envPaths("archivist-pinterest").config;
const TOKEN_PATH = path.join(CONFIG_PATH, "token.json");

module.exports = callback => {
  // if (fs.existsSync(TOKEN_PATH)) {
  //   return callback(null, require(TOKEN_PATH).token);
  // }

  const storeToken = token => {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token }));
    console.log(`Token stored in: ${TOKEN_PATH}`);
  };

  getPort({ port: 3000 }).then(port => {
    const app = express();

    const server = https.createServer(
      {
        key: fs.readFileSync("./localhost.key"),
        cert: fs.readFileSync("./localhost.cert"),
        requestCert: false,
        rejectUnauthorized: false
      },
      app
    );

    let stopServer = () => {};

    app.get("/callback", (req, res) => {
      const authCode = req.query.code;

      request.post(
        `https://api.pinterest.com/v1/oauth/token?grant_type=authorization_code&client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${authCode}`,
        (error, response, body) => {
          stopServer();

          if (error) {
            res.send(`Token error: ${error}`);
            return callback(error);
          }

          const data = JSON.parse(body);
          const token = data.access_token;

          if (!token) {
            res.send(`Token error: ${data.message}`);
            return callback(error);
          }

          res.send("Token stored!");
          storeToken(token);
          callback(null, { token });
        }
      );
    });

    server.listen(port, () => {
      const callbackUrl = `https://localhost:${port}/callback`;
      const authUrl = `https://api.pinterest.com/oauth/?response_type=code&redirect_uri=${callbackUrl}&client_id=${APP_ID}&scope=read_public&state=${STATE_PARAM}`;

      console.log(
        `For token, open: ${authUrl}
  you might have to add the redirect URL to the pinterest console: https://developers.pinterest.com/apps/4956225778267206914/`
      );

      stopServer = () => server.close();
    });
  });
};
