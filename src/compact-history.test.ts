import { describe, expect, it } from "vitest";
import { compactHistory, encodedSize, selectVersions, squashedInfo } from "./compact-history";
import type { CompactionPolicy } from "./compact-history";
import { createDbCodec } from "./db-document-immutable";
import { mergeStrings3 } from "./merge3";
import { PatchGraph } from "./patch-graph";
import { encodePatchId, type PatchId } from "./patch-id";
import { StringDocument } from "./string-document";
import type { DocCodec, Document, Patch } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// a day boundary (intervals are aligned to the epoch)
const T0 = 19_675 * DAY;

const stringCodec: DocCodec = {
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

// A db codec with a simple record-level three-way merge (the later side wins
// a record both sides changed).
const plainDb = createDbCodec({ primaryKeys: ["id"] });
const records = (d: Document): Map<string, string> => {
  const m = new Map<string, string>();
  for (const line of plainDb.toString(d).split("\n")) {
    if (!line) continue;
    m.set(String(JSON.parse(line).id), line);
  }
  return m;
};
const fromRecords = (m: Map<string, string>): Document =>
  plainDb.fromString(
    [...m.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, line]) => line)
      .join("\n"),
  );
const dbCodec: DocCodec = {
  ...plainDb,
  merge3: (base, a, b) => {
    const [mb, ma, mbb] = [records(base), records(a), records(b)];
    const out = new Map<string, string>();
    for (const id of new Set([...mb.keys(), ...ma.keys(), ...mbb.keys()])) {
      const [x, y, z] = [mb.get(id), ma.get(id), mbb.get(id)];
      const v = y === x ? z : z === x ? y : z;
      if (v != null) out.set(id, v);
    }
    return fromRecords(out);
  },
};

function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const WORDS = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];

function editString(r: (n: number) => number, s: string): string {
  const lines = s.length ? s.split("\n") : [];
  const i = r(lines.length + 1);
  switch (r(3)) {
    case 0:
      lines.splice(i, 0, `${WORDS[r(WORDS.length)]} ${r(1000)}`);
      break;
    case 1:
      if (lines.length > 0) lines.splice(Math.min(i, lines.length - 1), 1);
      else lines.push("start");
      break;
    default:
      if (lines.length > 0) lines[Math.min(i, lines.length - 1)] += ` ${WORDS[r(WORDS.length)]}`;
      else lines.push("start");
  }
  return lines.join("\n");
}

function editDb(r: (n: number) => number, d: Document): Document {
  const m = records(d);
  const id = `k${r(8)}`;
  if (r(4) === 0) m.delete(id);
  else m.set(id, JSON.stringify({ id, v: `${WORDS[r(WORDS.length)]}${r(100)}` }));
  return fromRecords(m);
}

// A random history of `n` patches by up to 3 clients editing concurrently:
// each commits on the heads it knows, sometimes catching up on all heads (a
// merge commit when there are several), over about `days` days.
function randomHistory(seed: number, codec: DocCodec, n: number, days = 30): Patch[] {
  const r = rng(seed);
  const g = new PatchGraph({ codec });
  const out: Patch[] = [];
  const clients = 1 + r(3);
  const known: PatchId[][] = Array.from({ length: clients }, () => []);
  let ms = T0;
  for (let i = 0; i < n; i++) {
    ms += 1 + r(Math.floor((days * DAY) / n) * 2);
    const c = r(clients);
    if (r(3) === 0 && out.length > 0) known[c] = g.getHeads();
    const parents = known[c];
    const from = parents.length > 0 ? g.exactValueOf(parents)! : codec.fromString("");
    const to =
      codec === dbCodec ? editDb(r, from) : codec.fromString(editString(r, codec.toString(from)));
    const time = encodePatchId(ms, `client${c}`);
    const p: Patch = {
      time,
      parents,
      userId: c,
      patch: codec.makePatch(from, to),
      hash: g.hashOf(to),
    };
    if (parents.length > 1 && r(2) === 0) {
      p.mergeParent = parents[0];
      p.mergePatch = codec.makePatch(g.exactValueOf([parents[0]])!, from);
    }
    g.add([p]);
    out.push(p);
    known[c] = [time];
  }
  return out;
}

