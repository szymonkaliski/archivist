require("dotenv").config();

const request = require("request");
const https = require("https");
const fs = require("fs");
const createPinterest = require("pinterest-node-api");
const express = require("express");

const CALLBACK_URL = "https://localhost:3000/callback";
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const STATE_PARAM = process.env.STATE_PARAM;

const app = express();

const serverOptions = {
  key: fs.readFileSync("./localhost.key"),
  cert: fs.readFileSync("./localhost.cert"),
  requestCert: false,
  rejectUnauthorized: false
};

const URL = `https://api.pinterest.com/oauth/?response_type=code&redirect_uri=${CALLBACK_URL}&client_id=${APP_ID}&scope=read_public&state=${STATE_PARAM}`;

console.log(`For token, open: ${URL}`);

app.get("/callback", (req, res) => {
  const authCode = req.query.code;

  request.post(
    `https://api.pinterest.com/v1/oauth/token?grant_type=authorization_code&client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${authCode}`,
    (error, response, body) => {
      const data = JSON.parse(body);

      const token = data.access_token;

      const pinterest = createPinterest(token);

      pinterest.pins
        .getUserPins()
        .then(res => {
          console.log(res);
        })
        .catch(e => console.log("err", e));

      res.send("ok");
    }
  );
});

const port = process.env.PORT || 3000;
const server = https.createServer(serverOptions, app);

server.listen(port, () =>
  console.log(`Server listening on: https://localhost:${server.address().port}`)
);
