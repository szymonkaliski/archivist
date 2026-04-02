import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/img": "http://localhost:3000",
      "/html": "http://localhost:3000",
    },
  },
});
