import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/img": "http://localhost:3000",
    },
  },
});
