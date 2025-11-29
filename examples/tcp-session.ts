/**
 * Two-process demo that syncs a StringDocument over TCP sockets while mirroring
 * the document to a real file via a polling FileAdapter.
 *
 * Start a server (ts-node):
 *   node --loader ts-node/esm --experimental-specifier-resolution=node examples/tcp-session.ts --role=server --file=/tmp/patchflow-a.txt --port=8123
 *   (or after build: pnpm example:tcp:server -- --port=8123 --file=/tmp/patchflow-a.txt)
 *
 * Start a client (ts-node, in another shell):
 *   node --loader ts-node/esm --experimental-specifier-resolution=node examples/tcp-session.ts --role=client --file=/tmp/patchflow-b.txt --host=127.0.0.1 --port=8123
 *   (or after build: pnpm example:tcp:client -- --port=8123 --file=/tmp/patchflow-b.txt --host=127.0.0.1)
 *
 * Type commits in one process by editing the file; the other process will pick them up.
 * Add --stress to generate random edits on both peers to exercise merging.
 * Interactive helpers available: set("text") [staged only], get(), commit(), getCommitted().
 */
import { createServer, createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import repl from "node:repl";
import { Session } from "../src/session";
import { StringCodec, StringDocument } from "../src/string-document";
import { rebaseDraft } from "../src/working-copy";
import type { FileAdapter, PatchEnvelope, PatchStore } from "../src/types";

type Role = "server" | "client";

type Args = {
  role: Role;
  file: string;
  host: string;
  port: number;
  stress: boolean;
  userId: number;
};

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const maybePair = arg.slice(2);
      const eqIdx = maybePair.indexOf("=");
      if (eqIdx >= 0) {
        const key = maybePair.slice(0, eqIdx);
        const value = maybePair.slice(eqIdx + 1);
        opts[key] = value === "" ? true : value;
        continue;
      }
      const next = argv[i + 1];
      const key = maybePair;
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = true;
      }
    }
  }
  const role = opts.role === "server" || opts.role === "client" ? opts.role : undefined;
  if (!role) {
    throw new Error("Missing --role (server|client). Example: --role=server");
  }
  const file = typeof opts.file === "string" ? opts.file : undefined;
  if (!file) {
    throw new Error("Missing --file=/path/to/doc.txt");
  }
  const host = typeof opts.host === "string" ? opts.host : "127.0.0.1";
  const port = typeof opts.port === "string" ? Number(opts.port) : 8123;
  const stress = opts.stress === true;
  const userId = typeof opts.userId === "string" ? Number(opts.userId) : role === "server" ? 1 : 2;
  return { role, file, host, port, stress, userId };
};

class PollingFileAdapter implements FileAdapter {
  private timer?: NodeJS.Timeout;
  private listeners: (() => void)[] = [];
  private lastMtime?: number;
  private lastSize?: number;
  private path: string;
  private intervalMs: number;

  constructor(path: string, intervalMs: number = 250) {
    this.path = path;
    this.intervalMs = intervalMs;
  }

  async read(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  async write(content: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, content, "utf8");
    const s = await stat(this.path);
    this.lastMtime = s.mtimeMs;
    this.lastSize = s.size;
  }

  watch(onChange: () => void): () => void {
    this.listeners.push(onChange);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.poll();
      }, this.intervalMs);
    }
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== onChange);
      if (this.listeners.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  private async poll(): Promise<void> {
    try {
      const s = await stat(this.path);
      if (this.lastMtime !== s.mtimeMs || this.lastSize !== s.size) {
        this.lastMtime = s.mtimeMs;
        this.lastSize = s.size;
        for (const fn of this.listeners) fn();
      }
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        if (this.lastMtime !== undefined || this.lastSize !== undefined) {
          this.lastMtime = undefined;
          this.lastSize = undefined;
          for (const fn of this.listeners) fn();
        }
      }
    }
  }
}

class SocketPatchStore implements PatchStore {
  private listeners: ((env: PatchEnvelope) => void)[] = [];
  private patches: PatchEnvelope[] = [];
  private buffer = "";
  private socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const env: PatchEnvelope = JSON.parse(line);
          this.patches.push(env);
          for (const fn of this.listeners) fn(env);
        } catch (err) {
          console.error("Failed to parse incoming patch", err);
        }
      }
    });
  }

  async loadInitial(): Promise<{ patches: PatchEnvelope[]; hasMore?: boolean }> {
    return { patches: this.patches.slice() };
  }

  async append(envelope: PatchEnvelope): Promise<void> {
    this.patches.push(envelope);
    this.socket.write(JSON.stringify(envelope) + "\n");
    for (const fn of this.listeners) fn(envelope);
  }

  subscribe(onEnvelope: (env: PatchEnvelope) => void): () => void {
    this.listeners.push(onEnvelope);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== onEnvelope);
    };
  }
}

