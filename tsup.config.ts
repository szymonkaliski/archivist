import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "server/index": "src/server/index.ts",
  },
  format: "esm",
  target: "node22",
  platform: "node",
  splitting: true,
  clean: true,
  outDir: "dist",
});
