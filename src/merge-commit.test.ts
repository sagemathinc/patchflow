import { PatchGraph, type PatchGraphOptions } from "./patch-graph";
import { Session } from "./session";
import { MemoryPatchStore } from "./adapters/memory-patch-store";
import { mergeStrings3 } from "./merge3";
import { StringCodec, StringDocument } from "./string-document";
import { legacyPatchId } from "./patch-id";
import { hashString } from "./value-hash";
import type { DocCodec, Inconsistency, Patch, PatchEnvelope } from "./types";

const doc = (s: string) => new StringDocument(s);

// The current merge, and a different one, as a later version might merge.
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
const otherCodec: DocCodec = {
  ...(StringCodec as any),
  merge3: (_base, a, b) => doc(`${b}${a}`),
};
// No merge3: how versions before exact merges computed values, applying every
// patch in time order.
const applyAllCodec = StringCodec as unknown as DocCodec;

function graph(
  c: DocCodec,
  patches: Patch[],
  inconsistencies: Inconsistency[] = [],
  opts: Partial<PatchGraphOptions> = {},
) {
  const g = new PatchGraph({
    codec: c,
    onInconsistency: (x) => inconsistencies.push(x),
    ...opts,
  });
  g.add(patches);
  return g;
}

// Writers that exchange patches only when told to.
async function writers(c: DocCodec, n: number) {
  let now = 1000;
  const clock = () => now++;
  const sessions: Session[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Session({
      codec: c,
      patchStore: new MemoryPatchStore(),
      clock,
      clientId: `c${i}`,
      userId: i,
    });
    await s.init();
    sessions.push(s);
  }
  return sessions;
}

const strip = ({ mergeParent: _p, mergePatch: _m, ...rest }: PatchEnvelope): Patch => rest;

// A patch as patchflow 0.8 wrote it: no inexact marker.
const as08 = ({ inexact: _inexact, ...rest }: PatchEnvelope): PatchEnvelope => rest;

