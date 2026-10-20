/*
A merge commit records its merged value as a diff from one parent (see
Session.recordMerge), chosen among at most 2 of its parents, in their
canonical order (sorted by patch id), the earlier one on a tie. Readers
apply the recorded diff and never choose again (patchflow#26, P1).
*/

import { PatchGraph } from "./patch-graph";
import { Session } from "./session";
import { MemoryPatchStore } from "./adapters/memory-patch-store";
import { mergeStrings3 } from "./merge3";
import { StringCodec, StringDocument } from "./string-document";
import { comparePatchId } from "./patch-id";
import type { DocCodec, PatchEnvelope } from "./types";

const doc = (s: string) => new StringDocument(s);

// The codec, counting the diffs it makes.
let diffs = 0;
const codec: DocCodec = {
  ...(StringCodec as any),
  makePatch: (a, b) => {
    diffs += 1;
    return StringCodec.makePatch(a as any, b as any);
  },
  merge3: (base, a, b, ancestors) =>
    doc(
      mergeStrings3({
        base: base.toString(),
        a: a.toString(),
        b: b.toString(),
        ancestors: ancestors?.map(String),
      }),
    ),
};

// n writers that commit from one common patch, each its own line; the
// first then merges them all.
async function heads(n: number, lines: (i: number) => string) {
  let now = 1000;
  const clock = () => now++;
  const sessions: Session[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Session({
      codec,
      patchStore: new MemoryPatchStore(),
      clock,
      clientId: `c${i}`,
      userId: i,
    });
    await s.init();
    sessions.push(s);
  }
  const [a] = sessions;
  const root = a.commit(doc("root\n"));
  for (const s of sessions.slice(1)) s.applyRemote(root);
  const tips = sessions.map((s, i) => s.commit(doc(`root\n${lines(i)}`)));
  for (const t of tips.slice(1)) a.applyRemote(t);
  return { a, sessions, all: [root, ...tips] };
}

describe("a merge records its value from one of at most 2 parents", () => {
  test("an 8-head merge makes its own patch and at most 2 candidate diffs", async () => {
    const { a, sessions } = await heads(8, (i) => `${"line\n".repeat(i)}${i}\n`);
    expect(a.getHeads()).toHaveLength(8);
    diffs = 0;
    const merge = a.commit(doc(`${a.getDocument()}merged\n`));
    expect(merge.parents).toHaveLength(8);
    expect(diffs).toBe(1 + 2);
    // From one of the first 2 parents, in their canonical order.
    const canonical = [...merge.parents!].sort(comparePatchId);
    expect(merge.parents!).toEqual(canonical);
    expect(canonical.slice(0, 2)).toContain(merge.mergeParent);
    for (const s of sessions) s.close();
  });

  test("the recorded diff reconstructs the merged value, for a reader that never chooses", async () => {
    const { a, sessions, all } = await heads(6, (i) => `${i}\n`);
    const merge = a.commit(doc(`${a.getDocument()}after\n`));
    // A reader with only the history: the merged parents' value, as
    // recorded, is mergeParent's value with mergePatch applied.
    const g = new PatchGraph({ codec });
    g.add([...all, merge]);
    const parentValue = g.exactValueOf([merge.mergeParent!])!;
    const recorded = codec.applyPatch(parentValue, merge.mergePatch);
    expect(recorded.toString()).toBe(g.exactValueOf(merge.parents!)!.toString());
    expect(g.value().toString()).toBe(a.getDocument().toString());
    for (const s of sessions) s.close();
  });

  test("the choice is deterministic: two writers merging the same history record the same parent", async () => {
    const run = async () => {
      const { a, sessions } = await heads(5, (i) => `${"x".repeat(3 * i)}${i}\n`);
      const merge = a.commit(doc(`${a.getDocument()}m\n`));
      for (const s of sessions) s.close();
      return merge;
    };
    const one: PatchEnvelope = await run();
    const two: PatchEnvelope = await run();
    expect(two.mergeParent).toBe(one.mergeParent);
    expect(JSON.stringify(two.mergePatch)).toBe(JSON.stringify(one.mergePatch));
  });

  test("on a tie the earlier parent is recorded", async () => {
    // Two heads with the same change: the merge is that change, and both
    // candidate diffs are empty, the same size.
    const { a, sessions } = await heads(2, () => "same\n");
    const merge = a.commit(a.getDocument());
    expect(merge.parents).toHaveLength(2);
    const [first] = [...merge.parents!].sort(comparePatchId);
    expect(merge.mergeParent).toBe(first);
    for (const s of sessions) s.close();
  });
});
