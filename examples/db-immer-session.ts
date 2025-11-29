/**
 * Two-process demo that syncs a DbDocumentImmer (JSONL-style table) over TCP sockets.
 *
 * Start a server (ts-node):
 *   node --loader ts-node/esm --experimental-specifier-resolution=node examples/db-immer-session.ts --role=server --port=8124
 *
 * Start a client (ts-node, in another shell):
 *   node --loader ts-node/esm --experimental-specifier-resolution=node examples/db-immer-session.ts --role=client --host=127.0.0.1 --port=8124
 *
 * Interactive helpers (in each REPL):
 *   add({id: 1, body: "hello"})    // stage insert/update by primary key
 *   remove({id: 1})                // stage delete by primary key
 *   list()                         // view committed records
 *   commit()                       // commit staged changes and broadcast
 *   getCommitted()                 // stringify committed doc
 */
import { createConnection, createServer, type Socket } from "node:net";
import repl from "node:repl";
import { Session } from "../src/session";
import { createImmerDbCodec, DbDocumentImmer } from "../src/db-document-immer";
import type { JsMap } from "../src/db-util";
import type { PatchEnvelope, PatchStore } from "../src/types";

type Role = "server" | "client";

type Args = {
  role: Role;
  host: string;
  port: number;
  userId: number;
};

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const keyVal = arg.slice(2);
    const eq = keyVal.indexOf("=");
    if (eq >= 0) {
      opts[keyVal.slice(0, eq)] = keyVal.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[keyVal] = next;
      i += 1;
    } else {
      opts[keyVal] = true;
    }
  }
  const role = opts.role === "server" || opts.role === "client" ? opts.role : undefined;
  if (!role) {
    throw new Error("Missing --role (server|client)");
  }
  const host = typeof opts.host === "string" ? opts.host : "127.0.0.1";
  const port = typeof opts.port === "string" ? Number(opts.port) : 8124;
  const userId = typeof opts.userId === "string" ? Number(opts.userId) : role === "server" ? 1 : 2;
  return { role, host, port, userId };
};

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

const logChange = (label: string, session: Session) => {
  session.on("change", (doc) => {
    console.log(`[${label}] committed ->\n${doc.toString()}`);
  });
};

const startPeer = async (role: Role, socket: Socket, args: Args) => {
  const primaryKeys = ["id"];
  const stringCols = ["body"];
  const codec = createImmerDbCodec({ primaryKeys, stringCols });
  console.log(
    `[${role}] DbDocumentImmer configured with primaryKeys=${primaryKeys.join(
      ",",
    )} stringCols=${stringCols.join(",")}`,
  );
  const patchStore = new SocketPatchStore(socket);
  const session = new Session({
    codec,
    patchStore,
    userId: args.userId,
  });

  await session.init();
  logChange(role, session);

  // Staged doc for local edits before commit.
  let staged = session.getDocument() as DbDocumentImmer;

  const globals = globalThis as any;
  globals.add = (record: JsMap) => {
    staged = staged.set(record) as DbDocumentImmer;
    return staged.toString();
  };
  globals.remove = (where: JsMap) => {
    staged = staged.delete(where) as DbDocumentImmer;
    return staged.toString();
  };
  globals.list = (where?: JsMap) => staged.get(where ?? {});
  globals.commit = async () => {
    await session.commit(staged);
    staged = session.getDocument() as DbDocumentImmer;
    return staged.toString();
  };
  globals.getCommitted = () => session.getDocument().toString();
  globals.history = () => {
    const out = session.summarizeHistory();
    console.log(out);
  };
  console.log(
    "Interactive helpers: add({...}), remove({...}), list([where]), commit(), getCommitted(), history()",
  );
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
