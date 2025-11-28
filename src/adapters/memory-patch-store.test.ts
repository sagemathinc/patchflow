import { MemoryPatchStore } from "./memory-patch-store";

describe("MemoryPatchStore", () => {
  it("stores and broadcasts patches", async () => {
    const store = new MemoryPatchStore();
    const seen: number[] = [];
    store.subscribe((env) => seen.push(env.time));
    await store.append({ time: 1, parents: [] });
    await store.append({ time: 2, parents: [] });
    const { patches } = await store.loadInitial();
    expect(patches.map((p) => p.time)).toEqual([1, 2]);
    expect(seen).toEqual([1, 2]);
  });
});
