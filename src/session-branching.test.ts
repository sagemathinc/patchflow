import { Session } from "./session";
import { StringCodec, StringDocument } from "./string-document";
import { MemoryPatchStore } from "./adapters/memory-patch-store";

describe("Session branching and merge", () => {
  it("keeps multiple heads and merges when a patch depends on both", async () => {
    const store = new MemoryPatchStore();
    const sessionA = new Session({ codec: StringCodec, patchStore: store, userId: 1 });
    const sessionB = new Session({ codec: StringCodec, patchStore: store, userId: 2 });
    await sessionA.init();
    await sessionB.init();

    // Two divergent edits
    await sessionA.commit(new StringDocument("A"));
    await sessionB.commit(new StringDocument("B"));

    // Merge on A side
    const merged = new StringDocument("AB");
    await sessionA.commit(merged);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionA.getDocument().toString()).toBe("AB");
    expect(sessionB.getDocument().toString()).toBe("AB");
  });
});