function same(codec: DocCodec, a: Document, b: Document): boolean {
  return a.isEqual(b) || codec.toString(a) === codec.toString(b);
}

function users(patches: Patch[]): Set<number> {
  const out = new Set<number>();
  for (const p of patches) {
    if (p.userId != null) out.add(p.userId);
    for (const u of squashedInfo(p)?.users ?? []) out.add(u);
  }
  return out;
}

// Every invariant of compactHistory for one history and policy.
function checkInvariants(codec: DocCodec, patches: Patch[], policy: CompactionPolicy, now: number) {
  const result = compactHistory({ patches, codec, policy, now });
  const old = new PatchGraph({ codec });
  old.add(patches);
  const fresh = new PatchGraph({ codec });
  fresh.add(result.patches);

  // 1. kept versions are exact
  for (const t of result.versions) {
    expect(same(codec, fresh.version(t), old.version(t))).toBe(true);
  }
  // 2. the newest value is unchanged, and every head is kept
  expect(same(codec, fresh.value(), old.value())).toBe(true);
  for (const h of old.getHeads()) expect(result.versions).toContain(h);
  // the policy's versions are kept
  for (const t of selectVersions(policy, old.versions(), now)) {
    expect(result.versions).toContain(t);
  }
  // 3. a valid history: unique ids in time order, parents before children,
  //    a snapshot first, exact values without more history
  const times = result.patches.map((p) => p.time);
  expect(new Set(times).size).toBe(times.length);
  expect([...times].sort()).toEqual(times);
  expect(times).toEqual(result.versions);
  const seen = new Set<string>();
  for (const p of result.patches) {
    for (const parent of p.parents ?? []) {
      if (!result.stats.identity) expect(seen.has(parent)).toBe(true);
    }
    seen.add(p.time);
  }
  if (!result.stats.identity) {
    expect(result.patches[0].isSnapshot).toBe(true);
    expect(fresh.needsMoreHistory()).toBe(false);
  }
  //    deterministic
  const again = compactHistory({ patches, codec, policy, now });
  expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  // 4. idempotent
  const twice = compactHistory({ patches: result.patches, codec, policy, now });
  expect(JSON.stringify(twice.patches)).toBe(JSON.stringify(result.patches));
  // 5. authorship survives
  for (const u of users(patches)) expect(users(result.patches).has(u)).toBe(true);
  // 7. never larger
  const before = old.versions().reduce((n, t) => n + encodedSize(old.getPatch(t)), 0);
  const after = result.patches.reduce((n, p) => n + encodedSize(p), 0);
  expect(result.stats.bytesBefore).toBe(before);
  expect(result.stats.bytesAfter).toBe(after);
  expect(after).toBeLessThanOrEqual(before);
  return result;
}

function randomPolicy(r: (n: number) => number, now: number): CompactionPolicy {
  const pick = (): CompactionPolicy => {
    switch (r(6)) {
      case 0:
        return { kind: "keepAll" };
      case 1:
        return { kind: "keepSince", since: now - r(40) * DAY };
      case 2:
        return { kind: "uniform", interval: [HOUR, 6 * HOUR, DAY, 7 * DAY][r(4)] };
      case 3:
        return {
          kind: "tiered",
          tiers: [
            { olderThan: 2 * DAY, interval: HOUR },
            { olderThan: 7 * DAY, interval: DAY },
            { olderThan: 21 * DAY, interval: 7 * DAY },
          ],
        };
      case 4:
        return { kind: "latestOnly" };
      default:
        return { kind: "union", policies: [pick(), pick()] };
    }
  };
  return pick();
}

