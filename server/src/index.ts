import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 1234);
const dataDir = process.env.DATA_DIR === "none" ? null : path.resolve(process.env.DATA_DIR ?? path.join(root, "data"));
const staticDir = path.join(root, "dist");

const srv = await startServer({ port, dataDir, staticDir });
console.log(`collab server on http://localhost:${srv.port}  (ws: /ws/<room>, persistence: ${dataDir ?? "off"})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await srv.close(); // flush documents to disk
    process.exit(0);
  });
}
