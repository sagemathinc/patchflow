import { Session } from "./session";
import { StringCodec, StringDocument } from "./string-document";
import { MemoryPatchStore } from "./adapters/memory-patch-store";
import { MemoryFileAdapter } from "./adapters/memory-file-adapter";
import { MemoryPresenceAdapter } from "./adapters/memory-presence-adapter";
import type { CursorSnapshot } from "./types";

describe("Session", () => {
  it("commits and merges remote patches", async () => {
    const store = new MemoryPatchStore();
    const sessionA = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    const sessionB = new Session({ codec: StringCodec, patchStore: store, userId: 2 });
    await sessionA.init();
    await sessionB.init();

    const doc1 = new StringDocument("hello");
    await sessionA.commit(doc1);
    expect(sessionA.getDocument().toString()).toBe("hello");

    // sessionB should receive the remote patch and reflect it
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionB.getDocument().toString()).toBe("hello");

    // sessionB edits
    const doc2 = new StringDocument("hello world");
    await sessionB.commit(doc2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionA.getDocument().toString()).toBe("hello world");
  });

  it("rebases a staged working copy across remote patches", async () => {
    const store = new MemoryPatchStore();
    const sessionA = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    const sessionB = new Session({ codec: StringCodec, patchStore: store, userId: 2 });
    await sessionA.init();
    await sessionB.init();

    await sessionA.commit(new StringDocument("hello"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionB.getDocument().toString()).toBe("hello");

    sessionB.setWorkingCopy(new StringDocument("hello local"));

    await sessionA.commit(new StringDocument("REMOTE hello"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionB.getDocument().toString()).toBe("REMOTE hello local");

    await sessionB.commit(sessionB.getDocument());
    expect(sessionB.versions().length).toBe(3);
  });

  it("supports undo/redo of local commits", async () => {
    const store = new MemoryPatchStore();
    const session = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    await session.init();

    await session.commit(new StringDocument("A"));
    await session.commit(new StringDocument("AB"));
    expect(session.getDocument().toString()).toBe("AB");

    session.undo();
    expect(session.getDocument().toString()).toBe("A");

    session.undo();
    expect(session.getDocument().toString()).toBe("");

    session.redo();
    expect(session.getDocument().toString()).toBe("A");
    session.redo();
    expect(session.getDocument().toString()).toBe("AB");
  });

  it("retains undo state when exiting undo mode", async () => {
    const store = new MemoryPatchStore();
    const session = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    await session.init();

    await session.commit(new StringDocument("A"));
    await session.commit(new StringDocument("AB"));
    expect(session.getDocument().toString()).toBe("AB");

    session.undo(); // back to "A"
    expect(session.getDocument().toString()).toBe("A");

    await session.resetUndo(); // exit undo mode should keep "A" and clear redo stack
    expect(session.getDocument().toString()).toBe("A");
    // A new patch is created to preserve the undone state.
    expect(session.versions().length).toBe(3);

    session.redo(); // redo should be a no-op now
    expect(session.getDocument().toString()).toBe("A");
  });

  it("keeps version numbers monotonic after reloading truncated history", async () => {
    const base = new StringDocument("");
    const seeded = new StringDocument("seed");
    const seedPatch = base.makePatch(seeded);
    // Simulate a truncated history where the only known patch has version 11.
    const store = new MemoryPatchStore([
      { time: 100, patch: seedPatch, parents: [], userId: 0, version: 11 },
    ]);

    const session = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    await session.init();
    expect(session.versions()).toEqual([100]);
    expect(session.getDocument().toString()).toBe("seed");

    session.commit(new StringDocument("seed+1"));
    const history = session.history();
    expect(history.length).toBe(2);
    const last = history[history.length - 1];
    expect(last.version).toBe(12);
  });

  it("initializes from existing remote patches", async () => {
    const store = new MemoryPatchStore();
    const existing = new StringDocument("seed");
    const base = new StringDocument("");
    const patch = base.makePatch(existing);
    // preload store
    await store.append({ time: 1, patch, parents: [], userId: 0 });
    const session = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    await session.init();
    expect(session.getDocument().toString()).toBe("seed");
  });

  it("undo/redo are no-ops at boundaries", async () => {
    const store = new MemoryPatchStore();
    const session = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    await session.init();
    session.undo(); // no commits yet
    expect(session.getDocument().toString()).toBe("");
    await session.commit(new StringDocument("X"));
    session.redo(); // already at top
    expect(session.getDocument().toString()).toBe("X");
    session.undo();
    session.undo(); // extra undo should not throw
    expect(session.getDocument().toString()).toBe("");
  });

  it("syncs file adapter on commit and reacts to external file changes", async () => {
    const store = new MemoryPatchStore();
    const file = new MemoryFileAdapter("");
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      fileAdapter: file,
    });
    await session.init();
    await session.commit(new StringDocument("filedata"));
    expect(await file.read()).toBe("filedata");
    // external write triggers watch and updates session doc
    await file.write("external");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getDocument().toString()).toBe("external");
  });

  it("publishes presence on commit/undo/redo via presence adapter", async () => {
    const store = new MemoryPatchStore();
    const presence = new MemoryPresenceAdapter();
    const seen: unknown[] = [];
    presence.subscribe((state) => seen.push(state));
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      presenceAdapter: presence,
    });
    await session.init();
    await session.commit(new StringDocument("P"));
    session.undo();
    session.redo();
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it("sends presence offline on close when presence adapter is present", async () => {
    const store = new MemoryPatchStore();
    const presence = new MemoryPresenceAdapter();
    const seen: unknown[] = [];
    presence.subscribe((state) => seen.push(state));
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      presenceAdapter: presence,
    });
    await session.init();
    await session.commit(new StringDocument("P"));
    session.close();
    expect(seen.some((s) => s === undefined)).toBe(true);
  });

  it("broadcasts cursor presence via presence adapter", async () => {
    const store = new MemoryPatchStore();
    const presence = new MemoryPresenceAdapter();
    const sessionA = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      presenceAdapter: presence,
      docId: "doc",
    });
    const sessionB = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 2,
      presenceAdapter: presence,
      docId: "doc",
    });
    await sessionA.init();
    await sessionB.init();

    const seen: CursorSnapshot[][] = [];
    sessionB.on("cursors", (states: CursorSnapshot[]) => seen.push(states));

    sessionA.updateCursors([{ pos: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const states = sessionB.cursors();
    expect(states.length).toBe(1);
    expect(states[0].locs).toEqual([{ pos: 1 }]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("drops stale cursor presence after TTL", async () => {
    let now = 0;
    const clock = () => now;
    const store = new MemoryPatchStore();
    const presence = new MemoryPresenceAdapter();
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      presenceAdapter: presence,
      docId: "doc",
      clock,
    });
    await session.init();
    session.updateCursors([{ pos: 1 }]);
    expect(session.cursors({ ttlMs: 1000 }).length).toBe(1);
    now = 2000;
    expect(session.cursors({ ttlMs: 1000 }).length).toBe(0);
  });

  it("queues file writes sequentially without overlap", async () => {
    const store = new MemoryPatchStore();
    let current = "";
    const writes: { content: string; base?: string }[] = [];
    const file = {
      async read(): Promise<string> {
        return current;
      },
      async write(content: string, opts?: { base?: string }): Promise<void> {
        writes.push({ content, base: opts?.base });
        current = content;
        // Simulate a slow write so multiple commits overlap.
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      watch() {
        return () => {};
      },
    };
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      fileAdapter: file,
    });
    await session.init();
    const p1 = session.commit(new StringDocument("one"));
    const p2 = session.commit(new StringDocument("two"));
    await Promise.all([p1, p2]);
    // Wait for queued writes to flush.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toEqual([
      { content: "one", base: "" },
      { content: "two", base: "one" },
    ]);
    expect(await file.read()).toBe("two");
  });

  it("ignores file changes after close", async () => {
    const store = new MemoryPatchStore();
    let current = "";
    let watchCalls = 0;
    const listeners: (() => void)[] = [];
    const file = {
      async read(): Promise<string> {
        return current;
      },
      async write(content: string): Promise<void> {
        current = content;
        for (const fn of listeners) fn();
      },
      watch(onChange: () => void) {
        listeners.push(onChange);
        return () => {
          const idx = listeners.indexOf(onChange);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    };
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      fileAdapter: file,
    });
    session.on("change", () => {
      watchCalls += 1;
    });
    await session.init();
    await session.commit(new StringDocument("alive"));
    expect(await file.read()).toBe("alive");
    const seen = watchCalls;
    session.close();
    await file.write("after-close");
    // Give any stray timers a chance (should be none).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getDocument().toString()).toBe("alive");
    expect(watchCalls).toBe(seen);
  });

  it("flushes remote patches that arrive during an in-flight file write", async () => {
    const store = new MemoryPatchStore();
    const writes: { content: string; base?: string }[] = [];
    let current = "";
    let inFlight = 0;
    const file = {
      async read(): Promise<string> {
        return current;
      },
      async write(content: string, opts?: { base?: string }): Promise<void> {
        if (inFlight !== 0) {
          throw new Error("write overlap");
        }
        inFlight += 1;
        writes.push({ content, base: opts?.base });
        await new Promise((resolve) => setTimeout(resolve, 15));
        current = content;
        inFlight -= 1;
      },
      watch() {
        return () => {};
      },
    };
    const sessionA = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      fileAdapter: file,
    });
    const sessionB = new Session({ codec: StringCodec, patchStore: store, userId: 2 });
    await sessionA.init();
    await sessionB.init();

    const first = sessionA.commit(new StringDocument("one"));
    // While the first write is in-flight, sessionB commits a remote change.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const remote = sessionB.commit(new StringDocument("remote"));
    await Promise.all([first, remote]);
    // Wait for queued writes to drain.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writes).toEqual([
      { content: "one", base: "" },
      { content: "remote", base: "one" },
    ]);
    expect(await file.read()).toBe("remote");
    expect(sessionA.getDocument().toString()).toBe("remote");
    expect(sessionB.getDocument().toString()).toBe("remote");
  });

  it("emits presence events when presence adapter receives updates", async () => {
    const store = new MemoryPatchStore();
    const presence = new MemoryPresenceAdapter();
    const seen: { state: unknown; id: string }[] = [];
    const session = new Session({
      codec: StringCodec,
      patchStore: store,
      userId: 1,
      presenceAdapter: presence,
    });
    session.on("presence", (state, id) => seen.push({ state, id: id as string }));
    await session.init();
    presence.publish({ status: "online" });
    expect(seen).toEqual([{ state: { status: "online" }, id: "memory-1" }]);
  });
});
