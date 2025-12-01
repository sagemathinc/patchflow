import { PatchGraph } from "./patch-graph";
import { StringCodec, StringDocument } from "./string-document";
import { threeWayMerge } from "./dmp";
import type { DocCodec, Document } from "./types";

describe("PatchGraph with StringDocument", () => {
  const codec = StringCodec;

  it("applies patches in order and returns the merged document", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const v1 = new StringDocument("hello");
    const v2 = new StringDocument("hello world");

    const p1 = base.makePatch(v1);
    const p2 = v1.makePatch(v2);

    graph.add([
      { time: 1, patch: p1, parents: [], userId: 0 },
      { time: 2, patch: p2, parents: [1], userId: 0 },
    ]);

    const doc = graph.value();
    expect(doc.toString()).toBe("hello world");
    expect(graph.getHeads()).toEqual([2]);
  });

  it("respects withoutTimes when computing value", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const v1 = new StringDocument("A");
    const v2 = new StringDocument("AB");

    const p1 = base.makePatch(v1);
    const p2 = v1.makePatch(v2);

    graph.add([
      { time: 10, patch: p1, parents: [], userId: 1 },
      { time: 20, patch: p2, parents: [10], userId: 1 },
    ]);

    const doc = graph.value({ withoutTimes: [20] });
    expect(doc.toString()).toBe("A");
  });

  it("uses snapshots when present", () => {
    const graph = new PatchGraph({ codec });
    const snapDoc = new StringDocument("snap");
    graph.add([
      { time: 5, isSnapshot: true, snapshot: snapDoc.toString(), parents: [] },
      { time: 6, patch: snapDoc.makePatch(new StringDocument("snappy")), parents: [5] },
    ]);
    expect(graph.value().toString()).toBe("snappy");
  });

  it("dedups identical file-load patches close in time", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const doc1 = new StringDocument("X");
    const filePatch = base.makePatch(doc1);
    graph.add([
      { time: 1, patch: filePatch, parents: [], file: true },
      { time: 2, patch: filePatch, parents: [], file: true },
    ]);
    expect(graph.version(1).toString()).toBe("X");
    expect(graph.version(2).toString()).toBe("X");
  });

  it("handles divergent branches and merges them", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const docA = new StringDocument("A");
    const docB = new StringDocument("B");
    const mergedString = threeWayMerge({
      base: base.toString(),
      local: docA.toString(),
      remote: docB.toString(),
    });
    const docMerged = new StringDocument(mergedString);

    const pA = base.makePatch(docA);
    const pB = base.makePatch(docB);
    // Merge patch reflects a 3-way merge of the heads and records a snapshot.
    // The algorithm is: take the current heads (A and B), find their newest
    // common ancestor (the empty base), run a 3-way merge (diff-match-patch
    // decides whether the result is AB, BA, or something fuzzier), and
    // materialize that merged text as a snapshot node. We still keep the
    // original branch tips so timetravel can show exactly what each user
    // committed before the merge.
    graph.add([
      { time: 1, patch: pA, parents: [], userId: 0 },
      { time: 2, patch: pB, parents: [], userId: 1 },
      {
        time: 3,
        parents: [1, 2],
        userId: 0,
        isSnapshot: true,
        snapshot: docMerged.toString(),
      },
    ]);

    expect(graph.getHeads()).toEqual([3]);
    expect(graph.value().toString()).toBe(mergedString);
    expect(graph.version(1).toString()).toBe("A");
    expect(graph.version(2).toString()).toBe("B");
  });

  it("defaults to 3-way merging of heads, with apply-all still available", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const docA = new StringDocument("A");
    const docB = new StringDocument("B");

    graph.add([
      { time: 1, patch: base.makePatch(docA), parents: [], userId: 0 },
      { time: 2, patch: base.makePatch(docB), parents: [], userId: 1 },
    ]);

    const defaultMerged = graph.value().toString();
    const expectedThreeWay = threeWayMerge({
      base: base.toString(),
      local: docA.toString(),
      remote: docB.toString(),
    });
    const threeWay = graph.value({ mergeStrategy: "three-way" }).toString();

    // Default is 3-way; apply-all remains opt-in for legacy behavior.
    expect(defaultMerged).toBe(expectedThreeWay);
    expect(threeWay).toBe(expectedThreeWay);
    expect(graph.value({ mergeStrategy: "apply-all" }).toString()).not.toBe("");
  });

  it("exposes history helpers for parents, ancestors, chains, and ranges", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const docA = new StringDocument("A");
    const docB = new StringDocument("B");
    const docAB = new StringDocument("AB");

    graph.add([
      { time: 1, patch: base.makePatch(docA), parents: [], userId: 0 },
      { time: 2, patch: base.makePatch(docB), parents: [], userId: 1 },
      { time: 3, patch: docA.makePatch(docAB), parents: [1], userId: 0 },
      { time: 4, isSnapshot: true, snapshot: docAB.toString(), parents: [3, 2] },
    ]);

    expect(graph.getParents(3)).toEqual([1]);
    expect(graph.getAncestors(3)).toEqual([1, 3]); // stops at snapshot by default
    expect(graph.getAncestors(4, { stopAtSnapshots: false, includeSelf: true })).toEqual([
      1, 2, 3, 4,
    ]);

    expect(graph.getParentChains(4, { stopAtSnapshots: false })).toEqual([
      [4, 3, 1],
      [4, 2],
    ]);

    expect(graph.versionsInRange({ start: 2, end: 3 })).toEqual([2, 3]);
  });
});