const applyInitialFile = async (session: Session, file: PollingFileAdapter) => {
  const text = await file.read();
  if (text) {
    await session.commit(new StringDocument(text));
  }
};

const startStress = (session: Session, label: string) => {
  const leftMarker = "LEFT:";
  const rightMarker = "RIGHT:";
  const base = `${leftMarker}\n${rightMarker}`;
  let counter = 0;

  const mutate = (side: "left" | "right", token: string, text: string): string => {
    const marker = side === "left" ? leftMarker : rightMarker;
    const other = side === "left" ? rightMarker : leftMarker;
    const start = text.indexOf(marker);
    const end = text.indexOf(other, start + marker.length);
    if (start === -1 || end === -1) return text + `\n${marker}${token}`;
    const before = text.slice(0, start + marker.length);
    const body = text.slice(start + marker.length, end);
    const after = text.slice(end);
    return `${before}${body}${token}${after}`;
  };

  const tick = async () => {
    const side = Math.random() < 0.5 ? "left" : "right";
    const token = `${label}-${side}-${counter++} `;
    const current = session.getDocument().toString() || base;
    const next = mutate(side, token, current);
    await session.commit(new StringDocument(next));
  };

  // Kick off a handful of overlapping edits.
  (async () => {
    for (let i = 0; i < 20; i += 1) {
      await delay(100);
      void tick();
    }
  })().catch((err) => console.error("stress error", err));
};

const startPeer = async (role: Role, socket: Socket, args: Args) => {
  const fileAdapter = new PollingFileAdapter(args.file);
  const patchStore = new SocketPatchStore(socket);
  const session = new Session({
    codec: StringCodec,
    patchStore,
    userId: args.userId,
    fileAdapter,
  });

  await session.init();
  await applyInitialFile(session, fileAdapter);

  // Track staged (uncommitted) edits and rebase them when the committed doc changes.
  let stagedBase = session.getDocument() as StringDocument;
  let stagedDoc = stagedBase;
  const updateStaged = (nextBase: StringDocument) => {
    stagedBase = nextBase;
    stagedDoc = nextBase;
  };
  const rebaseStaged = (nextBase: StringDocument) => {
    stagedDoc = rebaseDraft({
      base: stagedBase,
      draft: stagedDoc,
      updatedBase: nextBase,
    }) as StringDocument;
    stagedBase = nextBase;
  };
  session.on("change", (doc) => {
    const nextBase = doc as StringDocument;
    rebaseStaged(nextBase);
    console.log(`[${role}] doc -> "${nextBase.toString()}"`);
  });

  if (args.stress) {
    startStress(session, role);
  }
  // Expose simple helpers for interactive use.
  const globals = globalThis as any;
  globals.set = (text: string) => {
    stagedBase = session.getDocument() as StringDocument;
    stagedDoc = new StringDocument(text);
    return stagedDoc.toString();
  };
  globals.get = () => stagedDoc.toString();
  globals.getCommitted = () => session.getDocument().toString();
  globals.commit = async () => {
    await session.commit(stagedDoc);
    updateStaged(session.getDocument() as StringDocument);
    return stagedDoc.toString();
  };
  globals.history = () => {
    const out = session.summarizeHistory();
    console.log(out);
  };
  updateStaged(session.getDocument() as StringDocument);
  console.log('Interactive helpers: set("text"), get(), commit(), getCommitted(), history()');
  if (process.stdin.isTTY) {
    repl.start();
  }
};

const main = async () => {
  const args = parseArgs();
  if (args.role === "server") {
    const server = createServer((socket) => {
      console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
      void startPeer("server", socket, args).catch((err) => console.error(err));
    });
    server.listen(args.port, args.host, () => {
      console.log(`Listening on ${args.host}:${args.port}`);
    });
  } else {
    const socket = createConnection({ host: args.host, port: args.port }, () => {
      console.log(`Connected to ${args.host}:${args.port}`);
      void startPeer("client", socket, args).catch((err) => console.error(err));
    });
  }
};

void main();
