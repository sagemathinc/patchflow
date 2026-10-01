import { Session } from "./session";
import { PatchGraph } from "./patch-graph";
import { StringCodec, StringDocument } from "./string-document";
import { MemoryPatchStore } from "./adapters/memory-patch-store";
import { MemoryFileAdapter } from "./adapters/memory-file-adapter";
import { mergeStrings3 } from "./merge3";
import { legacyPatchId } from "./patch-id";
import { hashString, sameHashFormat } from "./value-hash";
import { createDbCodec, fromString as dbFromString } from "./db-document-immutable";
import { fromString as immerFromString } from "./db-document-immer";
import type { DocCodec, Inconsistency, PatchEnvelope } from "./types";

const exactCodec: DocCodec = {
  ...StringCodec,
  merge3: (base, a, b, ancestors) =>
    new StringDocument(
      mergeStrings3({
        base: base.toString(),
        a: a.toString(),
        b: b.toString(),
        ancestors: ancestors?.map((d) => d.toString()),
      }),
    ),
};
const doc = (s: string) => new StringDocument(s);

async function session(store: MemoryPatchStore, clientId: string, reports: Inconsistency[]) {
  const s = new Session({ codec: exactCodec, patchStore: store, clientId, userId: 0 });
  s.on("inconsistency", (e: Inconsistency) => reports.push(e));
  await s.init();
  return s;
}

