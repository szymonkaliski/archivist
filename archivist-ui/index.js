const path = require("path");
const { app, BrowserWindow } = require("electron");

try {
  require("electron-reloader")(module);
} catch (e) {}

const run = async () => {
  await app.whenReady();

  const mainWindow = new BrowserWindow();
  await mainWindow.loadFile(path.join(__dirname, "index.html"));
};

run();
