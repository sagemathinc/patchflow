// sameElements must decide exactly as immutable.js's List(a).equals(List(b)),
// which PatchGraph's file-load dedup used before it stopped importing immutable.
import { List, Map as ImMap, Set as ImSet, Record, Seq } from "immutable";
import { sameElements } from "./same-elements";
import { PatchGraph } from "./patch-graph";
import { legacyPatchId } from "./patch-id";
import type { DocCodec, Document } from "./types";

const listEquals = (a: unknown, b: unknown) => List(a as unknown[]).equals(List(b as unknown[]));

describe("sameElements agrees with List(a).equals(List(b))", () => {
  const shared = [1, 2];
  const Point = Record({ x: 0, y: 0 });
  function* gen(...xs: unknown[]) {
    yield* xs;
  }
  // [name, () => [a, b]]: fresh values each call (generators are consumed)
  const cases: [string, () => [unknown, unknown]][] = [
    // elements
    [
      "equal numbers and strings",
      () => [
        [1, "a", [0, "x"]],
        [1, "a", [0, "x"]],
      ],
    ],
    [
      "the same nested array",
      () => [
        [shared, 3],
        [shared, 3],
      ],
    ],
    ["nested arrays with equal contents (by identity)", () => [[[1, 2]], [[1, 2]]]],
    ["+0 and -0", () => [[0], [-0]]],
    ["NaN and NaN", () => [[NaN], [NaN]]],
    ["equal Dates", () => [[new Date(5)], [new Date(5)]]],
    ["a Date and its time", () => [[new Date(5)], [5]]],
    ["different Dates", () => [[new Date(5)], [new Date(6)]]],
    ["equal immutable Maps (value objects)", () => [[ImMap({ a: 1 })], [ImMap({ a: 1 })]]],
    ["different immutable Maps", () => [[ImMap({ a: 1 })], [ImMap({ a: 2 })]]],
    ["boxed and primitive strings", () => [[Object("s")], ["s"]]],
    ["null and undefined", () => [[null], [undefined]]],
    ["0 and false", () => [[0], [false]]],
    ["different lengths", () => [[1, 2], [1]]],
    ["empty arrays", () => [[], []]],
    // outer containers: what List() makes of them
    ["strings", () => ["abc", "abc"]],
    ["different strings", () => ["abc", "abd"]],
    ["null and undefined patches", () => [null, undefined]],
    ["array-like objects", () => [{ length: 2, 0: "a", 1: "b" }, ["a", "b"]]],
    ["{length: 0}", () => [{ length: 0 }, []]],
    ["native Sets", () => [new Set([1, 2]), new Set([1, 2])]],
    ["a native Set and an array", () => [new Set([1, 2]), [1, 2]]],
    ["native Maps (entries compare by identity)", () => [new Map([[1, 2]]), new Map([[1, 2]])]],
    ["immutable Lists", () => [List([1, 2]), List([1, 2])]],
    ["different immutable Lists", () => [List([1, 2]), List([2, 1])]],
    ["immutable Sets", () => [ImSet([1, 2]), ImSet([1, 2])]],
    ["immutable Maps (entries)", () => [ImMap({ a: 1 }), ImMap({ a: 1 })]],
    ["indexed Seqs", () => [Seq([1, 2]), Seq([1, 2])]],
    ["records", () => [Point({ x: 1 }), Point({ x: 1 })]],
    ["generators", () => [gen(1, 2), gen(1, 2)]],
    ["different generators", () => [gen(1, 2), gen(1, 3)]],
  ];
  for (const [name, make] of cases) {
    it(name, () => {
      expect(sameElements(...make())).toBe(listEquals(...make()));
    });
  }
  it("a value List() cannot take is not equal (where List() throws)", () => {
    expect(() => listEquals({ a: 1 }, { a: 1 })).toThrow(TypeError);
    expect(sameElements({ a: 1 }, { a: 1 })).toBe(false);
  });
});

// A custom codec whose patches are immutable Lists of numbers to add: two
// identical file loads close in time must apply once (as before, when
// PatchGraph compared them with List.equals).
class Counter implements Document {
  constructor(readonly n: number) {}
  applyPatch(patch: unknown): Counter {
    return new Counter(this.n + List(patch as number[]).reduce((s: number, x: number) => s + x, 0));
  }
  applyPatchBatch(patches: unknown[]): Counter {
    return patches.reduce((d: Counter, p) => d.applyPatch(p), this);
  }
  makePatch(other: Document): unknown {
    return List([(other as Counter).n - this.n]);
  }
  isEqual(other?: Document): boolean {
    return other instanceof Counter && other.n === this.n;
  }
  toString(): string {
    return String(this.n);
  }
  set(value: unknown): Counter {
    return new Counter(Number(value));
  }
  get(): unknown {
    return this.n;
  }
  count(): number {
    return 1;
  }
}
const counterCodec: DocCodec = {
  fromString: (text) => new Counter(Number(text || 0)),
  toString: (doc) => doc.toString(),
  applyPatch: (doc, patch) => doc.applyPatch(patch),
  applyPatchBatch: (doc, patches) => doc.applyPatchBatch(patches),
  makePatch: (a, b) => a.makePatch(b),
};

describe("file-load dedup with a codec whose patches are immutable Lists", () => {
  it("two identical file loads close in time apply once", () => {
    const graph = new PatchGraph({ codec: counterCodec });
    const t1 = legacyPatchId(1);
    const t2 = legacyPatchId(2);
    graph.add([
      { time: t1, patch: List([1]), parents: [], file: true },
      { time: t2, patch: List([1]), parents: [], file: true },
    ]);
    expect(graph.value().toString()).toBe("1");
  });
});