describe("selectVersions", () => {
  const t = (ms: number, c = "a") => encodePatchId(ms, c);
  const times = [t(T0), t(T0 + HOUR), t(T0 + 2 * HOUR), t(T0 + DAY), t(T0 + DAY + 1)];

  it("keepSince keeps the version current at the time and those after", () => {
    expect([...selectVersions({ kind: "keepSince", since: T0 + 90 * 60_000 }, times)]).toEqual([
      times[2],
      times[3],
      times[4],
      times[1],
    ]);
  });

  it("uniform keeps the newest of each interval", () => {
    const kept = selectVersions({ kind: "uniform", interval: DAY }, times);
    expect([...kept].sort()).toEqual([times[2], times[4]].sort());
  });

  it("tiered keeps everything young and thins out older versions", () => {
    const now = T0 + DAY + 2;
    const kept = selectVersions(
      { kind: "tiered", tiers: [{ olderThan: 12 * HOUR, interval: DAY }] },
      times,
      now,
    );
    expect([...kept].sort()).toEqual([times[2], times[3], times[4]].sort());
  });

  it("latestOnly selects nothing (the heads are added), keepAll everything", () => {
    expect(selectVersions({ kind: "latestOnly" }, times).size).toBe(0);
    expect(selectVersions({ kind: "keepAll" }, times).size).toBe(times.length);
  });

  it("rejects a non-positive interval", () => {
    expect(() => selectVersions({ kind: "uniform", interval: 0 }, times)).toThrow();
  });
});

describe("compactHistory on a linear text history", () => {
  // a single-branch history by three users, one line an hour
  const g = new PatchGraph({ codec: stringCodec });
  const linear: Patch[] = [];
  let value = "";
  for (let i = 0; i < 20; i++) {
    const next = `${value}line ${i}\n`;
    const time = encodePatchId(T0 + i * HOUR, `u${i % 3}`);
    const p: Patch = {
      time,
      parents: linear.length ? [linear[linear.length - 1].time] : [],
      userId: i % 3,
      patch: stringCodec.makePatch(stringCodec.fromString(value), stringCodec.fromString(next)),
    };
    g.add([p]);
    linear.push(p);
    value = next;
  }

  it("latestOnly keeps one snapshot with everyone's authorship", () => {
    const result = checkInvariants(stringCodec, linear, { kind: "latestOnly" }, T0 + DAY);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].isSnapshot).toBe(true);
    expect(result.patches[0].snapshot).toBe(value);
    const info = squashedInfo(result.patches[0])!;
    expect(info.users).toEqual([0, 1, 2]);
    expect(info.start).toBe(linear[0].time);
    expect(info.end).toBe(linear[19].time);
    expect(info.count).toBe(20);
    expect(result.stats.bytesAfter).toBeLessThan(result.stats.bytesBefore);
  });

  it("keepAll is the identity", () => {
    const result = checkInvariants(stringCodec, linear, { kind: "keepAll" }, T0 + DAY);
    expect(result.stats.identity).toBe(true);
    expect(result.patches).toEqual(linear);
  });

  it("keepSince keeps recent patches as they were", () => {
    const since = T0 + 15 * HOUR;
    const result = checkInvariants(stringCodec, linear, { kind: "keepSince", since }, T0 + DAY);
    expect(result.versions).toEqual(linear.slice(14).map((p) => p.time));
    // the first kept version becomes the snapshot; the rest are unchanged
    expect(result.patches[0].isSnapshot).toBe(true);
    expect(result.patches.slice(1)).toEqual(linear.slice(15));
  });

  it("uniform squashes each interval into its newest patch", () => {
    const result = checkInvariants(
      stringCodec,
      linear,
      { kind: "uniform", interval: 4 * HOUR },
      T0 + DAY,
    );
    expect(result.versions).toHaveLength(5);
    const counts = result.patches.map((p) => squashedInfo(p)?.count ?? 1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("compacts a history that starts at a snapshot", () => {
    const g = new PatchGraph({ codec: stringCodec });
    g.add(linear);
    const start: Patch = {
      ...linear[4],
      isSnapshot: true,
      snapshot: g.version(linear[4].time).toString(),
    };
    const result = checkInvariants(
      stringCodec,
      [start, ...linear.slice(5)],
      { kind: "latestOnly" },
      T0,
    );
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].snapshot).toBe(value);
  });

  it("refuses an incomplete history", () => {
    expect(() =>
      compactHistory({
        patches: linear.slice(1),
        codec: stringCodec,
        policy: { kind: "latestOnly" },
      }),
    ).toThrow(/incomplete/);
    const gap = [linear[0], ...linear.slice(2)];
    expect(() =>
      compactHistory({ patches: gap, codec: stringCodec, policy: { kind: "latestOnly" } }),
    ).toThrow(/incomplete/);
  });
});

