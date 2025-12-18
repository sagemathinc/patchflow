import { MemoryPatchStore } from "./memory-patch-store";
import { legacyPatchId } from "../patch-id";

describe("MemoryPatchStore", () => {
  it("stores and broadcasts patches", async () => {
    const store = new MemoryPatchStore();
    const seen: string[] = [];
    store.subscribe((env) => seen.push(env.time));
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    await store.append({ time: t1, parents: [], userId: 0 });
    await store.append({ time: t2, parents: [], userId: 0 });
    const { patches } = await store.loadInitial();
    expect(patches.map((p) => p.time)).toEqual([t1, t2]);
    expect(seen).toEqual([t1, t2]);
  });
});
