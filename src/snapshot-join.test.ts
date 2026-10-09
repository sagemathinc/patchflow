/*
Clients that load a document from its latest snapshot (the snapshot plus the
patches appended to the stream after the snapshotted patch, as CoCalc does)
must compute the same value as clients holding the full history.

A random session: clients edit a text concurrently over a network with delays,
some go offline for a while and append their patches when they reconnect, and
snapshots are taken like SyncDoc does (at a patch in the middle of the history).
At the end a late client loads from the latest snapshot. Runs with and without
exact merges, so a difference that also happens with the legacy algorithm shows
as a pre-existing one rather than a regression.

SNAPSHOT_FUZZ_RUNS (default 30) sets the number of sessions.
*/

import { PatchGraph } from "./patch-graph";
import { encodePatchId, comparePatchId } from "./patch-id";
import { mergeStrings3 } from "./merge3";
import { StringDocument } from "./string-document";
import { hashString } from "./value-hash";
import type { DocCodec, Inconsistency, Patch } from "./types";

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

const RUNS = Number(process.env.SNAPSHOT_FUZZ_RUNS ?? 30);
const OFFLINE = Number(process.env.SNAPSHOT_OFFLINE ?? 0.03);
const DELAY = Number(process.env.SNAPSHOT_DELAY ?? 3000);
const LOAD_MORE = !process.env.SNAPSHOT_NO_LOAD_MORE;

