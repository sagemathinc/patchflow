import { createImmerDbCodec } from "./db-document-immer";

// A patch of n new records, each keyed by several fields one of which all
// of them share (a board's records are keyed by type, page and id, and
// most are type "item"), must apply in time about linear in n.

const codec = createImmerDbCodec({
  primaryKeys: ["type", "page", "id"],
  stringCols: ["text"],
});

function records(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "item",
    page: "",
    id: `n${i}`,
    text: "",
    pos: i,
  }));
}

// The best of a few runs, in ms.
function timeApply(n: number): number {
  const empty = codec.fromString("") as any;
  // fromString builds the document in one pass.
  const full = codec.fromString(
    records(n)
      .map((r) => JSON.stringify(r))
      .join("\n"),
  ) as any;
  const patch = empty.makePatch(full);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    const result = empty.applyPatch(patch);
    best = Math.min(best, performance.now() - start);
    expect(result.count()).toBe(n);
  }
  return best;
}

describe("applying a patch of many records keyed by a shared field", () => {
  it("scales about linearly: 10k, 30k and 100k records", () => {
    timeApply(1_000); // warm up
    const t10 = timeApply(10_000);
    const t30 = timeApply(30_000);
    const t100 = timeApply(100_000);
    // eslint-disable-next-line no-console
    console.log(
      `apply: 10k ${t10.toFixed(0)} ms, 30k ${t30.toFixed(0)} ms, 100k ${t100.toFixed(0)} ms`,
    );
    // Linear is 10x from 10k to 100k; quadratic would be 100x.
    expect(t100 / Math.max(t10, 1)).toBeLessThan(30);
    expect(t30 / Math.max(t10, 1)).toBeLessThan(9);
  }, 120_000);

  it("finds the same records as before", () => {
    const empty = codec.fromString("") as any;
    const doc = empty.applyPatch(empty.makePatch(empty.set(records(50))));
    expect(doc.getOne({ type: "item", page: "", id: "n7" })?.pos).toBe(7);
    expect(doc.get({ type: "item" }).length ?? doc.get({ type: "item" }).size).toBe(50);
    const changed = doc.applyPatch(
      doc.makePatch(doc.set({ type: "item", page: "", id: "n7", pos: 70 })),
    );
    expect(changed.getOne({ type: "item", page: "", id: "n7" })?.pos).toBe(70);
    expect(changed.count()).toBe(50);
    const deleted = changed.applyPatch(
      changed.makePatch(changed.delete({ type: "item", page: "", id: "n7" })),
    );
    expect(deleted.count()).toBe(49);
    expect(deleted.getOne({ type: "item", page: "", id: "n7" })).toBeUndefined();
  });
});