describe("value hashes", () => {
  it("hashes text deterministically", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toMatch(/^s1:[0-9a-f]{16}$/);
    expect(sameHashFormat(hashString("a"), "s1:0")).toBe(true);
    expect(sameHashFormat(hashString("a"), "d1:1:0")).toBe(false);
  });

  it("hashes database records independently of record and key order", () => {
    const pk = new Set(["id"]);
    const none = new Set<string>();
    const a = dbFromString('{"id":1,"x":"a","y":2}\n{"id":2,"x":"b"}', pk, none);
    const b = dbFromString('{"id":2,"x":"b"}\n{"y":2,"x":"a","id":1}', pk, none);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toMatch(/^d1:2:/);
    // Built by different edits, and after a round trip through a snapshot.
    const c = dbFromString('{"id":1,"x":"a"}', pk, none)
      .set({ id: 1, y: 2 })
      .set({ id: 2, x: "b" });
    expect(c.hash()).toBe(a.hash());
    expect(dbFromString(c.toString(), pk, none).hash()).toBe(a.hash());
    expect(c.set({ id: 2, x: "B" }).hash()).not.toBe(a.hash());
    // The immer implementation agrees.
    expect(immerFromString(b.toString(), pk, none).hash()).toBe(a.hash());
    // The codec uses the document's hash.
    const g = new PatchGraph({ codec: createDbCodec({ primaryKeys: ["id"] }) });
    expect(g.hashOf(a)).toBe(a.hash());
  });

  it("records the hash of each commit, and clients that agree report nothing", async () => {
    const store = new MemoryPatchStore();
    const reports: Inconsistency[] = [];
    const a = await session(store, "A", reports);
    const b = await session(store, "B", reports);
    const env = a.commit(doc("hello\n"));
    expect(env.hash).toBe(hashString("hello\n"));
    b.commit(doc("hello\nworld\n"));
    a.commit(doc("well, hello\nworld\n"));
    expect(a.getDocument().toString()).toBe("well, hello\nworld\n");
    expect(b.getDocument().toString()).toBe("well, hello\nworld\n");
    // A client that loads the whole history later agrees too.
    const c = await session(new MemoryPatchStore((store as any).patches), "C", reports);
    expect(c.getDocument().toString()).toBe("well, hello\nworld\n");
    for (const time of c.versions()) expect(c.verifyValue(time)).toBe("ok");
    expect(reports).toEqual([]);
  });

  it("hashes a merge commit with the merged value of its parents", async () => {
    const store = new MemoryPatchStore();
    const reports: Inconsistency[] = [];
    const a = await session(store, "A", reports);
    a.commit(doc("a\nb\nc\n"));
    // Two concurrent edits, then a commit on both heads.
    const [t0] = a.versions();
    const p1: PatchEnvelope = {
      time: legacyPatchId(Date.now() + 1000),
      parents: [t0],
      patch: doc("a\nb\nc\n").makePatch(doc("A\nb\nc\n")),
      hash: hashString("A\nb\nc\n"),
    };
    const p2: PatchEnvelope = {
      time: legacyPatchId(Date.now() + 2000),
      parents: [t0],
      patch: doc("a\nb\nc\n").makePatch(doc("a\nb\nC\n")),
      hash: hashString("a\nb\nC\n"),
    };
    a.applyRemoteBatch([p1, p2]);
    expect(a.getHeads().length).toBe(2);
    const merged = a.commit(doc("A\nb\nC\nd\n"));
    expect(merged.hash).toBe(hashString("A\nb\nC\nd\n"));
    expect(reports).toEqual([]);
  });

  it("reports a patch whose value differs from what its author recorded", () => {
    const reports: Inconsistency[] = [];
    const g = new PatchGraph({ codec: exactCodec, onInconsistency: (e) => reports.push(e) });
    const [t0, t1] = [1, 2].map(legacyPatchId);
    g.add([
      { time: t0, parents: [], patch: doc("").makePatch(doc("x\n")), hash: hashString("x\n") },
      {
        time: t1,
        parents: [t0],
        patch: doc("x\n").makePatch(doc("x\ny\n")),
        hash: hashString("something else"),
        userId: 3,
      },
    ]);
    expect(g.value().toString()).toBe("x\ny\n");
    expect(reports).toEqual([
      {
        kind: "patch",
        time: t1,
        expected: hashString("something else"),
        actual: hashString("x\ny\n"),
        userId: 3,
      },
    ]);
    // Reported once, however often the value is computed.
    g.value();
    expect(g.verifyValue(t1)).toBe("mismatch");
    expect(g.verifyValue(t0)).toBe("ok");
    expect(reports.length).toBe(1);
  });

  it("reports a snapshot that differs from its patch's value, and recovers from the patch", () => {
    const reports: Inconsistency[] = [];
    const g = new PatchGraph({ codec: exactCodec, onInconsistency: (e) => reports.push(e) });
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const p0 = {
      time: t0,
      parents: [],
      patch: doc("").makePatch(doc("x\n")),
      hash: hashString("x\n"),
    };
    const p1 = {
      time: t1,
      parents: [t0],
      patch: doc("x\n").makePatch(doc("x\ny\n")),
      hash: hashString("x\ny\n"),
    };
    const p2 = { time: t2, parents: [t1], patch: doc("x\ny\n").makePatch(doc("x\ny\nz\n")) };
    // Loaded from a wrong snapshot of t1 (it carries t1's hash), without
    // older history.
    g.add([{ time: t1, parents: [], isSnapshot: true, snapshot: "x\nx\ny\n", hash: p1.hash }, p2]);
    g.value();
    expect(reports.map((e) => [e.kind, e.time])).toEqual([["snapshot", t1]]);
    // The exact value is unknown until the snapshotted patch is loaded.
    expect(g.needsMoreHistory()).toBe(true);
    g.add([p0, p1]);
    expect(g.needsMoreHistory()).toBe(false);
    expect(g.value().toString()).toBe("x\ny\nz\n");
    expect(g.verifyValue(t1)).toBe("ok");
    expect(reports.length).toBe(1);
  });

  it("uses a snapshot that matches its patch's value", () => {
    const reports: Inconsistency[] = [];
    const g = new PatchGraph({ codec: exactCodec, onInconsistency: (e) => reports.push(e) });
    const [t1, t2] = [2, 3].map(legacyPatchId);
    g.add([
      { time: t1, parents: [], isSnapshot: true, snapshot: "x\ny\n", hash: hashString("x\ny\n") },
      { time: t2, parents: [t1], patch: doc("x\ny\n").makePatch(doc("x\ny\nz\n")) },
    ]);
    expect(g.value().toString()).toBe("x\ny\nz\n");
    expect(g.needsMoreHistory()).toBe(false);
    expect(reports).toEqual([]);
  });

  it("does not compare hashes of an unknown format or values that are not exact", () => {
    const reports: Inconsistency[] = [];
    const [t0] = [1].map(legacyPatchId);
    const patch = { time: t0, parents: [], patch: doc("").makePatch(doc("x\n")) };
    const g = new PatchGraph({ codec: exactCodec, onInconsistency: (e) => reports.push(e) });
    g.add([{ ...patch, hash: "s9:whatever" }]);
    expect(g.value().toString()).toBe("x\n");
    expect(g.verifyValue(t0)).toBe("unknown");
    // Without merge3 values are not exact: nothing is hashed or checked.
    const legacy = new PatchGraph({ codec: StringCodec, onInconsistency: (e) => reports.push(e) });
    legacy.add([{ ...patch, hash: hashString("not x") }]);
    expect(legacy.value().toString()).toBe("x\n");
    expect(legacy.verifyValue(t0)).toBe("unknown");
    expect(reports).toEqual([]);
  });

  it("records exactly the committed value after an undo", async () => {
    // Undo hides a patch that is still a parent of the next commit; the
    // commit's patch must be made against the value with that patch, or the
    // history records something else (the undone line came back).
    const store = new MemoryPatchStore();
    const reports: Inconsistency[] = [];
    const a = await session(store, "A", reports);
    a.commit(doc("a\n"));
    a.commit(doc("a\nb\n"));
    expect(a.undo().toString()).toBe("a\n");
    const env = a.commit(doc("a\nc\n"));
    expect(env.hash).toBe(hashString("a\nc\n"));
    expect(a.value().toString()).toBe("a\nc\n");
    const fresh = await session(new MemoryPatchStore((store as any).patches), "B", reports);
    expect(fresh.getDocument().toString()).toBe("a\nc\n");
    expect(fresh.verifyValue(env.time)).toBe("ok");
    expect(reports).toEqual([]);
  });
  it("never uses a rejected snapshot, and refuses commits until the value is known", async () => {
    const t1 = legacyPatchId(1);
    const good = {
      time: t1,
      parents: [],
      patch: doc("").makePatch(doc("GOOD\n")),
      hash: hashString("GOOD\n"),
    };
    const store = new MemoryPatchStore([
      { time: t1, parents: [], isSnapshot: true, snapshot: "BAD\n", hash: hashString("GOOD\n") },
    ]);
    const reports: Inconsistency[] = [];
    const s = await session(store, "late", reports);
    expect(reports.map((e) => e.kind)).toEqual(["snapshot"]);
    // Neither the exact value nor the fallback uses the rejected text.
    expect(s.value().toString()).not.toContain("BAD");
    expect(s.getDocument().toString()).not.toContain("BAD");
    expect(s.isValueAvailable()).toBe(false);
    expect(s.needsMoreHistory()).toBe(true);
    expect(() => s.commit(doc("BAD\nedit\n"))).toThrow(/load more history/);
    expect(s.versions()).toEqual([t1]);
    // The patch the snapshot is of arrives (more history): the value is known.
    let changes = 0;
    s.on("change", () => changes++);
    s.applyRemoteBatch([good]);
    expect(changes).toBe(1);
    expect(s.isValueAvailable()).toBe(true);
    expect(s.needsMoreHistory()).toBe(false);
    expect(s.getDocument().toString()).toBe("GOOD\n");
    const env = s.commit(doc("GOOD\nedit\n"));
    expect(env.hash).toBe(hashString("GOOD\nedit\n"));
    expect(reports.length).toBe(1);
  });

  it("checks a value computed earlier as an intermediate one when it is requested", () => {
    const reports: Inconsistency[] = [];
    const g = new PatchGraph({ codec: exactCodec, onInconsistency: (e) => reports.push(e) });
    const [t1, t2] = [1, 2].map(legacyPatchId);
    g.add([
      { time: t1, parents: [], patch: doc("").makePatch(doc("a\n")), hash: hashString("WRONG") },
      {
        time: t2,
        parents: [t1],
        patch: doc("a\n").makePatch(doc("a\nb\n")),
        hash: hashString("a\nb\n"),
      },
    ]);
    // Reading the head computes t1's value as an intermediate one (unchecked).
    expect(g.value().toString()).toBe("a\nb\n");
    expect(reports).toEqual([]);
    // Reading t1 itself (e.g. in TimeTravel) checks it.
    expect(g.value({ time: t1 }).toString()).toBe("a\n");
    expect(reports.map((e) => [e.kind, e.time])).toEqual([["patch", t1]]);
    g.value({ time: t1 });
    expect(reports.length).toBe(1);
  });

  describe("recovering from a rejected snapshot of a patch with ancestors", () => {
    // root: "base\n"; child: "base\nsecond\n"; the snapshot of child is bad.
    const [t1, t2] = [1, 2].map(legacyPatchId);
    const root = {
      time: t1,
      parents: [],
      patch: doc("").makePatch(doc("base\n")),
      hash: hashString("base\n"),
    };
    const child = {
      time: t2,
      parents: [t1],
      patch: doc("base\n").makePatch(doc("base\nsecond\n")),
      hash: hashString("base\nsecond\n"),
    };
    const badSnapshot = {
      time: t2,
      parents: [],
      isSnapshot: true,
      snapshot: "BAD\n",
      hash: hashString("base\nsecond\n"),
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    it("refuses commits until the snapshot's patch and all its ancestors are loaded", async () => {
      const s = await session(new MemoryPatchStore([badSnapshot]), "c", []);
      expect(s.isValueAvailable()).toBe(false);
      // Review of #13: the patch alone made the value look available.
      s.applyRemoteBatch([child]);
      expect(s.isValueAvailable()).toBe(false);
      expect(s.needsMoreHistory()).toBe(true);
      expect(() => s.commit(doc("edit\n"))).toThrow(/load more history/);
      s.applyRemoteBatch([root]);
      expect(s.isValueAvailable()).toBe(true);
      expect(s.getDocument().toString()).toBe("base\nsecond\n");
      const env = s.commit(doc("base\nsecond\nedit\n"));
      expect(env.hash).toBe(hashString("base\nsecond\nedit\n"));
      s.close();
    });

    it("never writes an unavailable value to the file", async () => {
      // Review of #13: loading only the root wrote "base\n" over the file.
      const file = new MemoryFileAdapter("base\nsecond\n");
      const s = new Session({
        codec: exactCodec,
        patchStore: new MemoryPatchStore([badSnapshot]),
        clientId: "f",
        fileAdapter: file,
      });
      await s.init();
      s.applyRemoteBatch([root]);
      await settle();
      expect(s.isValueAvailable()).toBe(false);
      expect(await file.read()).toBe("base\nsecond\n");
      s.applyRemoteBatch([child]);
      await settle();
      expect(s.isValueAvailable()).toBe(true);
      expect(await file.read()).toBe("base\nsecond\n");
      // Writes resume once the value is known.
      s.commit(doc("base\nsecond\nthird\n"));
      await settle();
      expect(await file.read()).toBe("base\nsecond\nthird\n");
      s.close();
    });

    it("ingests an external edit of the file made while the value was unavailable", async () => {
      const file = new MemoryFileAdapter("base\nsecond\n");
      const s = new Session({
        codec: exactCodec,
        patchStore: new MemoryPatchStore([badSnapshot]),
        clientId: "e",
        fileAdapter: file,
      });
      await s.init();
      await file.write("base\nsecond\nexternal\n");
      await settle();
      expect(s.isValueAvailable()).toBe(false);
      s.applyRemoteBatch([root, child]);
      await settle();
      expect(s.isValueAvailable()).toBe(true);
      expect(s.getDocument().toString()).toBe("base\nsecond\nexternal\n");
      expect(await file.read()).toBe("base\nsecond\nexternal\n");
      s.close();
    });
  });
});