describe("merge commits record their merged value", () => {
  async function history() {
    const [a, b] = await writers(codec, 2);
    const e0 = a.commit(doc("one two three\n"));
    b.applyRemote(e0);
    const ea = a.commit(doc("one TWO three\n"));
    const eb = b.commit(doc("one two three four\n"));
    a.applyRemote(eb);
    b.applyRemote(ea);
    expect(a.getDocument().toString()).toBe("one TWO three four\n");
    const merge = a.commit(doc("one TWO three four\nfive\n"));
    return { patches: [e0, ea, eb, merge], merge };
  }

  it("as a diff from one of its parents", async () => {
    const { patches, merge } = await history();
    expect(merge.parents).toHaveLength(2);
    expect(merge.parents).toContain(merge.mergeParent);
    expect(merge.mergePatch).toBeDefined();
    for (const p of patches.slice(0, 3)) {
      expect(p.mergeParent).toBeUndefined();
      expect(p.mergePatch).toBeUndefined();
    }
  });

  it("so a different merge algorithm does not change the value of the history", async () => {
    const { patches, merge } = await history();
    const inconsistencies: Inconsistency[] = [];
    const g = graph(otherCodec, patches, inconsistencies);
    expect(g.version(merge.time).toString()).toBe("one TWO three four\nfive\n");
    expect(g.verifyValue(merge.time)).toBe("ok");
    expect(inconsistencies).toEqual([]);
    // Without the recorded merged value it would (and the hash shows it).
    const h = graph(otherCodec, patches.map(strip), inconsistencies);
    expect(h.version(merge.time).toString()).not.toBe("one TWO three four\nfive\n");
    expect(h.verifyValue(merge.time)).toBe("mismatch");
  });

  it("and readers that do not know it read the patch as before", async () => {
    const { patches, merge } = await history();
    const inconsistencies: Inconsistency[] = [];
    const g = graph(codec, patches.map(strip), inconsistencies);
    expect(g.version(merge.time).toString()).toBe("one TWO three four\nfive\n");
    expect(inconsistencies).toEqual([]);
    // So does applying every patch in time order.
    expect(graph(applyAllCodec, patches).version(merge.time).toString()).toBe(
      "one TWO three four\nfive\n",
    );
  });

  it("needs only the parent it records the merged value from", async () => {
    const { patches, merge } = await history();
    const g = graph(otherCodec, patches);
    const spy = jest.spyOn(otherCodec, "merge3");
    expect(g.version(merge.time).toString()).toBe("one TWO three four\nfive\n");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("from random concurrent histories, whatever the merge algorithm", async () => {
    let seed = 7;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let merges = 0;
    for (let run = 0; run < 20; run++) {
      const sessions = await writers(codec, 3);
      const all: PatchEnvelope[] = [];
      const seen = sessions.map(() => 0);
      const values = new Map<string, string>();
      for (let step = 0; step < 15; step++) {
        const i = Math.floor(rng() * sessions.length);
        const s = sessions[i];
        // Catch up with some of what the others wrote.
        if (rng() < 0.5) {
          s.applyRemoteBatch(all.slice(seen[i]).filter((e) => !e.time.endsWith(`c${i}`)));
          seen[i] = all.length;
        }
        const words = s.getDocument().toString().split(" ").filter(Boolean);
        words.splice(Math.floor(rng() * (words.length + 1)), 0, `w${run}x${step}`);
        const env = s.commit(doc(words.join(" ")));
        values.set(env.time, words.join(" "));
        all.push(env);
        if ((env.parents?.length ?? 0) > 1) merges++;
      }
      for (const c of [codec, otherCodec]) {
        const inconsistencies: Inconsistency[] = [];
        const g = graph(c, all, inconsistencies);
        for (const [time, value] of values) expect(g.version(time).toString()).toBe(value);
        expect(inconsistencies).toEqual([]);
      }
    }
    expect(merges).toBeGreaterThan(20);
  });
});

describe("a history written before merge commits recorded their merged value", () => {
  // Written by versions that applied every patch in time order: no hashes,
  // merge commits are diffs from that value of their parents.
  async function legacyHistory(seed: number) {
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const sessions = await writers(applyAllCodec, 3);
    const all: PatchEnvelope[] = [];
    const seen = sessions.map(() => 0);
    const base = ["the", "cat", "sat", "on", "the", "mat"];
    for (let step = 0; step < 15; step++) {
      const i = Math.floor(rng() * sessions.length);
      const s = sessions[i];
      if (rng() < 0.5) {
        s.applyRemoteBatch(all.slice(seen[i]).filter((e) => !e.time.endsWith(`c${i}`)));
        seen[i] = all.length;
      }
      const words = all.length === 0 ? base.slice() : s.getDocument().toString().split(" ");
      // Concurrent edits of the same words, which merge differently.
      const k = Math.floor(rng() * words.length);
      words[k] = `${words[k]}${step}`;
      all.push(as08(s.commit(doc(words.join(" ")))));
    }
    return all;
  }

  it("keeps the values its authors saw, whatever the merge algorithm", async () => {
    let merges = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const all = await legacyHistory(seed);
      expect(all.every((p) => p.hash == null && p.mergeParent == null)).toBe(true);
      merges += all.filter((p) => (p.parents?.length ?? 0) > 1).length;
      const authored = graph(applyAllCodec, all);
      for (const c of [codec, otherCodec]) {
        const g = graph(c, all);
        for (const p of all) {
          expect(g.version(p.time).toString()).toBe(authored.version(p.time).toString());
        }
      }
    }
    expect(merges).toBeGreaterThan(20);
  });

  it("does not start from a snapshot made after a concurrent patch", () => {
    const id = legacyPatchId;
    const patch = (t: number, parents: number[], from: string, to: string): Patch => ({
      time: id(t),
      parents: parents.map(id),
      patch: doc(from).makePatch(doc(to)),
    });
    // 2 and 3 edit 1 concurrently, 4 builds on 2 and is snapshotted (without
    // 3), 5 merges 4 and 3.
    const ps = [
      patch(1, [], "", "a\nb\nc\n"),
      patch(2, [1], "a\nb\nc\n", "A\nb\nc\n"),
      patch(3, [1], "a\nb\nc\n", "a\nb\nC\n"),
      patch(4, [2], "A\nb\nc\n", "A\nB\nc\n"),
      patch(5, [4, 3], "A\nB\nC\n", "A\nB\nC\nd\n"),
    ];
    const snapshot: Patch = { ...ps[3], isSnapshot: true, snapshot: "A\nB\nc\n" };
    const g = graph(codec, [...ps.slice(0, 3), snapshot, ps[4]]);
    expect(g.version(id(5)).toString()).toBe("A\nB\nC\nd\n");
  });
});

describe("undo of a merge commit", () => {
  it("reverts its own changes from its recorded merged value", async () => {
    const [a, b] = await writers(codec, 2);
    const e0 = a.commit(doc("one two three\n"));
    b.applyRemote(e0);
    const ea = a.commit(doc("one TWO three\n"));
    const eb = b.commit(doc("one two three four\n"));
    a.applyRemote(eb);
    b.applyRemote(ea);
    const merge = a.commit(doc("one TWO three four\nfive\n"));
    const g = graph(codec, [e0, ea, eb, merge]);
    // Undo only the merge commit's own edit; the merge itself stays.
    expect(g.value({ withoutTimes: [merge.time] }).toString()).toBe("one TWO three four\n");
  });
});

describe("merge commits written before hashes", () => {
  it("each merge continues the previous replay", async () => {
    // Rounds of: fork the last merge, one line on each side, merge. Reading
    // every merge as it arrives applies each patch once, not the whole
    // history again for every merge.
    let now = 1000;
    const clock = () => now++;
    const make = async (id: string) => {
      const s = new Session({
        codec: applyAllCodec,
        patchStore: new MemoryPatchStore(),
        clock,
        clientId: id,
      });
      await s.init();
      return s;
    };
    const a = await make("a");
    const b = await make("b");
    const all: PatchEnvelope[] = [a.commit(doc("start\n"))];
    b.applyRemote(all[0]);
    const values = new Map<string, string>();
    const rounds = 150;
    for (let i = 0; i < rounds; i++) {
      const l = a.commit(doc(`${a.getDocument()}L${i}\n`));
      const r = b.commit(doc(`R${i}\n${b.getDocument()}`));
      a.applyRemote(r);
      const m = a.commit(doc(`${a.getDocument()}M${i}\n`));
      b.applyRemoteBatch([l, m]);
      all.push(...[l, r, m].map(as08));
      values.set(m.time, `${a.getDocument()}`);
    }
    expect(all.filter((p) => (p.parents?.length ?? 0) > 1 && p.hash == null)).toHaveLength(rounds);
    let applied = 0;
    const counting: DocCodec = {
      ...codec,
      applyPatch: (d, p) => {
        applied++;
        return d.applyPatch(p);
      },
      applyPatchBatch: (d, ps) => {
        applied += ps.length;
        return d.applyPatchBatch(ps);
      },
    };
    const g = new PatchGraph({ codec: counting });
    g.add([all[0]]);
    let checked = 0;
    for (let i = 1; i < all.length; i += 3) {
      const round = all.slice(i, i + 3);
      g.add(round);
      expect(g.value().toString()).toBe(values.get(round[2].time));
      checked++;
    }
    expect(checked).toBe(rounds);
    // Each patch is applied a bounded number of times (by the replay and by
    // the exact values of the branches), not once per later merge.
    expect(applied).toBeLessThan(4 * all.length);
  });
});

describe("a merge commit with a parent not yet received", () => {
  it("waits for it, although its merged value is recorded", async () => {
    // Patches are delivered with their ancestors (see types.ts): a patch is
    // held back until all its parents arrive, so every client has the same
    // history below the patches it shows.
    const [a, b] = await writers(codec, 2);
    const e0 = a.commit(doc("base\n"));
    b.applyRemote(e0);
    const ea = a.commit(doc("base\nleft\n"));
    const eb = b.commit(doc("base\nright\n"));
    a.applyRemote(eb);
    const merge = a.commit(doc(`${a.getDocument()}edit\n`));
    const other = merge.mergeParent === ea.time ? eb : ea;
    const rest = [e0, ea, eb].filter((p) => p !== other);
    const g = graph(codec, [...rest, merge]);
    expect(g.getValueHeads()).not.toContain(merge.time);
    expect(g.needsMoreHistory()).toBe(true);
    g.add([other]);
    expect(g.value().toString()).toBe(`${a.getDocument()}`);
  });
});

describe("replay checkpoints of a large document", () => {
  it("are bounded by size, and reading merge by merge still continues from the last", async () => {
    let now = 1000;
    const clock = () => now++;
    const make = async (id: string) => {
      const s = new Session({
        codec: applyAllCodec,
        patchStore: new MemoryPatchStore(),
        clock,
        clientId: id,
      });
      await s.init();
      return s;
    };
    const a = await make("a");
    const b = await make("b");
    const big = "x".repeat(99) + "\n";
    const all: PatchEnvelope[] = [a.commit(doc(big.repeat(2000)))]; // 200,000 characters
    b.applyRemote(all[0]);
    const values = new Map<string, string>();
    const rounds = 30;
    for (let i = 0; i < rounds; i++) {
      const l = a.commit(doc(`${a.getDocument()}L${i}\n`));
      const r = b.commit(doc(`R${i}\n${b.getDocument()}`));
      a.applyRemote(r);
      const m = a.commit(doc(`${a.getDocument()}M${i}\n`));
      b.applyRemoteBatch([l, m]);
      all.push(...[l, r, m].map(as08));
      values.set(m.time, `${a.getDocument()}`);
    }
    let applied = 0;
    const counting: DocCodec = {
      ...codec,
      applyPatch: (d, p) => {
        applied++;
        return d.applyPatch(p);
      },
      applyPatchBatch: (d, ps) => {
        applied += ps.length;
        return d.applyPatchBatch(ps);
      },
    };
    // Less room than one version of the document: only the newest checkpoint,
    // kept apart, lets the next merge continue.
    const maxSize = 150_000;
    const g = new PatchGraph({ codec: counting, exactCacheMaxSize: maxSize });
    g.add([all[0]]);
    for (let i = 1; i < all.length; i += 3) {
      const round = all.slice(i, i + 3);
      g.add(round);
      expect(g.value().toString()).toBe(values.get(round[2].time));
      let kept = 0;
      for (const { doc } of (g as any).legacyCheckpoints.values()) kept += doc.toString().length;
      expect(kept).toBeLessThanOrEqual(maxSize);
    }
    expect(applied).toBeLessThan(4 * all.length);
  });
});

describe("a merge commit made without the exact value of its parents", () => {
  const id = legacyPatchId;
  const patch = (t: number, parents: number[], from: string, to: string): Patch => ({
    time: id(t),
    parents: parents.map(id),
    patch: doc(from).makePatch(doc(to)),
    hash: hashString(to),
  });
  // 2 deletes a line that 3 edits concurrently; 4 merges them (the edit
  // wins) and is snapshotted; 5 edits a line that 6 deletes concurrently.
  const ps = [
    patch(1, [], "", "a\nb\nc\n"),
    patch(2, [1], "a\nb\nc\n", "a\nc\n"),
    patch(3, [1], "a\nb\nc\n", "a\nB\nc\n"),
    patch(4, [2, 3], "a\nB\nc\n", "a\nB\nc\nd\n"),
    patch(5, [4], "a\nB\nc\nd\n", "a\nB\nC!\nd\n"),
    patch(6, [3], "a\nB\nc\n", "a\nB\n"),
  ];
  const snapshot: Patch = { ...ps[3], isSnapshot: true, snapshot: "a\nB\nc\nd\n" };

  it("is marked inexact, and read with merge3", async () => {
    // A client with the snapshot, 5 and 6, but not 3 (below the snapshot):
    // it cannot compute the exact merge of 5 and 6.
    const s = new Session({
      codec,
      patchStore: new MemoryPatchStore([snapshot, ps[4], ps[5]]),
      clientId: "late",
    });
    await s.init();
    expect(s.getHeads()).toEqual([id(5), id(6)].sort());
    const merge = s.commit(doc(`${s.getDocument()}g\n`));
    s.close();
    expect(merge.parents).toHaveLength(2);
    expect(merge.hash).toBeUndefined();
    expect(merge.mergeParent).toBeUndefined();
    expect(merge.inexact).toBe(true);
    // Read with merge3, like any merge commit of this version, not by
    // replaying the history in time order (which depends on the history a
    // client has loaded, and here differs).
    const full = graph(codec, [...ps, snapshot, merge]);
    const value = full.version(merge.time).toString();
    const merged = full.exactValueOf(merge.parents!)!;
    expect(value).toBe(codec.applyPatch(merged, merge.patch).toString());
    const legacy = graph(codec, [...ps, snapshot, { ...merge, inexact: undefined }]);
    expect(legacy.version(merge.time).toString()).not.toBe(value);
  });
});
