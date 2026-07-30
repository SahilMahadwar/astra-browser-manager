import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // ws: true is required — the VNC viewer and the CDP endpoint are
      // WebSockets under /api, and without it the dev proxy only forwards
      // plain HTTP and the browser view never connects.
      "/api": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: false,
      },
    },
  },
});
