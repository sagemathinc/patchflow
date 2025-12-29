import { PatchGraph } from "./patch-graph";
import { StringCodec, StringDocument } from "./string-document";
import { threeWayMerge } from "./dmp";
import type { DocCodec, Document } from "./types";
import { legacyPatchId } from "./patch-id";

describe("PatchGraph with StringDocument", () => {
  const codec = StringCodec;

  it("applies patches in order and returns the merged document", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const v1 = new StringDocument("hello");
    const v2 = new StringDocument("hello world");

    const p1 = base.makePatch(v1);
    const p2 = v1.makePatch(v2);

    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    graph.add([
      { time: t1, patch: p1, parents: [], userId: 0 },
      { time: t2, patch: p2, parents: [t1], userId: 0 },
    ]);

    const doc = graph.value();
    expect(doc.toString()).toBe("hello world");
    expect(graph.getHeads()).toEqual([t2]);
  });

  it("respects withoutTimes when computing value", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const v1 = new StringDocument("A");
    const v2 = new StringDocument("AB");

    const p1 = base.makePatch(v1);
    const p2 = v1.makePatch(v2);

    const t10 = legacyPatchId(10);
    const t20 = legacyPatchId(20);
    graph.add([
      { time: t10, patch: p1, parents: [], userId: 1 },
      { time: t20, patch: p2, parents: [t10], userId: 1 },
    ]);

    const doc = graph.value({ withoutTimes: [t20] });
    expect(doc.toString()).toBe("A");
  });

  it("uses snapshots when present", () => {
    const graph = new PatchGraph({ codec });
    const snapDoc = new StringDocument("snap");
    const t5 = legacyPatchId(5);
    const t6 = legacyPatchId(6);
    graph.add([
      { time: t5, isSnapshot: true, snapshot: snapDoc.toString(), parents: [] },
      { time: t6, patch: snapDoc.makePatch(new StringDocument("snappy")), parents: [t5] },
    ]);
    expect(graph.value().toString()).toBe("snappy");
  });

  it("dedups identical file-load patches close in time", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const doc1 = new StringDocument("X");
    const filePatch = base.makePatch(doc1);
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    graph.add([
      { time: t1, patch: filePatch, parents: [], file: true },
      { time: t2, patch: filePatch, parents: [], file: true },
    ]);
    expect(graph.version(t1).toString()).toBe("X");
    expect(graph.version(t2).toString()).toBe("X");
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
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    const t3 = legacyPatchId(3);
    graph.add([
      { time: t1, patch: pA, parents: [], userId: 0 },
      { time: t2, patch: pB, parents: [], userId: 1 },
      {
        time: t3,
        parents: [t1, t2],
        userId: 0,
        isSnapshot: true,
        snapshot: docMerged.toString(),
      },
    ]);

    expect(graph.getHeads()).toEqual([t3]);
    expect(graph.value().toString()).toBe(mergedString);
    expect(graph.version(t1).toString()).toBe("A");
    expect(graph.version(t2).toString()).toBe("B");
  });

  it("defaults to 3-way merging of heads, with apply-all still available", () => {
    const graph = new PatchGraph({ codec });
    const base = new StringDocument("");
    const docA = new StringDocument("A");
    const docB = new StringDocument("B");

    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    graph.add([
      { time: t1, patch: base.makePatch(docA), parents: [], userId: 0 },
      { time: t2, patch: base.makePatch(docB), parents: [], userId: 1 },
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

    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    const t3 = legacyPatchId(3);
    const t4 = legacyPatchId(4);
    graph.add([
      { time: t1, patch: base.makePatch(docA), parents: [], userId: 0 },
      { time: t2, patch: base.makePatch(docB), parents: [], userId: 1 },
      { time: t3, patch: docA.makePatch(docAB), parents: [t1], userId: 0 },
      { time: t4, isSnapshot: true, snapshot: docAB.toString(), parents: [t3, t2] },
    ]);

    expect(graph.getParents(t3)).toEqual([t1]);
    expect(graph.getAncestors(t3)).toEqual([t1, t3]); // stops at snapshot by default
    expect(graph.getAncestors(t4, { stopAtSnapshots: false, includeSelf: true })).toEqual([
      t1,
      t2,
      t3,
      t4,
    ]);

    expect(graph.getParentChains(t4, { stopAtSnapshots: false })).toEqual([
      [t4, t3, t1],
      [t4, t2],
    ]);

    expect(graph.versionsInRange({ start: t2, end: t3 })).toEqual([t2, t3]);
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
    applyPatchBatch: (doc: Document, patches: unknown[]) => {
      let current = doc;
      for (const patch of patches) {
        applyCount.n += 1;
        current = current.applyPatch(patch);
      }
      return current;
    },
    makePatch: (a: Document, b: Document) => a.makePatch(b),
  });

  it("reuses cached value for same head without exclusions", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    const t1 = legacyPatchId(1);
    graph.add([{ time: t1, parents: [], patch: "A" }]);

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
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    graph.add([{ time: t1, parents: [], patch: "A" }]);
    graph.value();
    expect(applyCount.n).toBe(1);

    applyCount.n = 0;
    graph.add([{ time: t2, parents: [t1], patch: "B" }]);
    const doc = graph.value();
    expect(doc.toString()).toBe("AB");
    // Reuses cached prefix (patch 1) and applies only the new patch.
    expect(applyCount.n).toBe(1);
  });

  it("does not cache when exclusions are present", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    graph.add([
      { time: t1, parents: [], patch: "A" },
      { time: t2, parents: [t1], patch: "B" },
    ]);
    graph.value(); // fill cache for head=2
    applyCount.n = 0;

    const doc = graph.value({ withoutTimes: [t2] });
    expect(doc.toString()).toBe("A");
    // Only patch 1 applied; importantly, we recomputed instead of using cached head=2.
    expect(applyCount.n).toBe(1);
  });

  it("reuses prefix when moving forward one version at a time", () => {
    const applyCount = { n: 0 };
    const graph = new PatchGraph({ codec: makeCodec(applyCount) });
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    const t3 = legacyPatchId(3);
    const t4 = legacyPatchId(4);
    graph.add([
      { time: t1, parents: [], patch: "A" },
      { time: t2, parents: [t1], patch: "B" },
      { time: t3, parents: [t2], patch: "C" },
    ]);

    // First evaluation applies all three patches.
    const v3 = graph.value({ time: t3 });
    expect(v3.toString()).toBe("ABC");
    expect(applyCount.n).toBe(3);

    // Moving to next version uses cached value at time 3 and only applies patch 4.
    applyCount.n = 0;
    graph.add([{ time: t4, parents: [t3], patch: "D" }]);
    const v4 = graph.value({ time: t4 });
    expect(v4.toString()).toBe("ABCD");
    expect(applyCount.n).toBe(1); // only the new patch was applied
  });
});
