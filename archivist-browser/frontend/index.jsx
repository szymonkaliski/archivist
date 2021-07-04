import ReactDOM from "react-dom";
import React from "react";
import "tachyons";

import App from "./app";

const USE_CONCURRENT = true;
const rootEl = document.getElementById("app");

if (USE_CONCURRENT) {
  ReactDOM.createRoot(rootEl).render(<App />);
} else {
  ReactDOM.render(<App />, rootEl);
}