describe("PatchGraph caching", () => {
  class FakeDoc implements Document {
    constructor(public readonly content: string) {}
    applyPatch(patch: unknown): Document {
      return new FakeDoc(this.content + String(patch ?? ""));
    }
    makePatch(other: Document): unknown {
      return (other as FakeDoc).content.slice(this.content.length);
    }
    isEqual(other?: Document): boolean {
      return (other as FakeDoc)?.content === this.content;
    }
    toString(): string {
      return this.content;
    }
    set(value: unknown): Document {
      return new FakeDoc(String(value ?? ""));
    }
    get(): unknown {
      return this.content;
    }
    getOne(): unknown {
      return this.content;
    }
    delete(): Document {
      return new FakeDoc("");
    }
    changes(): unknown {
      return undefined;
    }
    count(): number {
      return this.content.length;
    }
  }

  const makeCodec = (applyCount: { n: number }): DocCodec => ({
    fromString: (s: string) => new FakeDoc(s),
    toString: (d: Document) => (d as FakeDoc).toString(),
    applyPatch: (doc: Document, patch: unknown) => {
      applyCount.n += 1;
      return doc.applyPatch(patch);
    },
    makePatch: (a: Document, b: Document) => a.makePatch(b),
  });

  it("reuses cached value for same head without exclusions", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    graph.add([{ time: 1, parents: [], patch: "A" }]);

    const first = graph.value();
    expect(first.toString()).toBe("A");
    expect(applyCount.n).toBe(1);

    const second = graph.value();
    expect(second.toString()).toBe("A");
    expect(applyCount.n).toBe(1); // cached, no re-apply
    expect(first).toBe(second); // same cached instance
  });

  it("busts cache when reachability changes (new patch)", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    graph.add([{ time: 1, parents: [], patch: "A" }]);
    graph.value();
    expect(applyCount.n).toBe(1);

    applyCount.n = 0;
    graph.add([{ time: 2, parents: [1], patch: "B" }]);
    const doc = graph.value();
    expect(doc.toString()).toBe("AB");
    // Reuses cached prefix (patch 1) and applies only the new patch.
    expect(applyCount.n).toBe(1);
  });

  it("does not cache when exclusions are present", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    graph.add([
      { time: 1, parents: [], patch: "A" },
      { time: 2, parents: [1], patch: "B" },
    ]);
    graph.value(); // fill cache for head=2
    applyCount.n = 0;

    const doc = graph.value({ withoutTimes: [2] });
    expect(doc.toString()).toBe("A");
    // Only patch 1 applied; importantly, we recomputed instead of using cached head=2.
    expect(applyCount.n).toBe(1);
  });

  it("reuses prefix when moving forward one version at a time", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    graph.add([
      { time: 1, parents: [], patch: "A" },
      { time: 2, parents: [1], patch: "B" },
      { time: 3, parents: [2], patch: "C" },
    ]);

    // First evaluation applies all three patches.
    const v3 = graph.value({ time: 3 });
    expect(v3.toString()).toBe("ABC");
    expect(applyCount.n).toBe(3);

    // Moving to next version uses cached value at time 3 and only applies patch 4.
    applyCount.n = 0;
    graph.add([{ time: 4, parents: [3], patch: "D" }]);
    const v4 = graph.value({ time: 4 });
    expect(v4.toString()).toBe("ABCD");
    expect(applyCount.n).toBe(1); // only the new patch was applied
  });
});
