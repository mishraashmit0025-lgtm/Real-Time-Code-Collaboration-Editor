/**
 * Load test: N simulated users in one room, each typing at a steady rate.
 * Measures edit propagation latency (writer's local edit -> visible on every other client)
 * and checks that all replicas converge.
 *
 *   npm run load-test -- --clients 50 --seconds 20 --rate 5
 *   npm run load-test -- --url ws://your-host:1234/ws      (test a running server)
 */
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startServer } from "../server/src/server.js";

process.setMaxListeners(0);
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg("clients", "50"));
const SECONDS = Number(arg("seconds", "15"));
const RATE = Number(arg("rate", "5")); // edits per second per client
let url = arg("url", "");

const srv = url ? null : await startServer({ port: 0, host: "127.0.0.1", dataDir: null });
if (srv) url = `ws://127.0.0.1:${srv.port}/ws`;
const room = `load-${Date.now()}`;

interface Client { doc: Y.Doc; text: Y.Text; provider: WebsocketProvider; marks: Y.Map<number> }
const clients: Client[] = [];
for (let i = 0; i < N; i++) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  provider.awareness.setLocalStateField("user", { name: `bot-${i}`, color: "#888888" });
  clients.push({ doc, text: doc.getText("code"), provider, marks: doc.getMap<number>("marks") });
}
await Promise.all(clients.map((c) => new Promise<void>((r) => (c.provider.synced ? r() : c.provider.once("sync", () => r())))));
console.log(`${N} clients connected to ${url}/${room}`);

// every edit writes a unique marker key; latency = time until every other client has seen it
const sentAt = new Map<string, number>();
const seenBy = new Map<string, number>();
const latencies: number[] = [];
for (const c of clients) {
  c.marks.observe((ev) => {
    if (ev.transaction.local) return;
    const now = performance.now();
    for (const key of ev.keysChanged) {
      const n = (seenBy.get(key) ?? 0) + 1;
      seenBy.set(key, n);
      if (n === N - 1) {
        latencies.push(now - sentAt.get(key)!);
        seenBy.delete(key);
      }
    }
  });
}

let edits = 0;
const t0 = performance.now();
const timers = clients.map((c, i) =>
  setInterval(() => {
    const key = `${i}:${edits++}`;
    sentAt.set(key, performance.now());
    c.doc.transact(() => {
      c.text.insert(Math.floor(Math.random() * (c.text.length + 1)), String.fromCharCode(97 + (edits % 26)));
      c.marks.set(key, 1);
    });
  }, 1000 / RATE),
);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
timers.forEach(clearInterval);
const elapsed = (performance.now() - t0) / 1000;

const settle = performance.now();
const same = () => clients.every((c) => c.text.toString() === clients[0].text.toString());
while (!same() && performance.now() - settle < 10000) await new Promise((r) => setTimeout(r, 20));

latencies.sort((a, b) => a - b);
const q = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
console.log(`edits: ${edits} in ${elapsed.toFixed(1)}s (${(edits / elapsed).toFixed(0)}/s total)`);
console.log(`fan-out deliveries: ${(latencies.length * (N - 1)).toLocaleString("en-US")}`);
console.log(`propagation latency to all ${N - 1} peers: p50 ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, p99 ${q(0.99).toFixed(1)} ms`);
console.log(`converged: ${same()} (document length ${clients[0].text.length})`);

clients.forEach((c) => c.provider.destroy());
await srv?.close();
process.exit(same() ? 0 : 1);