describe("compactHistory budget", () => {
  const patches = randomHistory(7, stringCodec, 40);
  const policy: CompactionPolicy = { kind: "uniform", interval: DAY };
  const now = T0 + 40 * DAY;
  const free = compactHistory({ patches, codec: stringCodec, policy, now });

  it("counts the work", () => {
    expect(free.stats.diffs).toBeGreaterThan(0);
    expect(free.stats.diffSize).toBeGreaterThan(0);
    expect(free.stats.overBudget).toBe(false);
  });

  it("returns the input unchanged when the budget runs out", () => {
    for (const budget of [
      { maxDiffs: free.stats.diffs - 1 },
      { maxDiffSize: free.stats.diffSize - 1 },
    ]) {
      const result = compactHistory({ patches, codec: stringCodec, policy, now, budget });
      expect(result.stats.overBudget).toBe(true);
      expect(result.stats.identity).toBe(true);
      expect(result.stats.diffs).toBeLessThanOrEqual(free.stats.diffs);
      const old = new PatchGraph({ codec: stringCodec });
      old.add(patches);
      expect(result.patches).toEqual(old.versions().map((t) => old.getPatch(t)));
    }
  });

  it("gives the same result within budget", () => {
    const budget = { maxDiffs: free.stats.diffs, maxDiffSize: free.stats.diffSize };
    const result = compactHistory({ patches, codec: stringCodec, policy, now, budget });
    expect(JSON.stringify(result)).toBe(JSON.stringify(free));
  });
});

