import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve("web"),
  plugins: [react()],
  appType: "spa",
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: path.resolve("dist/public"),
    emptyOutDir: true,
  },
});
