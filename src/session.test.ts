import { Session } from "./session";
import { StringCodec, StringDocument } from "./string-document";
import { MemoryPatchStore } from "./adapters/memory-patch-store";
import { MemoryFileAdapter } from "./adapters/memory-file-adapter";
import { MemoryPresenceAdapter } from "./adapters/memory-presence-adapter";

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
    expect(seen).toEqual([{ state: { status: "online" }, id: "memory" }]);
  });
});
