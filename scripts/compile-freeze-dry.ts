import { build } from "esbuild";
import fs from "fs";
import path from "path";
import os from "os";

// freeze-dry depends on postcss-values-parser which uses util.format;
// esbuild doesn't polyfill Node built-ins for browser bundles, so we
// inject a minimal shim
const utilShimPath = path.join(os.tmpdir(), "util-shim.js");
fs.writeFileSync(
  utilShimPath,
  `export function format(fmt, ...args) {
    let i = 0;
    return String(fmt).replace(/%[sdj%]/g, (m) => {
      if (m === "%%") return "%";
      return i < args.length ? String(args[i++]) : m;
    });
  }
  export default { format };`,
);

await build({
  entryPoints: [
    path.resolve(
      import.meta.dirname,
      "../node_modules/freeze-dry/lib/index.js",
    ),
  ],
  bundle: true,
  format: "iife",
  platform: "browser",
  globalName: "__freezeDryModule",
  alias: { util: utilShimPath },
  define: {
    "process.env.NODE_ENV": '"production"',
    process: '{"env":{}}',
  },
  outfile: path.resolve(
    import.meta.dirname,
    "../src/sources/pinboard/assets/freeze-dry-browserified.js",
  ),
  footer: {
    js: "window.freezeDry = () => __freezeDryModule.default();",
  },
});

console.log("freeze-dry bundled");