function session(seed: number, codec: DocCodec) {
  let s = seed;
  const rng = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const nClients = 3;
  const stream: Patch[] = []; // server append order
  // Every client checks the values it computes against the hashes their
  // authors recorded.
  const inconsistencies: Inconsistency[] = [];
  const onInconsistency = (e: Inconsistency) => inconsistencies.push(e);
  const graphs = Array.from({ length: nClients }, () => new PatchGraph({ codec, onInconsistency }));
  const outbox: Patch[][] = Array.from({ length: nClients }, () => []);
  const offlineUntil = Array(nClients).fill(0);
  let clock = 1_000_000;
  let token = 0;
  const snapshotSeq = new Map<string, number>(); // snapshotted patch -> seq

  const append = (patch: Patch) => {
    stream.push(patch);
    arrival.push(clock + Math.floor(rng() * DELAY));
    return stream.length - 1;
  };
  // Each client receives the stream in order (as from a CoCalc core stream),
  // with random delays; an offline client receives nothing until it is back.
  const received = Array(nClients).fill(0); // next seq each client gets
  const arrival: number[] = []; // earliest delivery time of each seq
  const deliver = (all = false) => {
    for (let to = 0; to < nClients; to++) {
      if (!all && offlineUntil[to] > clock) continue;
      while (received[to] < stream.length && (all || arrival[received[to]] <= clock)) {
        graphs[to].add([stream[received[to]]]);
        received[to]++;
      }
    }
  };
  const steps = Number(process.env.SNAPSHOT_STEPS ?? 300);
  for (let step = 0; step < steps; step++) {
    clock += Math.floor(rng() * 400);
    const c = Math.floor(rng() * nClients);
    const g = graphs[c];
    if (rng() < OFFLINE && offlineUntil[c] <= clock) {
      offlineUntil[c] = clock + 5_000 + Math.floor(rng() * 20_000);
    }
    const online = offlineUntil[c] <= clock;
    if (online && outbox[c].length > 0) {
      for (const p of outbox[c]) append(p);
      outbox[c] = [];
    }
    // An edit: insert a token line or delete a line.
    const before = g.getHeads().length ? g.value().toString() : "";
    const lines = before.split("\n").filter(Boolean);
    if (lines.length > 3 && rng() < 0.3) {
      lines.splice(Math.floor(rng() * lines.length), 1);
    } else {
      lines.splice(Math.floor(rng() * (lines.length + 1)), 0, `t${token++}`);
    }
    const after = lines.join("\n") + "\n";
    clock += 1;
    const patch: Patch = {
      time: encodePatchId(clock, `c${c}`),
      wall: clock,
      parents: g.getValueHeads(),
      patch: g.getHeads().length
        ? g.value().makePatch(codec.fromString(after))
        : codec.fromString("").makePatch(codec.fromString(after)),
      userId: c,
      hash: codec.merge3 ? hashString(after) : undefined,
    };
    g.add([patch]);
    if (online) append(patch);
    else outbox[c].push(patch);
    // Snapshots as SyncDoc takes them: at the patch `interval` into the
    // window since the last snapshot, once the window has 2*interval patches.
    if (online && rng() < 0.2) {
      const interval = 15;
      const history = g.history({ includeSnapshots: true });
      const snaps = history.filter((p) => p.isSnapshot);
      const last = snaps.length ? snaps[snaps.length - 1].time : undefined;
      const window = history.filter((p) => (last ? comparePatchId(p.time, last) >= 0 : true));
      if (window.length >= 2 * interval) {
        // The nearest clean cut to the target (SNAPSHOT_ANY: the target).
        // Like SyncDoc's 300 patches after the snapshotted one, only snapshot
        // a patch older than any network delay: then only a client that was
        // offline can still add patches concurrent with it.
        let idx: number | undefined = Math.min(interval, window.length - 1);
        if (!process.env.SNAPSHOT_ANY) {
          const target = idx;
          const settled = (p: Patch) => (p.wall ?? 0) < clock - 10_000;
          // Judge a cut only with everything appended up to it received (in
          // CoCalc, the patches after it arrive in stream order after it).
          const seqOf = (t: string) => stream.findIndex((p) => p.time === t);
          const ok = (i: number) =>
            settled(window[i]) &&
            seqOf(window[i].time) >= 0 &&
            seqOf(window[i].time) < received[c] &&
            g.isCut(window[i].time);
          idx = undefined;
          for (let d = 0; d < window.length && idx == null; d++) {
            for (const i of [target - d, target + d]) {
              if (i >= 1 && i < window.length && ok(i)) {
                idx = i;
                break;
              }
            }
          }
        }
        const t = idx == null ? undefined : window[idx]?.time;
        const seq = t == null ? -1 : stream.findIndex((p) => p.time === t);
        if (t != null && seq >= 0 && !snapshotSeq.has(t)) {
          snapshotSeq.set(t, seq);
          // Like CoCalc's snapshot records: the value only, without the
          // patch or its parents.
          const { wall, userId, hash } = g.getPatch(t);
          append({
            time: t,
            wall,
            userId,
            hash,
            parents: [],
            isSnapshot: true,
            snapshot: g.value({ time: t }).toString(),
          });
        }
      }
    }
    deliver();
  }
  // Everyone reconnects; deliver everything.
  for (let c = 0; c < nClients; c++) {
    offlineUntil[c] = 0;
    for (const p of outbox[c]) append(p);
    outbox[c] = [];
  }
  deliver(true);

  const values = graphs.map((g) => g.value().toString());
  // A late client loads the latest snapshot and the patches after it, and
  // loads more history (back to the previous snapshot, and so on) while the
  // graph says it needs more.
  let late: string | undefined;
  let extraLoads = 0;
  const snapTimes = Array.from(snapshotSeq.keys()).sort(
    (a, b) => snapshotSeq.get(a)! - snapshotSeq.get(b)!,
  );
  if (snapTimes.length > 0) {
    const g = new PatchGraph({ codec, onInconsistency });
    const snapshotRecord = (t: string) => stream.find((p) => p.time === t && p.isSnapshot)!;
    let k = snapTimes.length - 1;
    let from = snapshotSeq.get(snapTimes[k])!;
    g.add([
      snapshotRecord(snapTimes[k]),
      ...stream.slice(from).filter((p) => p.time !== snapTimes[k]),
    ]);
    while (LOAD_MORE && g.needsMoreHistory() && from > 0) {
      extraLoads++;
      k--;
      const to = from;
      from = k >= 0 ? snapshotSeq.get(snapTimes[k])! : 0;
      // Up to and including the patch the newer snapshot is of (in CoCalc,
      // loading more history loads everything before the loaded range).
      const older = stream.slice(from, to + 1).filter((p) => !p.isSnapshot);
      g.add(
        k >= 0
          ? [snapshotRecord(snapTimes[k]), ...older.filter((p) => p.time !== snapTimes[k])]
          : older,
      );
    }
    late = g.value().toString();
  }
  return { values, late, snapshots: snapTimes.length, extraLoads, inconsistencies };
}

