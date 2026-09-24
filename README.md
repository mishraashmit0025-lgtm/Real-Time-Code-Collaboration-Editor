# Real-Time Code Collaboration Editor

A multi-user code editor that runs in the browser, like Google Docs for code. Share a link and everyone in the room edits the same file live, with each person's cursor and selection shown in their color.

- **Conflict-free editing with CRDTs**: the document is a [Yjs](https://github.com/yjs/yjs) `Y.Text`. Concurrent edits merge deterministically on every replica without locks or a central transform step, and offline edits merge on reconnect.
- **Monaco editor** (the VS Code editor) with syntax highlighting for **90+ languages**. The language choice is part of the shared document, so it syncs too.
- **Presence**: names, colors, live cursors and selections through the Yjs awareness protocol.
- **WebSocket server in TypeScript** (`server/src`): implements the y-websocket wire protocol (sync steps 1/2 + incremental updates, awareness, awareness queries) directly on `y-protocols`. It handles one room per URL, persists to disk with debounced atomic writes, unloads empty rooms from memory, uses heartbeat pings to drop dead connections, validates room names, and caps message size. It also serves the built client and a `/api/rooms` endpoint.

## Measured performance

`npm run load-test` starts a server and **50 simulated users** in one room. Each user types 5 edits/s, and the script measures the time from an edit until **all 49 peers** have applied it. On a laptop, with server and clients in one process:

```
50 clients connected
edits: 3579 in 15.0s (238/s total)
fan-out deliveries: 175,371
propagation latency to all 49 peers: p50 42.0 ms, p95 97.4 ms, p99 129.6 ms
converged: true (document length 3579)
```

Point it at a deployed server with `--url ws://host:1234/ws`.

## Run it

```bash
npm install
npm run build
npm start                    # http://localhost:1234/?room=my-room
```

Development, with hot reload:

```bash
npm run dev:server           # ws + api on :1234
npm run dev:client           # vite on :5173, proxies /ws and /api
```

Docker:

```bash
docker build -t collab-editor .
docker run -p 1234:1234 -v collab-data:/data collab-editor
```

Tests (`npm test`) cover two-way sync, convergence of 12 clients making concurrent random inserts and deletes, room isolation, presence join/leave, the room listing, persistence across a server restart, and rejection of invalid room names.

## Layout

```
server/src/room.ts     Y.Doc + awareness per room, y-websocket protocol, persistence
server/src/server.ts   HTTP + WebSocket server, room lifecycle, heartbeats, static files
client/src/main.ts     Monaco + y-monaco binding, presence UI, language sync
scripts/load-test.ts   N-client latency / convergence benchmark
tests/                 vitest integration tests against a real server
```

| Env var | Default | |
|---|---|---|
| `PORT` | 1234 | |
| `DATA_DIR` | `./data` | where rooms are persisted; `none` disables persistence |
