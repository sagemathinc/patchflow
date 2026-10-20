import { Session } from "./session";
import { MemoryPatchStore } from "./adapters/memory-patch-store";
import { mergeStrings3 } from "./merge3";
import { StringCodec, StringDocument } from "./string-document";
import { legacyPatchId } from "./patch-id";
import { hashString } from "./value-hash";
import type { DocCodec, Patch, PatchEnvelope } from "./types";

const doc = (s: string) => new StringDocument(s);

const codec: DocCodec = {
  ...(StringCodec as any),
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

// A clock that doesn't move unless told to, so that previewing can be shown
// to change nothing a later commit depends on.
function fixedClock(start = 1000) {
  let now = start;
  return { clock: () => now, tick: (ms = 1) => (now += ms) };
}

async function session(
  clientId: string,
  opts: { clock?: () => number; patches?: Patch[]; userId?: number } = {},
) {
  const store = new MemoryPatchStore(opts.patches ?? []);
  const s = new Session({
    codec,
    patchStore: store,
    clock: opts.clock,
    clientId,
    userId: opts.userId ?? 0,
  });
  await s.init();
  return { s, store };
}

// Everything previewCommit must leave alone.
function state(s: Session, store: MemoryPatchStore) {
  return JSON.stringify({
    heads: s.getHeads(),
    doc: s.getDocument().toString(),
    committed: s.getCommittedDocument().toString(),
    versions: (s as any).graph.versions().length,
    revision: (s as any).graph.revision(),
    lastTimeMs: (s as any).lastTimeMs,
    maxVersion: (s as any).maxVersion,
    undoPtr: (s as any).undoPtr,
    localTimes: (s as any).localTimes,
    stored: (store as any).patches?.length ?? (store as any).list?.length,
  });
}

const json = (e: PatchEnvelope) => JSON.stringify(e);

// The record the store actually holds for the last commit.
const lastStored = (store: MemoryPatchStore): PatchEnvelope => {
  const all = (store as any).patches as PatchEnvelope[];
  return all[all.length - 1];
};

describe("previewCommit", () => {
  it("single head: the preview is the commit, byte for byte, and changes nothing", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("one\n"));
    const before = state(s, store);
    const preview = s.previewCommit(doc("one\ntwo\n"));
    expect(state(s, store)).toBe(before);
    const committed = s.commit(doc("one\ntwo\n"), { preview });
    expect(json(committed)).toBe(json(preview));
    // The record actually stored is the preview, byte for byte.
    expect(json(lastStored(store))).toBe(json(preview));
    expect(committed.parents).toHaveLength(1);
    s.close();
  });

  it("changes nothing a later commit without it sees", async () => {
    const one = fixedClock();
    const two = fixedClock();
    const { s: a } = await session("x", { clock: one.clock });
    const { s: b } = await session("x", { clock: two.clock });
    a.commit(doc("p\n"));
    b.commit(doc("p\n"));
    a.previewCommit(doc("p\nq\n"));
    a.previewCommit(doc("p\nr\n"));
    // a previewed twice, b never: their next commits are the same.
    expect(json(a.commit(doc("p\nq\n")))).toBe(json(b.commit(doc("p\nq\n"))));
    a.close();
    b.close();
  });

  it("several heads: the merge commit, with its mergePatch, is previewed exactly", async () => {
    const { clock, tick } = fixedClock();
    const { s: a, store: storeA } = await session("a", { clock, userId: 0 });
    const { s: b } = await session("b", { clock, userId: 1 });
    const e0 = a.commit(doc("one two three\n"));
    b.applyRemote(e0);
    tick();
    const ea = a.commit(doc("one TWO three\n"));
    const eb = b.commit(doc("one two three four\n"));
    a.applyRemote(eb);
    expect(a.getHeads()).toHaveLength(2);
    tick();
    const preview = a.previewCommit(doc("one TWO three four\nfive\n"));
    expect(preview.parents).toHaveLength(2);
    expect(preview.mergePatch).toBeDefined();
    const before = state(a, storeA);
    const merge = a.commit(doc("one TWO three four\nfive\n"), { preview });
    expect(json(merge)).toBe(json(preview));
    expect(json(lastStored(storeA))).toBe(json(preview));
    expect(state(a, storeA)).not.toBe(before);
    void ea;
    a.close();
    b.close();
  });

  it("without the exact value of its parents: the inexact commit is previewed exactly", async () => {
    const id = legacyPatchId;
    const patch = (t: number, parents: number[], from: string, to: string): Patch => ({
      time: id(t),
      parents: parents.map(id),
      patch: doc(from).makePatch(doc(to)),
      hash: hashString(to),
    });
    const ps = [
      patch(1, [], "", "a\nb\nc\n"),
      patch(2, [1], "a\nb\nc\n", "a\nc\n"),
      patch(3, [1], "a\nb\nc\n", "a\nB\nc\n"),
      patch(4, [2, 3], "a\nB\nc\n", "a\nB\nc\nd\n"),
      patch(5, [4], "a\nB\nc\nd\n", "a\nB\nC!\nd\n"),
      patch(6, [3], "a\nB\nc\n", "a\nB\n"),
    ];
    const snapshot: Patch = { ...ps[3], isSnapshot: true, snapshot: "a\nB\nc\nd\n" };
    const { clock } = fixedClock(10_000);
    const { s, store } = await session("late", {
      clock,
      patches: [snapshot, ps[4], ps[5]],
    });
    const next = doc(`${s.getDocument()}g\n`);
    const before = state(s, store);
    const preview = s.previewCommit(next);
    expect(state(s, store)).toBe(before);
    expect(preview.inexact).toBe(true);
    expect(preview.hash).toBeUndefined();
    const merge = s.commit(next, { preview });
    expect(json(merge)).toBe(json(preview));
    expect(json(lastStored(store))).toBe(json(preview));
    s.close();
  });

  it("a preview is refused once anything changed since it", async () => {
    const { clock, tick } = fixedClock();
    const { s: a } = await session("a", { clock });
    const { s: b } = await session("b", { clock });
    const e0 = a.commit(doc("x\n"));
    b.applyRemote(e0);
    const preview = a.previewCommit(doc("x\ny\n"));
    // A remote patch arrives in between.
    tick();
    a.applyRemote(b.commit(doc("x\nz\n")));
    expect(() => a.commit(doc("x\ny\n"), { preview })).toThrow(/out of date/);
    // A commit in between.
    const p2 = a.previewCommit(doc("1\n"));
    a.commit(doc("2\n"));
    expect(() => a.commit(doc("1\n"), { preview: p2 })).toThrow(/out of date/);
    // A preview used once can't be used again.
    const p3 = a.previewCommit(doc("3\n"));
    a.commit(doc("3\n"), { preview: p3 });
    expect(() => a.commit(doc("3\n"), { preview: p3 })).toThrow(/out of date/);
    a.close();
    b.close();
  });

  it("a preview is refused after a remote patch older than this session's clock", async () => {
    // b's clock is behind a's, so b's patch doesn't move a's clock: only
    // the graph changed.
    const ahead = fixedClock(10_000);
    const behind = fixedClock(1000);
    const { s: a } = await session("a", { clock: ahead.clock });
    const { s: b } = await session("b", { clock: behind.clock });
    a.commit(doc("x\n"));
    // b committed on its own, earlier, and a hears of it only now.
    const older = b.commit(doc("w\n"));
    const lastTimeMs = (a as any).lastTimeMs;
    const preview = a.previewCommit(doc("x\ny\n"));
    a.applyRemote(older);
    expect((a as any).lastTimeMs).toBe(lastTimeMs);
    expect(() => a.commit(doc("x\ny\n"), { preview })).toThrow(/out of date/);
    a.close();
    b.close();
  });

  it("a preview of another document is refused, and nothing is committed", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("x\n"));
    const preview = s.previewCommit(doc("x\ny\n"));
    const before = state(s, store);
    expect(() => s.commit(doc("x\nOTHER\n"), { preview })).toThrow(/differs from its preview/);
    expect(state(s, store)).toBe(before);
    s.close();
  });

  it("meta mutated after the preview: the commit is refused, or stores what was previewed", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("x\n"));
    const meta: { [key: string]: any } = { pad: "x" };
    const preview = s.previewCommit(doc("x\ny\n"), { meta });
    const measured = json(preview);
    meta.pad = "x".repeat(10_000);
    const before = state(s, store);
    expect(() => s.commit(doc("x\ny\n"), { meta, preview })).toThrow(/differs from its preview/);
    expect(state(s, store)).toBe(before);
    // Used once: even with the meta it was previewed with, it is gone.
    expect(() => s.commit(doc("x\ny\n"), { meta: { pad: "x" }, preview })).toThrow(/out of date/);
    // A new preview, committed with an equal meta, stores exactly what it
    // measured.
    const p2 = s.previewCommit(doc("x\ny\n"), { meta: { pad: "x" } });
    expect(json(p2)).toBe(measured);
    expect(json(s.commit(doc("x\ny\n"), { meta: { pad: "x" }, preview: p2 }))).toBe(measured);
    expect(json(lastStored(store))).toBe(measured);
    s.close();
  });

  it("meta shared between calls: each preview keeps the meta it was made with", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("x\n"));
    const meta: { [key: string]: any } = { n: 1, nested: { list: [1, 2] } };
    const p1 = s.previewCommit(doc("x\ny\n"), { meta });
    meta.nested.list.push(3);
    const p2 = s.previewCommit(doc("x\ny\n"), { meta });
    expect(p1.meta).toEqual({ n: 1, nested: { list: [1, 2] } });
    expect(p2.meta).toEqual({ n: 1, nested: { list: [1, 2, 3] } });
    const measured = json(p2);
    expect(() => s.commit(doc("x\ny\n"), { meta, preview: p1 })).toThrow(
      /differs from its preview/,
    );
    const committed = s.commit(doc("x\ny\n"), { meta, preview: p2 });
    // The caller's object is not what was stored, and changing it now
    // changes nothing stored.
    expect(committed.meta).not.toBe(meta);
    meta.n = 99;
    expect(json(lastStored(store))).toBe(measured);
    s.close();
  });

  it("the preview handed out is frozen: edits to wall, meta or patch throw", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("x\n"));
    const preview = s.previewCommit(doc("x\ny\n"), { meta: { pad: "x" } });
    const measured = json(preview);
    expect(() => {
      (preview as any).wall = Number.MAX_SAFE_INTEGER;
    }).toThrow(TypeError);
    expect(() => {
      (preview.meta as any).pad = "x".repeat(10_000);
    }).toThrow(TypeError);
    expect(() => {
      (preview.patch as any).push([]);
    }).toThrow(TypeError);
    expect(() => {
      (preview as any).extra = 1;
    }).toThrow(TypeError);
    s.commit(doc("x\ny\n"), { meta: { pad: "x" }, preview });
    expect(json(lastStored(store))).toBe(measured);
    s.close();
  });

  it("a binary patch edited after the preview is refused, and nothing is committed", async () => {
    // A codec whose patches are bytes, which can't be frozen.
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const bytes: DocCodec = {
      ...codec,
      makePatch: (a, b) => enc.encode(JSON.stringify(codec.makePatch(a, b))),
      applyPatch: (d, p) => codec.applyPatch(d, JSON.parse(dec.decode(p as Uint8Array))),
      applyPatchBatch: (d, ps) =>
        codec.applyPatchBatch(
          d,
          ps.map((p) => JSON.parse(dec.decode(p as Uint8Array))),
        ),
    };
    const store = new MemoryPatchStore([]);
    const { clock } = fixedClock();
    const s = new Session({ codec: bytes, patchStore: store, clock, clientId: "a" });
    await s.init();
    s.commit(doc("x\n"));
    const preview = s.previewCommit(doc("x\ny\n"));
    const original = (preview.patch as Uint8Array).slice();
    (preview.patch as Uint8Array)[0] ^= 1;
    const before = state(s, store);
    expect(() => s.commit(doc("x\ny\n"), { preview })).toThrow(/modified/);
    expect(state(s, store)).toBe(before);
    // An unmodified preview stores its own bytes, not the caller's array.
    const p2 = s.previewCommit(doc("x\ny\n"));
    expect(Array.from(p2.patch as Uint8Array)).toEqual(Array.from(original));
    const committed = s.commit(doc("x\ny\n"), { preview: p2 });
    expect(committed.patch).not.toBe(p2.patch);
    (p2.patch as Uint8Array)[0] ^= 1;
    expect(Array.from(lastStored(store).patch as Uint8Array)).toEqual(Array.from(original));
    s.close();
  });

  it("reads the clock once to preview and not at all to commit the preview", async () => {
    let reads = 0;
    let now = 1000;
    const clock = () => {
      reads += 1;
      return now++;
    };
    const { s } = await session("a", { clock });
    s.commit(doc("x\n"));
    const r0 = reads;
    const preview = s.previewCommit(doc("x\ny\n"));
    expect(reads - r0).toBe(1);
    s.commit(doc("x\ny\n"), { preview });
    expect(reads - r0).toBe(1);
    // A plain commit reads it twice (time and wall), as before.
    s.commit(doc("x\ny\nz\n"));
    expect(reads - r0).toBe(3);
    s.close();
  });

  it("commit({ preview }) computes nothing again: an 8-head merge costs what a plain commit does", async () => {
    // The same 8-head merge, committed plainly and through a preview.
    const run = async (previewed: boolean) => {
      const counts = { diffs: 0, hashes: 0 };
      const counting: DocCodec = {
        ...codec,
        makePatch: (a, b) => {
          counts.diffs += 1;
          return codec.makePatch(a, b);
        },
        hash: (d) => {
          counts.hashes += 1;
          return hashString(d.toString());
        },
      };
      const { clock, tick } = fixedClock();
      const mk = async (clientId: string) => {
        const store = new MemoryPatchStore([]);
        const s = new Session({ codec: counting, patchStore: store, clock, clientId });
        await s.init();
        return s;
      };
      const sessions = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h"].map(mk));
      const [a] = sessions;
      const e0 = a.commit(doc("0\n"));
      for (const t of sessions.slice(1)) t.applyRemote(e0);
      tick();
      const heads = sessions.map((t, i) => t.commit(doc(`0\n${"line\n".repeat(i)}${i}\n`)));
      for (const e of heads.slice(1)) a.applyRemote(e);
      expect(a.getHeads()).toHaveLength(8);
      tick();
      const next = doc(`${a.getDocument()}merged\n`);
      counts.diffs = 0;
      counts.hashes = 0;
      let envelope: PatchEnvelope;
      if (previewed) {
        const preview = a.previewCommit(next);
        // One patch and 8 candidate merge diffs, all in the preview.
        expect(counts.diffs).toBe(9);
        const diffs = counts.diffs;
        envelope = a.commit(next, { preview });
        expect(counts.diffs).toBe(diffs);
      } else {
        envelope = a.commit(next);
      }
      expect(envelope.mergePatch).toBeDefined();
      for (const t of sessions) t.close();
      return counts;
    };
    expect(await run(true)).toEqual(await run(false));
  });
});
