const proxy = require("http2-proxy");

module.exports = {
  root: "frontend",
  mount: {},
  plugins: ["@snowpack/plugin-react-refresh"],
  routes: [
    {
      src: "/api/.*",
      dest: (req, res) => {
        req.url = req.url.replace(/^\/api/, "");

        return proxy.web(req, res, {
          hostname: "localhost",
          port: 4000,
        });
      },
    },
  ],
  optimize: {},
  packageOptions: {},
  devOptions: {
    open: "none",
  },
  buildOptions: {},
};
