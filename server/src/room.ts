/**
 * A collaborative room: one Yjs document plus awareness (presence), shared by
 * every WebSocket connected to it. Speaks the standard y-websocket wire protocol
 * (sync + awareness messages from y-protocols), so any y-websocket client works.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

export interface RoomOptions {
  dataDir: string | null; // null disables persistence
  persistDebounceMs: number;
}

export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** socket -> awareness client ids it controls */
  readonly conns = new Map<WebSocket, Set<number>>();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  updatesApplied = 0;

  constructor(
    readonly name: string,
    private readonly opts: RoomOptions,
  ) {
    this.awareness.setLocalState(null); // the server itself has no presence
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.updatesApplied++;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin as WebSocket | undefined);
      this.schedulePersist();
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        const owner = origin as WebSocket | null;
        if (owner && this.conns.has(owner)) {
          const ids = this.conns.get(owner)!;
          added.forEach((id) => ids.add(id));
          removed.forEach((id) => ids.delete(id));
        }
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(enc));
      },
    );
  }

  get file(): string | null {
    return this.opts.dataDir ? path.join(this.opts.dataDir, `${encodeURIComponent(this.name)}.ydoc`) : null;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const buf = await fs.readFile(this.file);
      Y.applyUpdate(this.doc, new Uint8Array(buf), "persistence");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.updatesApplied = 0;
    this.dirty = false;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  private schedulePersist(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, this.opts.persistDebounceMs);
  }

  async persist(): Promise<void> {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const state = Y.encodeStateAsUpdate(this.doc);
    const tmp = `${this.file}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, state);
    await fs.rename(tmp, this.file); // atomic replace
  }

  addConnection(ws: WebSocket): void {
    this.conns.set(ws, new Set());
    // step 1 of the sync handshake: send our state vector
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(ws, encoding.toUint8Array(enc));
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      this.send(ws, encoding.toUint8Array(aenc));
    }
  }

  handleMessage(ws: WebSocket, data: Uint8Array): void {
    const dec = decoding.createDecoder(data);
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    switch (type) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
        // reply only when the handler wrote something beyond the message type
        if (encoding.length(enc) > 1) this.send(ws, encoding.toUint8Array(enc));
        break;
      }
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws);
        break;
      case MESSAGE_QUERY_AWARENESS: {
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]),
        );
        this.send(ws, encoding.toUint8Array(enc));
        break;
      }
      default:
        throw new Error(`unknown message type ${type}`);
    }
  }

  removeConnection(ws: WebSocket): void {
    const ids = this.conns.get(ws);
    this.conns.delete(ws);
    if (ids && ids.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
  }

  private send(ws: WebSocket, msg: Uint8Array): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(msg, (err) => {
      if (err) ws.terminate();
    });
  }

  private broadcast(msg: Uint8Array, except?: WebSocket): void {
    for (const ws of this.conns.keys()) if (ws !== except) this.send(ws, msg);
  }

  users(): { name: string; color: string }[] {
    const out: { name: string; color: string }[] = [];
    for (const s of this.awareness.getStates().values()) {
      const u = (s as { user?: { name?: string; color?: string } }).user;
      if (u?.name) out.push({ name: u.name, color: u.color ?? "#888" });
    }
    return out;
  }

  destroy(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.awareness.destroy();
    this.doc.destroy();
  }
}
