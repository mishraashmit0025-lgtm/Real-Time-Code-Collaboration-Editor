import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startServer, type CollabServer } from "../server/src/server.js";

const servers: CollabServer[] = [];
const providers: WebsocketProvider[] = [];
const dirs: string[] = [];

afterEach(async () => {
  providers.splice(0).forEach((p) => p.destroy());
  for (const s of servers.splice(0)) await s.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function server(dataDir: string | null = null) {
  const s = await startServer({ port: 0, host: "127.0.0.1", dataDir, persistDebounceMs: 20 });
  servers.push(s);
  return s;
}

function client(port: number, room: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.push(provider);
  return { doc, provider, text: doc.getText("code") };
}

const synced = (p: WebsocketProvider) =>
  p.synced ? Promise.resolve() : new Promise<void>((r) => p.once("sync", (s: boolean) => s && r()));

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("collab server", () => {
  it("syncs edits between clients", async () => {
    const s = await server();
    const a = client(s.port, "room1");
    const b = client(s.port, "room1");
    await Promise.all([synced(a.provider), synced(b.provider)]);
    a.text.insert(0, "hello");
    await until(() => b.text.toString() === "hello");
    b.text.insert(5, " world");
    await until(() => a.text.toString() === "hello world");
  });

  it("converges under concurrent random edits from many clients", async () => {
    const s = await server();
    const clients = Array.from({ length: 12 }, () => client(s.port, "busy"));
    await Promise.all(clients.map((c) => synced(c.provider)));
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 30; round++) {
      for (const c of clients) {
        const len = c.text.length;
        if (len > 5 && rand() < 0.3) c.text.delete(Math.floor(rand() * (len - 3)), 2);
        else c.text.insert(Math.floor(rand() * (len + 1)), String.fromCharCode(97 + Math.floor(rand() * 26)));
      }
    }
    const first = () => clients[0].text.toString();
    await until(() => clients.every((c) => c.text.toString() === first()), 10000);
    expect(first().length).toBeGreaterThan(0);
  });

  it("isolates rooms", async () => {
    const s = await server();
    const a = client(s.port, "alpha");
    const b = client(s.port, "beta");
    await Promise.all([synced(a.provider), synced(b.provider)]);
    a.text.insert(0, "only in alpha");
    await new Promise((r) => setTimeout(r, 150));
    expect(b.text.toString()).toBe("");
  });

  it("propagates presence and lists rooms", async () => {
    const s = await server();
    const a = client(s.port, "pres");
    const b = client(s.port, "pres");
    await Promise.all([synced(a.provider), synced(b.provider)]);
    a.provider.awareness.setLocalStateField("user", { name: "Ada", color: "#ff0000" });
    await until(() => [...b.provider.awareness.getStates().values()].some((st) => st.user?.name === "Ada"));
    const rooms = await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`)).json();
    const pres = rooms.find((r: { name: string }) => r.name === "pres");
    expect(pres.connections).toBe(2);
    expect(pres.users).toEqual([{ name: "Ada", color: "#ff0000" }]);
    a.provider.destroy();
    await until(() => ![...b.provider.awareness.getStates().values()].some((st) => st.user?.name === "Ada"));
  });

  it("persists documents across restarts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "collab-"));
    dirs.push(dir);
    let s = await server(dir);
    const a = client(s.port, "keep");
    await synced(a.provider);
    a.text.insert(0, "survives restart");
    await until(() => s.rooms.get("keep")?.doc.getText("code").toString() === "survives restart");
    a.provider.destroy();
    await s.close();
    servers.pop();

    s = await server(dir);
    const b = client(s.port, "keep");
    await synced(b.provider);
    await until(() => b.text.toString() === "survives restart");
  });

  it("rejects invalid room names", async () => {
    const s = await server();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/${encodeURIComponent("../etc/passwd")}`);
    const err = await new Promise<unknown>((r) => ws.on("error", r));
    expect(String(err)).toMatch(/400/);
  });
});
