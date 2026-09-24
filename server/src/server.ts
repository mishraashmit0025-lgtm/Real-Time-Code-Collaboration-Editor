import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Room } from "./room.js";

export interface ServerOptions {
  port: number;
  host?: string;
  dataDir: string | null;
  staticDir?: string | null;
  persistDebounceMs?: number;
  maxMessageBytes?: number;
  pingIntervalMs?: number;
}

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface CollabServer {
  http: http.Server;
  rooms: Map<string, Room>;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<CollabServer> {
  const rooms = new Map<string, Room>();
  const pending = new Map<string, Promise<Room>>();
  const debounce = opts.persistDebounceMs ?? 1000;

  async function getRoom(name: string): Promise<Room> {
    const existing = rooms.get(name);
    if (existing) return existing;
    let p = pending.get(name);
    if (!p) {
      p = (async () => {
        const room = new Room(name, { dataDir: opts.dataDir, persistDebounceMs: debounce });
        await room.load();
        rooms.set(name, room);
        pending.delete(name);
        return room;
      })();
      pending.set(name, p);
    }
    return p;
  }

  async function releaseIfEmpty(room: Room): Promise<void> {
    if (room.conns.size > 0) return;
    await room.persist();
    if (room.conns.size === 0 && rooms.get(room.name) === room) {
      rooms.delete(room.name);
      room.destroy();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/rooms") {
      const list = [...rooms.values()].map((r) => ({ name: r.name, connections: r.conns.size, users: r.users() }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
      return;
    }
    if (opts.staticDir) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let file = path.resolve(opts.staticDir, rel || "index.html");
      if (!file.startsWith(path.resolve(opts.staticDir))) {
        res.writeHead(403).end();
        return;
      }
      try {
        if (!(await fs.stat(file)).isFile()) throw new Error("dir");
      } catch {
        file = path.join(opts.staticDir, "index.html"); // SPA fallback: /r/<room> etc.
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404).end("not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessageBytes ?? 8 * 1024 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^\/ws\/(.+)$/);
    const name = m ? decodeURIComponent(m[1]) : "";
    if (!ROOM_RE.test(name)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, name));
  });

  async function onConnection(ws: WebSocket, name: string): Promise<void> {
    ws.binaryType = "arraybuffer";
    // buffer messages that arrive while the room loads from disk
    const early: Uint8Array[] = [];
    const bufferEarly = (d: ArrayBuffer) => early.push(new Uint8Array(d));
    ws.on("message", bufferEarly);
    const room = await getRoom(name);
    ws.off("message", bufferEarly);
    if (ws.readyState !== ws.OPEN) return void releaseIfEmpty(room);
    alive.set(ws, true);
    room.addConnection(ws);
    const handle = (d: Uint8Array) => {
      try {
        room.handleMessage(ws, d);
      } catch {
        ws.close(1003, "bad message");
      }
    };
    early.forEach(handle);
    ws.on("message", (d: ArrayBuffer) => handle(new Uint8Array(d)));
    ws.on("pong", () => alive.set(ws, true));
    ws.on("close", () => {
      room.removeConnection(ws);
      void releaseIfEmpty(room);
    });
  }

  // drop connections that stop answering pings (e.g. laptop lid closed)
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.pingIntervalMs ?? 30000);

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    http: server,
    rooms,
    port,
    async close() {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.terminate();
      await Promise.all([...rooms.values()].map((r) => r.persist()));
      for (const r of rooms.values()) r.destroy();
      rooms.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
