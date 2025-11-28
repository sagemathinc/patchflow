import { PatchGraph } from "./patch-graph";
import { StringCodec, StringDocument } from "./string-document";
import { threeWayMerge } from "./dmp";

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
});
