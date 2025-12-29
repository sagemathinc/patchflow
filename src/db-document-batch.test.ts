import { createDbCodec } from "./db-document-immutable";
import { createImmerDbCodec } from "./db-document-immer";
import type { DocCodec } from "./types";

type Backend = {
  name: string;
  codec: () => DocCodec;
};

const backends: Backend[] = [
  { name: "immutable", codec: () => createDbCodec({ primaryKeys: ["id"], stringCols: ["body"] }) },
  { name: "immer", codec: () => createImmerDbCodec({ primaryKeys: ["id"], stringCols: ["body"] }) },
];

const applyPatches = (doc: any, patches: unknown[]) => {
  let current = doc;
  for (const patch of patches) {
    current = current.applyPatch(patch);
  }
  return current;
};

describe.each(backends)("%s DbDocument applyPatch sequence", ({ codec }) => {
  it("applies a sequence of patches to reach the same final state", () => {
    const docCodec = codec();
    const base = docCodec.fromString("") as any;
    const doc1 = base.set([
      { id: 1, body: "hello", count: 1 },
      { id: 2, body: "bye", count: 2 },
    ]) as any;
    const doc2 = doc1.set({ id: 1, body: "hello world", count: 2 }) as any;
    const doc3 = doc2.delete({ id: 2 }) as any;

    const patches = [
      base.makePatch(doc1),
      doc1.makePatch(doc2),
      doc2.makePatch(doc3),
    ];

    const finalDoc = applyPatches(base, patches);
    expect(finalDoc.isEqual(doc3)).toBe(true);
    expect(finalDoc.count()).toBe(1);
    expect(finalDoc.toString()).toBe(doc3.toString());
  });
});