describe("loading from a snapshot", () => {
  it("full-history clients converge, and a late client loading from the latest snapshot agrees", () => {
    const report = {
      exact: { diverged: 0, late: 0 },
      legacy: { diverged: 0, late: 0 },
      snapshots: 0,
      extraLoads: 0,
    };
    const failures: string[] = [];
    for (let seed = Number(process.env.SNAPSHOT_SEED ?? 1); seed <= RUNS; seed++) {
      for (const [name, codec] of [
        ["exact", exactCodec],
        ["legacy", legacyCodec],
      ] as const) {
        const r = session(seed, codec);
        if (name === "exact") {
          report.snapshots += r.snapshots;
          report.extraLoads += r.extraLoads;
        }
        if (new Set(r.values).size !== 1) {
          report[name].diverged++;
          if (name === "exact") failures.push(`seed ${seed}: full-history clients diverged`);
        }
        if (name === "exact" && r.inconsistencies.length > 0) {
          failures.push(
            `seed ${seed}: ${r.inconsistencies.length} values differ from their hashes`,
          );
        }
        if (r.late != null && r.late !== r.values[0]) {
          report[name].late++;
          if (name === "exact") failures.push(`seed ${seed}: late client differs`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report));
    expect(failures).toEqual([]);
  }, 120_000); // a synchronous fuzz: about 16 s (jest did not time synchronous tests; vitest does)
});

describe("a session that receives the snapshotted patch last", () => {
  it("refreshes its document when only a snapshot record is upgraded", async () => {
    const { Session } = await import("./session");
    const { MemoryPatchStore } = await import("./adapters/memory-patch-store");
    const { legacyPatchId: id } = await import("./patch-id");
    const doc = (s: string) => new StringDocument(s);
    const patch = (t: number, parents: number[], from: string, to: string): Patch => ({
      time: id(t),
      parents: parents.map(id),
      patch: doc(from).makePatch(doc(to)),
    });
    // t2 and t3 edit t1 concurrently, t4 builds on t2 and is snapshotted, t5
    // merges t4 and t3.
    const ps = [
      patch(1, [], "", "a\nb\nc\n"),
      patch(2, [1], "a\nb\nc\n", "A\nb\nc\n"),
      patch(3, [1], "a\nb\nc\n", "a\nb\nC\n"),
      patch(4, [2], "A\nb\nc\n", "A\nB\nc\n"),
      patch(5, [4, 3], "A\nB\nC\n", "A\nB\nC\nd\n"),
    ];
    const snap: Patch = { time: id(4), parents: [], isSnapshot: true, snapshot: "A\nB\nc\n" };
    const s = new Session({
      codec: exactCodec,
      clientId: "late",
      patchStore: new MemoryPatchStore([snap, ps[4], ...ps.slice(0, 3)]),
    });
    await s.init();
    let changes = 0;
    s.on("change", () => changes++);
    // The patch the snapshot is of arrives last: no new patch, but the value
    // changes.
    expect(s.applyRemoteBatch([ps[3]])).toEqual([]);
    expect(changes).toBe(1);
    expect(s.getDocument().toString()).toBe("A\nB\nC\nd\n");
    expect(s.value().toString()).toBe("A\nB\nC\nd\n");
    // Replaying it again changes nothing.
    expect(s.applyRemoteBatch([ps[3]])).toEqual([]);
    expect(changes).toBe(1);
    s.close();
  });
});
