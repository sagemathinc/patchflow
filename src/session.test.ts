import { Session } from "./session";
import { StringCodec, StringDocument } from "./string-document";
import { MemoryPatchStore } from "./adapters/memory-patch-store";

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
});
