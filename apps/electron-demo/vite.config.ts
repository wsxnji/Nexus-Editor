import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@nexus/core": path.resolve(
        __dirname,
        "../../packages/core/src/index.ts"
      ),
      "@nexus/preset-gfm": path.resolve(
        __dirname,
        "../../packages/preset-gfm/src/index.ts"
      ),
      "@nexus/plugin-history": path.resolve(
        __dirname,
        "../../packages/plugin-history/src/index.ts"
      ),
    },
  },
  server: {
    port: 5173,
  },
});
