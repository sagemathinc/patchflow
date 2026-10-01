import { PatchGraph } from "./patch-graph";
import { Session } from "./session";
import { legacyPatchId } from "./patch-id";
import { mergeStrings3 } from "./merge3";
import { StringDocument } from "./string-document";
import { createDbCodec } from "./db-document-immutable";
import type { DocCodec, Document, Patch } from "./types";

const exactCodec: DocCodec = {
  fromString: (s) => new StringDocument(s),
  toString: (d) => d.toString(),
  applyPatch: (d, p) => d.applyPatch(p),
  applyPatchBatch: (d, ps) => d.applyPatchBatch(ps),
  makePatch: (a, b) => a.makePatch(b),
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
const { merge3: _unused, ...legacyCodec } = exactCodec;
void _unused;

const doc = (s: string) => new StringDocument(s);
const patch = (time: string, parents: string[], from: string, to: string): Patch => ({
  time,
  parents,
  patch: doc(from).makePatch(doc(to)),
  userId: 0,
});

describe("PatchGraph exact values (codec with merge3)", () => {
  it("does not apply a concurrent deletion to similar text elsewhere", () => {
    const base =
      "intro\n\n- - tke1q nested\n- tke2q flat\n\nmiddle\n\n- - tke10q nested\n- tke11q flat\n";
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const patches = [
      patch(t0, [], "", base),
      patch(t1, [t0], base, base.replace("- - tke1q", "- tke1q")), // un-nest a line
      patch(t2, [t0], base, base.replace("tke1q", "")), // concurrently delete its token
    ];
    const exact = new PatchGraph({ codec: exactCodec });
    exact.add(patches);
    expect(exact.value().toString()).toContain("tke10q");
    // The legacy algorithm shows the problem this fixes.
    const legacy = new PatchGraph({ codec: legacyCodec });
    legacy.add(patches);
    expect(legacy.value().toString()).not.toContain("tke10q");
  });

  it("computes linear history exactly as before", () => {
    const texts = ["", "a\n", "a\nb\n", "a\nB\n", "x\na\nB\n"];
    const times = texts.map((_, i) => legacyPatchId(i + 1));
    const patches = texts
      .slice(1)
      .map((to, i) => patch(times[i + 1], i === 0 ? [] : [times[i]], texts[i], to));
    const exact = new PatchGraph({ codec: exactCodec });
    const legacy = new PatchGraph({ codec: legacyCodec });
    exact.add(patches);
    legacy.add(patches);
    for (const p of patches) {
      expect(exact.version(p.time).toString()).toBe(legacy.version(p.time).toString());
    }
    expect(exact.value().toString()).toBe("x\na\nB\n");
  });

  it("gives the exact value each client saw at a patch", () => {
    const [t0, t1, t2, t3] = [1, 2, 3, 4].map(legacyPatchId);
    const exact = new PatchGraph({ codec: exactCodec });
    exact.add([
      patch(t0, [], "", "a\nb\n"),
      patch(t1, [t0], "a\nb\n", "A\nb\n"),
      patch(t2, [t0], "a\nb\n", "a\nB\n"),
    ]);
    const merged = exact.value().toString();
    expect(merged).toBe("A\nB\n");
    exact.add([patch(t3, [t1, t2], merged, `${merged}c\n`)]);
    expect(exact.version(t2).toString()).toBe("a\nB\n");
    expect(exact.value().toString()).toBe("A\nB\nc\n");
  });

  it("does not depend on the order patches are added", () => {
    const [t0, t1, t2, t3] = [1, 2, 3, 4].map(legacyPatchId);
    const patches = [
      patch(t0, [], "", "one\ntwo\nthree\n"),
      patch(t1, [t0], "one\ntwo\nthree\n", "one\n2\nthree\n"),
      patch(t2, [t0], "one\ntwo\nthree\n", "one\ntwo\nthree\nfour\n"),
      patch(t3, [t0], "one\ntwo\nthree\n", "zero\none\ntwo\nthree\n"),
    ];
    const values = new Set<string>();
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 0, 3, 2],
      [2, 3, 0, 1],
    ]) {
      const g = new PatchGraph({ codec: exactCodec });
      for (const i of order) {
        g.add([patches[i]]);
        g.value(); // compute (and cache) intermediate values
      }
      values.add(g.value().toString());
    }
    expect([...values]).toEqual(["zero\none\n2\nthree\nfour\n"]);
  });

  it("applies identical concurrent file loads once", () => {
    const [t0, t1] = [1, 2].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([
      { ...patch(t0, [], "", "file contents\n"), file: true },
      { ...patch(t1, [], "", "file contents\n"), file: true },
    ]);
    expect(g.value().toString()).toBe("file contents\n");
  });

  it("merges correctly when a patch is older than its parent (clock skew)", () => {
    const [t1, t2, t3, t4] = [1, 2, 3, 4].map(legacyPatchId);
    const base = "one\ntwo\nthree\n";
    const left = "ONE\ntwo\nthree\n";
    const right = "one\ntwo\nTHREE\n";
    const g = new PatchGraph({ codec: exactCodec });
    g.add([
      patch(t3, [], "", base),
      patch(t1, [t3], base, left), // made on a skewed clock: older than its parent
      patch(t4, [t3], base, right),
      patch(t2, [t1], left, left + "four\n"),
    ]);
    expect(g.value().toString()).toBe("ONE\ntwo\nTHREE\nfour\n");
  });

  it("holds back a patch whose parent has not arrived yet", () => {
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([patch(t0, [], "", "a\n"), patch(t2, [t1], "a\nb\n", "a\nb\nc\n")]);
    // t2 was made on top of t1, which is still in flight.
    expect(g.getValueHeads()).toEqual([t0]);
    expect(g.value().toString()).toBe("a\n");
    g.add([patch(t1, [t0], "a\n", "a\nb\n")]);
    expect(g.getValueHeads()).toEqual([t2]);
    expect(g.value().toString()).toBe("a\nb\nc\n");
  });

  it("does not hold back patches whose parents are below the loaded history", () => {
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const g = new PatchGraph({ codec: legacyCodec });
    g.add([patch(t1, [t0], "a\n", "a\nb\n"), patch(t2, [t1], "a\nb\n", "a\nb\nc\n")]);
    expect(g.getValueHeads()).toEqual([t2]);
    const exact = new PatchGraph({ codec: exactCodec });
    exact.add([patch(t1, [t0], "a\n", "a\nb\n"), patch(t2, [t1], "a\nb\n", "a\nb\nc\n")]);
    expect(exact.getValueHeads()).toEqual([t2]);
  });

  it("undoes a local edit exactly after an earlier concurrent merge", async () => {
    // Review of #2: undo used to recompute all history with fuzzy replay.
    const store = {
      loadInitial: async () => ({ patches: [] }),
      append: () => {},
      subscribe: () => () => {},
    };
    const a = new Session({
      codec: exactCodec,
      patchStore: store,
      clientId: "a",
      clock: () => 100,
    });
    const b = new Session({
      codec: exactCodec,
      patchStore: store,
      clientId: "b",
      clock: () => 100,
    });
    await a.init();
    await b.init();
    const root = a.commit(doc("the cat sat\n"));
    b.applyRemote(root);
    const left = a.commit(doc("the dog sat\n"));
    const right = b.commit(doc("the cow sat\n"));
    a.applyRemote(right);
    b.applyRemote(left);
    const before = a.getDocument().toString();
    expect(before).toBe("the cow dog sat\n");
    a.commit(doc(before + "tail\n"));
    expect(a.undo().toString()).toBe(before);
    expect(a.redo().toString()).toBe(before + "tail\n");
    a.close();
    b.close();
  });

  it("does not let a partial backfill below a snapshot roll the value back", () => {
    // Review of #2: waiting propagated through a self-contained snapshot.
    const [r, p, q, s, t] = [1, 2, 3, 4, 5].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    const text = "root\np\nq\nsnapshot\n";
    g.add([
      patch(r, [], "", "root\n"),
      { time: s, parents: [q], isSnapshot: true, snapshot: text, userId: 0 } as Patch,
      patch(t, [s], text, text + "after\n"),
    ]);
    expect(g.value().toString()).toBe(text + "after\n");
    g.add([patch(q, [p], "root\np\n", "root\np\nq\n")]);
    expect(g.value().toString()).toBe(text + "after\n");
    expect(g.version(s).toString()).toBe(text);
  });

  it("bounds the cache of merged values", () => {
    // Review of #2: merged values were cached without a bound.
    const g = new PatchGraph({ codec: exactCodec, exactCacheMaxEntries: 2 });
    let time = 0;
    const add = (parents: string[], from: string, to: string) => {
      const t = legacyPatchId(++time);
      g.add([patch(t, parents, from, to)]);
      return t;
    };
    let root = add([], "", "root\n");
    let base = "root\n";
    for (let i = 0; i < 100; i++) {
      const a = add([root], base, base + `a${i}\n`);
      const b = add([root], base, base + `b${i}\n`);
      base = g.value().toString();
      root = add([a, b], base, base);
      g.value();
    }
    expect((g as any).exactMergeCache.size).toBeLessThanOrEqual(2);
    expect(base.split("\n").length).toBe(202);
  });

  // A history with bursts of concurrent edits, as [patch, value after it].
  const randomHistory = (n: number, big = "") => {
    let seed = 3;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const g = new PatchGraph({ codec: exactCodec });
    const patches: Patch[] = [];
    let time = 0;
    const add = (parents: string[], from: string, to: string) => {
      const p = patch(legacyPatchId(++time), parents, from, to);
      g.add([p]);
      patches.push(p);
    };
    add([], "", big + "start\n");
    while (time < n) {
      const heads = g.getHeads();
      const base = g.value().toString();
      const burst = rng() < 0.3 ? 2 : 1;
      for (let i = 0; i < burst; i++) add(heads, base, base + `line ${time} ${i}\n`);
    }
    return patches;
  };

  it("gives the same values with a tiny size bound on the exact cache", () => {
    const patches = randomHistory(300);
    const full = new PatchGraph({ codec: exactCodec });
    full.add(patches);
    const tiny = new PatchGraph({ codec: exactCodec, exactCacheMaxSize: 50 });
    tiny.add(patches);
    expect(tiny.value().toString()).toBe(full.value().toString());
    for (const p of patches.filter((_, i) => i % 37 === 0)) {
      expect(tiny.version(p.time).toString()).toBe(full.version(p.time).toString());
    }
    expect((tiny as any).exactCache.calculatedSize).toBeLessThanOrEqual(50);
  });

  it("updates a document larger than the cache bound incrementally", () => {
    const big = "x".repeat(1000) + "\n";
    const patches = randomHistory(200, big);
    let applied = 0;
    const counting: DocCodec = {
      ...exactCodec,
      applyPatch: (d, p) => {
        applied++;
        return d.applyPatch(p);
      },
    };
    const g = new PatchGraph({ codec: counting, exactCacheMaxSize: 100 });
    g.add(patches);
    let value = g.value().toString();
    applied = 0;
    for (let i = 0; i < 20; i++) {
      const t = legacyPatchId(10_000 + i);
      g.add([patch(t, g.getHeads(), value, value + `more ${i}\n`)]);
      value = g.value().toString();
    }
    // One patch application per edit, not a replay of the whole history.
    expect(applied).toBe(20);
    expect(value).toContain("more 19");
  });

  it("keeps heads and held-back patches right as patches arrive in any order", () => {
    let seed = 11;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 40; run++) {
      // A random DAG: each patch has one or two earlier parents.
      const n = 30;
      const times = Array.from({ length: n }, (_, i) => legacyPatchId(i + 1));
      const all: Patch[] = times.map((time, i) => {
        const parents =
          i === 0
            ? []
            : Array.from(
                new Set(
                  Array.from({ length: rng() < 0.3 ? 2 : 1 }, () => times[Math.floor(rng() * i)]),
                ),
              );
        const p: Patch = { time, parents, patch: doc("").makePatch(doc(`${i}\n`)), userId: 0 };
        if (i > 0 && rng() < 0.1) {
          p.isSnapshot = true;
          p.snapshot = `snap ${i}\n`;
        }
        return p;
      });
      // Mostly in order, with some late (out of order) arrivals and batches.
      const pending = all.slice();
      const g = new PatchGraph({ codec: exactCodec });
      while (pending.length > 0) {
        const k = rng() < 0.2 ? Math.floor(rng() * pending.length) : 0;
        const batch = pending.splice(k, rng() < 0.2 ? 3 : 1);
        g.add(batch);
        g.value(); // exercise (and populate) the caches
        const fresh = new PatchGraph({ codec: exactCodec });
        fresh.add(all.filter((p) => (g as any).patches.has(p.time)));
        expect(g.getHeads()).toEqual(fresh.getHeads());
        expect(g.getValueHeads()).toEqual(fresh.getValueHeads());
      }
    }
  });

  // Review of #6.
  it("recognizes clean cuts after a snapshot, with older history loaded", () => {
    const [t1, t2, t3, t4, t5] = [1, 2, 3, 4, 5].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([
      patch(t1, [], "", "one\n"),
      { ...patch(t2, [t1], "one\n", "one\ntwo\n"), isSnapshot: true, snapshot: "one\ntwo\n" },
      patch(t3, [t2], "one\ntwo\n", "one\ntwo\nthree\n"),
    ]);
    expect([t1, t2, t3].map((t) => g.isCut(t))).toEqual([true, true, true]);
    // Two concurrent patches: neither is a cut.
    g.add([
      patch(t4, [t3], "one\ntwo\nthree\n", "one\ntwo\nthree\nfour\n"),
      patch(t5, [t3], "one\ntwo\nthree\n", "zero\none\ntwo\nthree\n"),
    ]);
    expect([t3, t4, t5].map((t) => g.isCut(t))).toEqual([true, false, false]);
  });

  it("keeps the parents of a snapshotted patch loaded after its snapshot record", () => {
    // t1 and t2 are concurrent edits of t0, t3 builds on t1 and is snapshotted,
    // t4 merges t3 with t2 from their common ancestor t0. A client that opened
    // the document from the snapshot (a record with the value but no parents)
    // and then loaded older history must merge from t0, not an empty base.
    const [t0, t1, t2, t3, t4] = [1, 2, 3, 4, 5].map(legacyPatchId);
    const v0 = "a\nb\nc\n";
    const v1 = "A\nb\nc\n";
    const v2 = "a\nb\nC\n";
    const v3 = "A\nB\nc\n";
    const patches = [
      patch(t0, [], "", v0),
      patch(t1, [t0], v0, v1),
      patch(t2, [t0], v0, v2),
      patch(t3, [t1], v1, v3),
      patch(t4, [t3, t2], "A\nB\nC\n", "A\nB\nC\nd\n"),
    ];
    const full = new PatchGraph({ codec: exactCodec });
    full.add(patches);
    expect(full.value().toString()).toBe("A\nB\nC\nd\n");

    const late = new PatchGraph({ codec: exactCodec });
    late.add([{ time: t3, parents: [], isSnapshot: true, snapshot: v3, userId: 0 }, patches[4]]);
    expect(late.needsMoreHistory()).toBe(true);
    late.add(patches.slice(0, 4)); // older history, including t3 itself
    expect(late.needsMoreHistory()).toBe(false);
    expect(late.value().toString()).toBe("A\nB\nC\nd\n");
    expect(late.getParents(t3)).toEqual([t1]);
  });

  it("needs no more history for a gap covered by the current snapshot", () => {
    const [t1, t2, t3, t4] = [1, 2, 3, 4].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([
      patch(t1, [], "", "one\n"),
      patch(t3, [t2], "two\n", "two\nthree\n"), // t2 is missing
      { time: t4, parents: [t1, t3], isSnapshot: true, snapshot: "one\ntwo\nthree\n", userId: 0 },
    ]);
    expect(g.value().toString()).toBe("one\ntwo\nthree\n");
    expect(g.needsMoreHistory()).toBe(false);
  });

  it("still needs more history for a waiting head the value does not include", () => {
    const [t1, t2, t3] = [1, 2, 3].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([patch(t1, [], "", "one\n"), patch(t3, [t2], "one\ntwo\n", "one\ntwo\nthree\n")]);
    expect(g.needsMoreHistory()).toBe(true);
  });

  it("does not remerge unchanged concurrent heads larger than the cache bound", () => {
    let merges = 0;
    const counting: DocCodec = {
      ...exactCodec,
      merge3: (...args) => {
        merges++;
        return exactCodec.merge3!(...args);
      },
    };
    const text = "x".repeat(1000) + "\n";
    const [t1, t2, t3] = [1, 2, 3].map(legacyPatchId);
    const g = new PatchGraph({ codec: counting, exactCacheMaxSize: 100 });
    g.add([
      patch(t1, [], "", text),
      patch(t2, [t1], text, text + "left\n"),
      patch(t3, [t1], text, text + "right\n"),
    ]);
    const value = g.value().toString();
    merges = 0;
    for (let i = 0; i < 20; i++) expect(g.value().toString()).toBe(value);
    expect(g.needsMoreHistory()).toBe(false);
    expect(merges).toBe(0);
  });

  // Several clients that each commit on top of the heads they have seen and
  // now and then catch up: a criss-cross history like a busy meeting's.
  const wideHistory = (clients: number, n: number) => {
    let seed = 7;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const g = new PatchGraph({ codec: exactCodec });
    const patches: Patch[] = [];
    let time = 0;
    const t0 = legacyPatchId(++time);
    patches.push(patch(t0, [], "", "start\n"));
    g.add(patches);
    const seen: string[][] = Array.from({ length: clients }, () => [t0]);
    while (time < n) {
      const c = Math.floor(rng() * clients);
      const base = parentsValue(g, seen[c]);
      const p = patch(legacyPatchId(++time), seen[c], base, base + `c${c} ${time}\n`);
      g.add([p]);
      patches.push(p);
      seen[c] = [p.time];
      if (rng() < 0.4) seen[Math.floor(rng() * clients)] = g.getHeads();
    }
    return patches;
  };

  it("merges a wide criss-cross history incrementally with a tiny cache", () => {
    // A 30 minute, 10 user notebook stalled: merging needed more values than
    // the cache held, and each evicted one was recomputed by repeating the
    // merge recursion below it, exponentially often.
    const patches = wideHistory(10, 150);
    const full = new PatchGraph({ codec: exactCodec });
    full.add(patches);
    // Each value takes well under 1000 merges (about 150); before the fix
    // they grew without bound.
    let merges = 0;
    const counting: DocCodec = {
      ...exactCodec,
      merge3: (...args) => {
        if (++merges > 1000) throw new Error("too many merges for one value");
        return exactCodec.merge3!(...args);
      },
    };
    const tiny = new PatchGraph({ codec: counting, exactCacheMaxEntries: 4 });
    for (const p of patches) {
      merges = 0;
      tiny.add([p]);
      tiny.value();
    }
    expect(tiny.value().toString()).toBe(full.value().toString());
  });

  it("caches as many database document values as records allow", () => {
    // doc.size() estimates a database document's JSONL text, about a thousand
    // per record; cached versions share their records, so the cache counts
    // records instead and keeps enough values for merging.
    const codec = {
      ...createDbCodec({ primaryKeys: ["id"] }),
      merge3: (_b: Document, a: Document) => a,
    };
    const rows = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: i, x: 0 })).join("\n");
    const g = new PatchGraph({ codec });
    let value = codec.fromString(rows);
    let prev = legacyPatchId(1);
    g.add([
      { time: prev, parents: [], patch: codec.makePatch(codec.fromString(""), value), userId: 0 },
    ]);
    for (let i = 2; i <= 101; i++) {
      const next = codec.fromString(rows.replace(`{"id":${i},"x":0}`, `{"id":${i},"x":1}`));
      const t = legacyPatchId(i);
      g.add([{ time: t, parents: [prev], patch: codec.makePatch(value, next), userId: 0 }]);
      g.version(t);
      [value, prev] = [next, t];
    }
    expect((g as any).exactCache.size).toBeGreaterThan(90);
  });

  it("falls back when a parent below a patch is missing", () => {
    const [t0, t1] = [1, 2].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([patch(t1, [t0], "a\n", "a\nb\n")]);
    expect(() => g.value()).not.toThrow();
  });

  it("loses and duplicates nothing under random concurrent inserts and deletes", () => {
    let seed = 1;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const runs = Number(process.env.PF_RUNS ?? 30);
    const steps = Number(process.env.PF_STEPS ?? 12);
    for (let run = 0; run < runs; run++) {
      const g = new PatchGraph({ codec: exactCodec });
      let time = 1;
      const t0 = legacyPatchId(time++);
      const initial =
        Array.from({ length: 6 }, (_, i) => `line ${i} tok${run}x${i}q`).join("\n") + "\n";
      g.add([patch(t0, [], "", initial)]);
      const inserted = new Set<string>(initial.match(/tok\d+x\d+q/g)!);
      const deleted = new Set<string>();
      // Three clients each make edits on top of the heads they have seen.
      const seen: string[][] = [[t0], [t0], [t0]];
      for (let step = 0; step < steps; step++) {
        const c = Math.floor(rng() * 3);
        const parents = seen[c];
        const base = parentsValue(g, parents);
        const lines = base.split("\n").filter((l) => l !== "");
        let next: string;
        if (rng() < 0.6 || lines.length === 0) {
          const tok = `tok${run}n${step}q`;
          inserted.add(tok);
          lines.splice(Math.floor(rng() * (lines.length + 1)), 0, `new ${tok}`);
          next = lines.join("\n") + "\n";
        } else {
          const i = Math.floor(rng() * lines.length);
          for (const tok of lines[i].match(/tok\d+[xn]\d+q/g) ?? []) deleted.add(tok);
          lines.splice(i, 1);
          next = lines.join("\n") + "\n";
        }
        const t = legacyPatchId(time++);
        g.add([patch(t, parents, base, next)]);
        seen[c] = [t];
        // Sometimes a client catches up with everything.
        if (rng() < 0.3) seen[Math.floor(rng() * 3)] = g.getHeads();
      }
      const final = g.value().toString();
      for (const tok of inserted) {
        const count = final.split(tok).length - 1;
        if ((count !== 1 && !deleted.has(tok)) || count > 1) {
          if (process.env.PF_DEBUG) {
            const orig = (exactCodec as any).merge3;
            const calls: any[] = [];
            (exactCodec as any).merge3 = (base: any, a: any, b: any, ancestors: any) => {
              const out = orig(base, a, b, ancestors);
              calls.push({
                ancestors: ancestors?.map(String),
                base: base.toString(),
                a: a.toString(),
                b: b.toString(),
                out: out.toString(),
              });
              return out;
            };
            (g as any).clearExactCaches();
            g.value();
            (exactCodec as any).merge3 = orig;
            const n = (text: string) => text.split(tok).length - 1;
            const bad = calls.find(
              (c) =>
                n(c.out) > Math.max(n(c.a), n(c.b)) ||
                ((c.a.includes(tok) || c.b.includes(tok)) &&
                  !c.base.includes(tok) &&
                  !c.out.includes(tok)),
            );
            // eslint-disable-next-line no-console
            console.log(
              `run ${run} token ${tok} count ${count}\n${JSON.stringify(bad ?? calls, null, 1)}`,
            );
          }
        }
        expect(count).toBeLessThanOrEqual(1);
        if (!deleted.has(tok)) expect(count).toBe(1);
      }
    }
  });
});

function parentsValue(g: PatchGraph, parents: string[]): string {
  // The value a client committing on top of `parents` started from.
  const heads = parents;
  return (heads.length === 1 ? g.version(heads[0]) : mergedValue(g, heads)).toString();
}

function mergedValue(g: PatchGraph, heads: string[]): Document {
  // Merged value of a set of heads, as the graph computes it for those heads.
  return (g as any).exactValueOfSet(heads);
}