describe("compactHistory fuzz: concurrent histories", () => {
  for (const [name, codec] of [
    ["text", stringCodec],
    ["db", dbCodec],
  ] as const) {
    it(`keeps every invariant for random ${name} histories and policies`, () => {
      let compacted = 0;
      for (let seed = 1; seed <= 120; seed++) {
        const r = rng(seed * 7919);
        const patches = randomHistory(seed, codec, 5 + r(60));
        const now = T0 + 40 * DAY;
        const policy = randomPolicy(r, now);
        const result = checkInvariants(codec, patches, policy, now);
        if (!result.stats.identity) compacted++;
      }
      // most of them actually compact
      expect(compacted).toBeGreaterThan(60);
    });
  }

  it("a kept root snapshot starts the new history: no old stream position", () => {
    const codec = stringCodec;
    const g = new PatchGraph({ codec });
    const t = (i: number) => encodePatchId(T0 + i * HOUR, `u${i}`);
    const root: Patch = {
      time: t(0),
      parents: [],
      userId: 0,
      isSnapshot: true,
      snapshot: "a\n",
      seqInfo: { seq: 500, prevSeq: 400 },
      source: "persist",
    };
    g.add([root]);
    const commit = (i: number, parent: number, text: string): Patch => {
      const from = g.exactValueOf([t(parent)])!;
      const to = codec.fromString(text);
      const p: Patch = {
        time: t(i),
        parents: [t(parent)],
        userId: i,
        patch: codec.makePatch(from, to),
        hash: g.hashOf(to),
      };
      g.add([p]);
      return p;
    };
    // two branches from the root; the first has an edit that is dropped
    const patches = [
      root,
      commit(1, 0, "a\nb\n"),
      commit(2, 0, "c\na\n"),
      commit(3, 1, "a\nb\nd\n"),
    ];
    const result = checkInvariants(codec, patches, { kind: "latestOnly" }, T0);
    expect(result.stats.identity).toBe(false);
    expect(result.versions).toEqual([t(0), t(2), t(3)]);
    expect(result.patches[0].time).toBe(t(0));
    expect(result.patches[0].isSnapshot).toBe(true);
    expect(result.patches[0].seqInfo).toBeUndefined();
    expect(result.patches[0].source).toBeUndefined();
  });

  it("follows every set of merge bases, also one of bases seen before", () => {
    // (@review) heads 4, 5, 6, 7 merge from bases 2 and 3, which merge from
    // base 1: 1 must be kept, 0 need not be.
    const codec = stringCodec;
    const parentsOf = [[], [0], [1], [1], [3], [2, 3], [1, 2], [1, 2, 3]];
    const t = (i: number) => encodePatchId(T0 + i * HOUR, `u${i}`);
    const g = new PatchGraph({ codec });
    const patches: Patch[] = [];
    parentsOf.forEach((ps, i) => {
      const parents = ps.map(t);
      const from = parents.length ? g.exactValueOf(parents)! : codec.fromString("");
      const to = codec.fromString(`${from.toString()}line ${i}\n`);
      const p: Patch = {
        time: t(i),
        parents,
        userId: i % 3,
        patch: codec.makePatch(from, to),
        hash: g.hashOf(to),
      };
      if (parents.length > 1) {
        p.mergeParent = parents[0];
        p.mergePatch = codec.makePatch(g.exactValueOf([parents[0]])!, from);
      }
      g.add([p]);
      patches.push(p);
    });
    expect(g.getHeads()).toEqual([4, 5, 6, 7].map(t));
    const result = checkInvariants(codec, patches, { kind: "latestOnly" }, T0);
    expect(result.stats.identity).toBe(false);
    expect(result.versions).toEqual([1, 2, 3, 4, 5, 6, 7].map(t));
  });

  it("keeps several concurrent heads, merging to the same value", () => {
    for (let seed = 200; seed < 260; seed++) {
      const patches = randomHistory(seed, stringCodec, 30);
      const old = new PatchGraph({ codec: stringCodec });
      old.add(patches);
      if (old.getHeads().length < 2) continue;
      const result = checkInvariants(stringCodec, patches, { kind: "latestOnly" }, T0);
      const fresh = new PatchGraph({ codec: stringCodec });
      fresh.add(result.patches);
      expect(fresh.getHeads()).toEqual(old.getHeads());
    }
  });
});

describe("compactHistory scale", () => {
  it("compacts 10k patches of a large text quickly", () => {
    const codec = stringCodec;
    const patches: Patch[] = [];
    let value = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    let prev = codec.fromString("");
    let doc = codec.fromString(value);
    const g0 = encodePatchId(T0, "u");
    patches.push({ time: g0, parents: [], userId: 0, isSnapshot: true, snapshot: value });
    prev = doc;
    for (let i = 1; i < 10_000; i++) {
      const lines = value.split("\n");
      lines[i % lines.length] += ` e${i}`;
      value = lines.join("\n");
      doc = codec.fromString(value);
      patches.push({
        time: encodePatchId(T0 + i * 60_000, `u${i % 5}`),
        parents: [patches[i - 1].time],
        userId: i % 5,
        patch: codec.makePatch(prev, doc),
      });
      prev = doc;
    }
    const start = Date.now();
    const result = compactHistory({
      patches,
      codec,
      policy: { kind: "uniform", interval: DAY },
      now: T0 + 10_000 * 60_000,
    });
    const elapsed = Date.now() - start;
    expect(result.versions.length).toBeLessThan(10);
    expect(result.stats.bytesAfter).toBeLessThan(result.stats.bytesBefore);
    const fresh = new PatchGraph({ codec });
    fresh.add(result.patches);
    expect(fresh.value().toString()).toBe(value);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});
