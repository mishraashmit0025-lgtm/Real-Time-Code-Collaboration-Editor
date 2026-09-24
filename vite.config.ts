import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      // y-monaco imports the pre-0.53 deep path, which monaco-editor's "exports" map no longer exposes
      {
        find: /^monaco-editor\/esm\/vs\/editor\/editor\.api(\.js)?$/,
        replacement: fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs/editor/editor.api.js", import.meta.url)),
      },
    ],
  },
  server: { proxy: { "/ws": { target: "ws://localhost:1234", ws: true }, "/api": "http://localhost:1234" } },
  build: { outDir: "dist", chunkSizeWarningLimit: 5000 },
});
