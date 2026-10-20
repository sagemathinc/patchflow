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

  it("inherited keys never count: a caller's meta whose prototype changed after the preview still commits the snapshot", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("x\n"));
    const meta: { [key: string]: any } = { nested: { x: 1 } };
    const preview = s.previewCommit(doc("x\ny\n"), { meta });
    const measured = json(preview);
    // Not JSON data: an inherited key, added after the preview.
    Object.setPrototypeOf(meta.nested, { ignored: "not JSON data" });
    expect(meta.nested.ignored).toBe("not JSON data");
    s.commit(doc("x\ny\n"), { meta, preview });
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
    // p2 ended p1.
    expect(() => s.commit(doc("x\ny\n"), { meta, preview: p1 })).toThrow(/out of date/);
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
        // One patch and 2 candidate merge diffs (MAX_MERGE_PARENT_CANDIDATES),
        // all in the preview.
        expect(counts.diffs).toBe(3);
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

  it("one active preview: a newer one ends and releases the older", async () => {
    const { clock } = fixedClock();
    const { s, store } = await session("a", { clock });
    s.commit(doc("x\n"));
    // The session's own copies of the previews it still holds.
    const held = () => {
      const active = (s as any).activePreview;
      return active == null ? [] : [active.preview.envelope];
    };
    const p1 = s.previewCommit(doc("x\ny\n"));
    const own1 = held()[0];
    expect(own1).toBeDefined();
    const p2 = s.previewCommit(doc("x\nz\n"));
    expect(held()).toHaveLength(1);
    expect(held()[0]).not.toBe(own1);
    const before = state(s, store);
    expect(() => s.commit(doc("x\ny\n"), { preview: p1 })).toThrow(/out of date/);
    expect(state(s, store)).toBe(before);
    // Refusing the ended p1 leaves p2 active.
    expect(held()).toHaveLength(1);
    // Many previews in a row hold one envelope.
    for (let i = 0; i < 100; i++) s.previewCommit(doc(`x\n${i}\n`));
    expect(held()).toHaveLength(1);
    expect(() => s.commit(doc("x\nz\n"), { preview: p2 })).toThrow(/out of date/);
    const last = s.previewCommit(doc("x\nlast\n"));
    // A refused commit of the active preview ends it too.
    expect(() => s.commit(doc("x\nOTHER\n"), { preview: last })).toThrow(/differs/);
    expect(held()).toHaveLength(0);
    const next = s.previewCommit(doc("x\nlast\n"));
    expect(json(s.commit(doc("x\nlast\n"), { preview: next }))).toBe(json(next));
    expect(held()).toHaveLength(0);
    s.close();
  });

  it("cancelPreview and close end the active preview; a stale one stays held until then", async () => {
    const { clock, tick } = fixedClock();
    const { s: a } = await session("a", { clock });
    const { s: b } = await session("b", { clock });
    const e0 = a.commit(doc("x\n"));
    b.applyRemote(e0);
    const active = () => (a as any).activePreview;

    let p = a.previewCommit(doc("x\n1\n"));
    a.cancelPreview(e0); // not the active preview: ignored
    expect(active()).toBeDefined();
    a.cancelPreview(p);
    expect(active()).toBeUndefined();
    expect(() => a.commit(doc("x\n1\n"), { preview: p })).toThrow(/out of date/);

    a.previewCommit(doc("x\n2\n"));
    a.cancelPreview();
    expect(active()).toBeUndefined();

    // Out of date (a plain commit, a remote patch): held, one slot, until
    // refused at commit.
    p = a.previewCommit(doc("x\n3\n"));
    a.commit(doc("x\nplain\n"));
    tick();
    a.applyRemote(b.commit(doc("x\nremote\n")));
    expect(active()?.shown).toBe(p);
    expect(() => a.commit(doc("x\n3\n"), { preview: p })).toThrow(/out of date/);
    expect(active()).toBeUndefined();

    a.previewCommit(doc("x\n5\n"));
    a.close();
    expect(active()).toBeUndefined();
    b.close();
  });

  describe("own keys named like Object.prototype members are kept as data", () => {
    // A pure JSON codec whose patch is the whole next value: a patch holds
    // exactly the keys of the document.
    const jsonCodec: DocCodec = {
      ...codec,
      makePatch: (_a, b) => JSON.parse(b.toString()),
      applyPatch: (_d, p) => doc(JSON.stringify(p)),
      applyPatchBatch: (d, ps) => (ps.length === 0 ? d : doc(JSON.stringify(ps[ps.length - 1]))),
    };
    const texts = [
      '{"__proto__":null,"v":"new"}',
      '{"__proto__":{"polluted":true},"v":"new"}',
      '{"__proto__":"x","v":"new"}',
      '{"constructor":{"prototype":1},"toString":"t","hasOwnProperty":0,"v":"new"}',
      '{"nested":{"__proto__":[1,{"__proto__":null}]},"v":"new"}',
    ];
    for (const text of texts) {
      it(`in meta and in the patch: ${text}`, async () => {
        const store = new MemoryPatchStore([]);
        const { clock } = fixedClock();
        const s = new Session({ codec: jsonCodec, patchStore: store, clock, clientId: "a" });
        await s.init();
        s.commit(doc('{"v":"old"}'));
        const meta = JSON.parse(text);
        const preview = s.previewCommit(doc(text), { meta });
        const measured = json(preview);
        // Both the meta and the patch kept every own key.
        expect(JSON.stringify(preview.meta)).toBe(JSON.stringify(JSON.parse(text)));
        expect(JSON.stringify(preview.patch)).toBe(JSON.stringify(JSON.parse(text)));
        expect(JSON.stringify(preview.meta).length).toBe(text.length);
        const committed = s.commit(doc(text), { meta, preview });
        expect(json(committed)).toBe(measured);
        expect(json(lastStored(store))).toBe(measured);
        expect(s.getDocument().toString()).toBe(text);
        // A meta without that key is a different commit.
        const p2 = s.previewCommit(doc(`${text} `), { meta });
        const { v } = meta;
        expect(() => s.commit(doc(`${text} `), { meta: { v }, preview: p2 })).toThrow(
          /differs from its preview/,
        );
        expect(({} as any).polluted).toBeUndefined();
        s.close();
      });
    }
  });

  it("refused after a remote branch that changes only the heads (an interning codec)", async () => {
    // Equal values are the same object, so the committed document doesn't
    // change when an older remote no-op branch arrives; nor do the version
    // counter, the logical time or the user. Only the graph (its heads) does.
    const interned = new Map<string, StringDocument>();
    const idoc = (text: string) => {
      let d = interned.get(text);
      if (d == null) interned.set(text, (d = doc(text)));
      return d;
    };
    const interning: DocCodec = {
      ...codec,
      fromString: (t) => idoc(t),
      applyPatch: (d, p) => idoc(codec.applyPatch(d, p).toString()),
      applyPatchBatch: (d, ps) => idoc(codec.applyPatchBatch(d, ps).toString()),
      merge3: (base, a, b, ancestors) => idoc(codec.merge3!(base, a, b, ancestors).toString()),
    };
    const ahead = fixedClock(10_000);
    const behind = fixedClock(1000);
    const mk = async (clientId: string, clock: () => number) => {
      const store = new MemoryPatchStore([]);
      const s = new Session({ codec: interning, patchStore: store, clock, clientId });
      await s.init();
      return s;
    };
    const a = await mk("a", ahead.clock);
    const b = await mk("b", behind.clock);
    const e1 = a.commit(idoc("x\n"));
    b.applyRemote(e1);
    ahead.tick();
    a.commit(idoc("x\ny\n"));
    ahead.tick();
    a.commit(idoc("x\ny\nz\n"));
    // b, behind, commits a no-op on e1: version 2, older time.
    const noop = b.commit(idoc("x\n"));
    const preview = a.previewCommit(idoc("x\ny\nz\nw\n"));
    const at = (a as any).activePreview.preview.at;
    a.applyRemote(noop);
    // Only the graph changed.
    const now = (a as any).previewState();
    expect(now.base).toBe(at.base);
    expect(now.maxVersion).toBe(at.maxVersion);
    expect(now.lastTimeMs).toBe(at.lastTimeMs);
    expect(now.userId).toBe(at.userId);
    expect(now.revision).not.toBe(at.revision);
    expect(a.getHeads()).toHaveLength(2);
    expect(() => a.commit(idoc("x\ny\nz\nw\n"), { preview })).toThrow(/out of date/);
    a.close();
    b.close();
  });

  it("refused after commits that failed once the logical time had advanced", async () => {
    let fail = false;
    const failing: DocCodec = {
      ...codec,
      makePatch: (a, b) => {
        if (fail) throw new Error("makePatch failed");
        return codec.makePatch(a, b);
      },
    };
    const store = new MemoryPatchStore([]);
    const { clock } = fixedClock();
    const s = new Session({ codec: failing, patchStore: store, clock, clientId: "a" });
    await s.init();
    s.commit(doc("x\n"));
    const preview = s.previewCommit(doc("x\ny\n"));
    const lastTimeMs = (s as any).lastTimeMs;
    fail = true;
    expect(() => s.commit(doc("x\n1\n"))).toThrow(/makePatch failed/);
    expect(() => s.commit(doc("x\n2\n"))).toThrow(/makePatch failed/);
    fail = false;
    expect((s as any).lastTimeMs).toBeGreaterThan(lastTimeMs);
    const before = state(s, store);
    // Committing the preview would move the logical time backward.
    expect(() => s.commit(doc("x\ny\n"), { preview })).toThrow(/out of date/);
    expect(state(s, store)).toBe(before);
    s.close();
  });

  it("refused after an undo when the parents' exact value is unknown", async () => {
    // As in the inexact test: a session without the history its heads need.
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
    const { clock, tick } = fixedClock(10_000);
    const { s } = await session("late", { clock, patches: [snapshot, ps[4], ps[5]] });
    s.commit(doc(`${s.getDocument()}local\n`));
    tick();
    const next = doc(`${s.getDocument()}g\n`);
    const preview = s.previewCommit(next);
    expect(preview.inexact).toBe(true);
    const at = (s as any).activePreview.preview.at;
    s.undo();
    // Only the document the patch is made against changed.
    const now = (s as any).previewState();
    expect(now.revision).toBe(at.revision);
    expect(now.lastTimeMs).toBe(at.lastTimeMs);
    expect(now.base).not.toBe(at.base);
    expect(() => s.commit(next, { preview })).toThrow(/out of date/);
    // Rightly: the commit it would make now differs from the preview.
    expect(json(s.previewCommit(next))).not.toBe(json(preview));
    s.close();
  });
});
