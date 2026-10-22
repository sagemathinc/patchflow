/*
History compaction: a smaller history that keeps chosen versions exactly.

TimeTravel is revision control for some documents (code, papers) and disaster
recovery for others (chats, whose newest version already holds everything),
so a host can offer retention strategies instead of only deleting history.
compactHistory is the pure, deterministic part: a history and a policy in, a
new history out. Storing it (atomically, as a new history) is the host's job.

How it works. A policy chooses versions (patch times) to keep; the heads, and
the merge bases the value of several heads is merged from, are always kept.
Every kept version becomes a patch whose parents are its nearest kept
ancestors, with a diff from their exact value in the old history, so its value
is exactly its old value. A kept version with several parents records its
merged value (Patch.mergeParent/mergePatch), so its value never depends on how
a later version merges. A kept version without kept ancestors becomes a
snapshot. Dropped patches are squashed into their nearest kept descendants,
which record whose edits they absorbed (meta.squashed). A kept patch whose
parents do not change and that absorbs nothing is kept as it was (minus the
snapshot text a store may have attached to it), which makes compaction
idempotent and leaves untouched history byte for byte.

Guarantees (see compact-history.test.ts):
- every kept version has exactly its old value;
- the newest value (of all heads) is unchanged;
- the result is a valid history, the same for the same input;
- compacting the result again with the same policy changes nothing;
- the users whose edits were dropped are recorded on the patches absorbing them;
- the result is never larger than the input (else the input is returned).
*/

import { PatchGraph } from "./patch-graph";
import { comparePatchId, decodePatchId, type PatchId } from "./patch-id";
import type { DocCodec, Document, JSONValue, Patch } from "./types";

// Which versions to keep (besides the heads and their merge bases, which are
// always kept). Times are milliseconds; a version's time is that of its patch
// id (decodePatchId).
export type CompactionPolicy =
  // Everything: the result is the input.
  | { kind: "keepAll" }
  // The version current at `since` and every version after it.
  | { kind: "keepSince"; since: number }
  // The newest version of every `interval` (aligned to the epoch).
  | { kind: "uniform"; interval: number }
  // Backup style: versions younger than the first tier's olderThan are all
  // kept; a version at least `olderThan` old (relative to `now`), for the
  // largest such tier, is kept if it is the newest of its `interval` (every
  // version if interval <= 0). Example: all for 7 days, hourly for 4 weeks,
  // daily for a year, weekly after:
  //   [{ olderThan: 7*DAY, interval: HOUR },
  //    { olderThan: 35*DAY, interval: DAY },
  //    { olderThan: 365*DAY, interval: 7*DAY }]
  | { kind: "tiered"; tiers: { olderThan: number; interval: number }[] }
  // Only the newest version.
  | { kind: "latestOnly" }
  // Every version any of the policies keeps.
  | { kind: "union"; policies: CompactionPolicy[] };

// Recorded in Patch.meta.squashed on a patch that absorbed dropped patches:
// the users whose edits it holds (in the order of their first edit,
// including its own author), its first and last absorbed times, and how
// many patches of the original history it stands for.
export interface SquashedInfo {
  users: number[];
  start: PatchId;
  end: PatchId;
  count: number;
}

// Limits on the work compaction may do. Diffs dominate its cost (each is a
// diff of two whole versions), so they are counted, not timed: the same input
// and budget always give the same result. Over budget, the input is returned
// unchanged (stats.overBudget), before any diff that would exceed it.
export interface CompactionBudget {
  // Diffs computed (one per rewritten patch, a few more per merge commit).
  maxDiffs?: number;
  // Total size of the versions diffed (both sides of every diff; characters
  // of a text, the codec's size estimate for other documents).
  maxDiffSize?: number;
}

export interface CompactionStats {
  versionsBefore: number;
  versionsAfter: number;
  // Encoded size (see encodedSize) of all records.
  bytesBefore: number;
  bytesAfter: number;
  // The input was returned unchanged: the policy keeps everything, the
  // compacted history would not have been smaller, or the budget ran out.
  identity: boolean;
  // The budget ran out (the input was returned unchanged).
  overBudget: boolean;
  // Work done: diffs computed and the total size of the versions diffed.
  diffs: number;
  diffSize: number;
}

export interface CompactionResult {
  // The new history in time order: the first record is a snapshot (unless
  // the input is returned unchanged), and every parent precedes its children.
  patches: Patch[];
  // The kept versions (times of the input), in time order.
  versions: PatchId[];
  stats: CompactionStats;
}

// Size of a record as a host would store it (UTF-8 JSON).
export function encodedSize(patch: Patch): number {
  return utf8Length(JSON.stringify(patch) ?? "");
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// Parents considered for a merge commit's recorded merged value, as Session
// does (see Session.recordMerge).
const MAX_MERGE_PARENT_CANDIDATES = 2;

function patchSize(patch: unknown): number {
  if (patch instanceof Uint8Array) return patch.byteLength;
  return JSON.stringify(patch)?.length ?? 0;
}

function timeMs(time: PatchId): number {
  return decodePatchId(time).timeMs;
}

// The versions a policy keeps, of `times` (sorted, oldest first).
export function selectVersions(
  policy: CompactionPolicy,
  times: PatchId[],
  now: number = Date.now(),
): Set<PatchId> {
  const keep = new Set<PatchId>();
  const newestPer = (key: (t: PatchId) => string | undefined) => {
    // times are sorted, so the last one seen per key is the newest
    const newest = new Map<string, PatchId>();
    for (const t of times) {
      const k = key(t);
      if (k === undefined) keep.add(t);
      else newest.set(k, t);
    }
    for (const t of newest.values()) keep.add(t);
  };
  switch (policy.kind) {
    case "keepAll":
      for (const t of times) keep.add(t);
      break;
    case "latestOnly":
      break;
    case "keepSince": {
      let current: PatchId | undefined;
      for (const t of times) {
        if (timeMs(t) >= policy.since) keep.add(t);
        else current = t;
      }
      if (current !== undefined) keep.add(current);
      break;
    }
    case "uniform": {
      const interval = positive(policy.interval, "uniform interval");
      newestPer((t) => `${Math.floor(timeMs(t) / interval)}`);
      break;
    }
    case "tiered": {
      const tiers = [...policy.tiers].sort((a, b) => a.olderThan - b.olderThan);
      newestPer((t) => {
        const age = now - timeMs(t);
        let tier = -1;
        for (let i = 0; i < tiers.length; i++) if (age >= tiers[i].olderThan) tier = i;
        if (tier < 0 || !(tiers[tier].interval > 0)) return undefined;
        return `${tier}:${Math.floor(timeMs(t) / tiers[tier].interval)}`;
      });
      break;
    }
    case "union":
      for (const p of policy.policies) for (const t of selectVersions(p, times, now)) keep.add(t);
      break;
    default:
      throw new Error(`unknown compaction policy: ${JSON.stringify(policy)}`);
  }
  return keep;
}

function positive(x: number, what: string): number {
  if (!(Number.isFinite(x) && x > 0)) throw new Error(`${what} must be positive, got ${x}`);
  return x;
}

export function compactHistory(opts: {
  patches: Patch[];
  // The document type (must provide merge3: values must be exact).
  codec: DocCodec;
  policy: CompactionPolicy;
  // For age based policies (tiered); default Date.now().
  now?: number;
  budget?: CompactionBudget;
}): CompactionResult {
  const { codec, policy } = opts;
  const work = new Work(codec, opts.budget);
  const now = opts.now ?? Date.now();
  if (codec.merge3 == null) {
    throw new Error("compactHistory: the codec must provide merge3 (exact values)");
  }
  const old = new PatchGraph({ codec });
  old.add(opts.patches);
  if (old.needsMoreHistory() || old.valueUnavailable()) {
    throw new Error(
      "compactHistory: the history is incomplete (a patch depends on one that is missing)",
    );
  }
  const times = old.versions();
  const records = times.map((t) => old.getPatch(t));
  const bytesBefore = records.reduce((n, p) => n + encodedSize(p), 0);
  const identity = (overBudget = false): CompactionResult => ({
    patches: records,
    versions: times,
    stats: {
      versionsBefore: times.length,
      versionsAfter: times.length,
      bytesBefore,
      bytesAfter: bytesBefore,
      identity: true,
      overBudget,
      diffs: work.diffs,
      diffSize: work.diffSize,
    },
  });
  if (times.length === 0 || policy.kind === "keepAll") return identity();

  const has = (t: PatchId) => {
    try {
      old.getPatch(t);
      return true;
    } catch {
      return false;
    }
  };
  const parentsOf = (t: PatchId) => (old.getPatch(t).parents ?? []).filter(has);

  const keep = selectVersions(policy, times, now);
  const heads = old.getHeads();
  for (const h of heads) keep.add(h);
  for (const t of mergeBases(heads, parentsOf)) keep.add(t);
  if (keep.size === times.length) return identity();

  const kept = times.filter((t) => keep.has(t));
  let fresh = new PatchGraph({ codec });
  const out: Patch[] = [];
  let bytesAfter = 0;
  for (const t of kept) {
    // Nearest kept ancestors, and the dropped patches only t builds on.
    const frontier = new Set<PatchId>();
    const absorbed: PatchId[] = [];
    const seen = new Set<PatchId>([t]);
    const stack = [...parentsOf(t)];
    while (stack.length > 0) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      if (keep.has(u)) {
        frontier.add(u);
        continue;
      }
      absorbed.push(u);
      stack.push(...parentsOf(u));
    }
    const parents = maximal([...frontier], parentsOf).sort(comparePatchId);
    const original = old.getPatch(t);
    const value = old.version(t);
    let record: Patch;
    try {
      record = buildRecord({
        codec,
        work,
        old,
        original,
        parents,
        absorbed: absorbed.sort(comparePatchId),
        value,
      });
    } catch (err) {
      if (err instanceof OverBudget) return identity(true);
      throw err;
    }
    fresh.add([record]);
    if (!same(codec, fresh.version(t), value)) {
      // The diff did not reproduce the value (it should): store the value.
      record = { ...withoutPatch(record), isSnapshot: true, snapshot: codec.toString(value) };
      fresh = new PatchGraph({ codec });
      fresh.add([...out, record]);
      if (!same(codec, fresh.version(t), value)) {
        throw new Error(`compactHistory: cannot reproduce the value of ${t}`);
      }
    }
    out.push(record);
    bytesAfter += encodedSize(record);
    // Already no smaller than the input: stop (the input is the result).
    if (bytesAfter > bytesBefore) return identity();
  }

  const result = new PatchGraph({ codec });
  result.add(out);
  if (!same(codec, result.value(), old.value()) || result.needsMoreHistory()) {
    // The heads did not merge to the same value (e.g. independent roots,
    // which a history starting with snapshots cannot merge from empty).
    return identity();
  }
  return {
    patches: out,
    versions: kept,
    stats: {
      versionsBefore: times.length,
      versionsAfter: kept.length,
      bytesBefore,
      bytesAfter,
      identity: false,
      overBudget: false,
      diffs: work.diffs,
      diffSize: work.diffSize,
    },
  };
}

function same(codec: DocCodec, a: Document, b: Document): boolean {
  return a.isEqual(b) || codec.toString(a) === codec.toString(b);
}

function withoutPatch(p: Patch): Patch {
  const { patch: _p, mergeParent: _mp, mergePatch: _mpatch, ...rest } = p;
  void _p;
  void _mp;
  void _mpatch;
  return rest;
}

// A record as stored, without the snapshot a store attached to it (a host
// writes its own snapshots of the new history).
function withoutSnapshot(p: Patch): Patch {
  const { isSnapshot: _i, snapshot: _s, seqInfo: _q, ...rest } = p;
  void _i;
  void _s;
  void _q;
  return rest;
}

class OverBudget extends Error {}

// Diffs done so far, against the budget.
class Work {
  diffs = 0;
  diffSize = 0;
  constructor(
    private codec: DocCodec,
    private budget: CompactionBudget = {},
  ) {}

  makePatch(a: Document, b: Document): unknown {
    const size = this.size(a) + this.size(b);
    const { maxDiffs, maxDiffSize } = this.budget;
    if (maxDiffs != null && this.diffs + 1 > maxDiffs) throw new OverBudget();
    if (maxDiffSize != null && this.diffSize + size > maxDiffSize) throw new OverBudget();
    this.diffs += 1;
    this.diffSize += size;
    return this.codec.makePatch(a, b);
  }

  private size(doc: Document): number {
    const n = doc.size?.() ?? doc.count?.();
    return Number.isFinite(n) && n! >= 0 ? n! : this.codec.toString(doc).length;
  }
}

function buildRecord(opts: {
  codec: DocCodec;
  work: Work;
  old: PatchGraph;
  original: Patch;
  parents: PatchId[];
  absorbed: PatchId[];
  value: Document;
}): Patch {
  const { codec, work, old, original, parents, absorbed, value } = opts;
  const originalParents = [...(original.parents ?? [])].sort(comparePatchId);
  const sameParents =
    originalParents.length === parents.length && originalParents.every((p, i) => p === parents[i]);
  // Unchanged: same parents, nothing absorbed, and a value that does not
  // depend on how its parents merge.
  if (absorbed.length === 0 && sameParents) {
    // a root snapshot without a patch, as compaction writes them
    if (parents.length === 0 && original.isSnapshot && original.snapshot != null) {
      if (original.patch == null) return original;
    }
    if (
      parents.length === 1 ||
      (parents.length > 1 && original.mergeParent != null && original.mergePatch != null)
    ) {
      if (original.patch != null) return withoutSnapshot(original);
    }
  }
  const meta = squashMeta(old, original, absorbed);
  const base: Patch = {
    time: original.time,
    parents,
    ...(original.wall != null ? { wall: original.wall } : {}),
    ...(original.userId != null ? { userId: original.userId } : {}),
    ...(original.file ? { file: true } : {}),
    hash: old.hashOf(value),
    ...(meta != null ? { meta } : {}),
  };
  if (parents.length === 0) {
    return { ...base, isSnapshot: true, snapshot: codec.toString(value) };
  }
  if (parents.length === 1) {
    const from = old.version(parents[0]);
    return { ...base, patch: work.makePatch(from, value) };
  }
  // A merge commit: record its merged value as a diff from one parent.
  const merged = old.exactValueOf(parents);
  if (merged == null) throw new Error(`compactHistory: cannot merge ${parents.join(",")}`);
  let best: { parent: PatchId; patch: unknown; size: number } | undefined;
  for (const parent of parents.slice(0, MAX_MERGE_PARENT_CANDIDATES)) {
    const patch = work.makePatch(old.version(parent), merged);
    const size = patchSize(patch);
    if (best == null || size < best.size) best = { parent, patch, size };
  }
  return {
    ...base,
    patch: work.makePatch(merged, value),
    mergeParent: best!.parent,
    mergePatch: best!.patch,
  };
}

// The authorship of a kept patch that absorbs dropped ones (Patch.meta.squashed).
function squashMeta(
  old: PatchGraph,
  original: Patch,
  absorbed: PatchId[],
): { [key: string]: JSONValue } | undefined {
  if (absorbed.length === 0) return original.meta;
  const users: number[] = [];
  const addUsers = (p: Patch) => {
    const info = squashedInfo(p);
    for (const u of info?.users ?? (p.userId != null ? [p.userId] : [])) {
      if (!users.includes(u)) users.push(u);
    }
  };
  let start = original.time;
  let count = squashedInfo(original)?.count ?? 1;
  for (const t of absorbed) {
    const p = old.getPatch(t);
    addUsers(p);
    const info = squashedInfo(p);
    count += info?.count ?? 1;
    const first = info?.start ?? t;
    if (comparePatchId(first, start) < 0) start = first;
  }
  addUsers(original);
  const ownStart = squashedInfo(original)?.start;
  if (ownStart != null && comparePatchId(ownStart, start) < 0) start = ownStart;
  const squashed: SquashedInfo = { users, start, end: original.time, count };
  return { ...original.meta, squashed: squashed as unknown as JSONValue };
}

export function squashedInfo(p: Patch): SquashedInfo | undefined {
  const s = p.meta?.squashed as unknown as SquashedInfo | undefined;
  return s != null && Array.isArray(s.users) ? s : undefined;
}

// The maximal elements of `times` (those not an ancestor of another).
function maximal(times: PatchId[], parentsOf: (t: PatchId) => PatchId[]): PatchId[] {
  if (times.length <= 1) return times;
  const set = new Set(times);
  const below = new Set<PatchId>();
  for (const t of times) {
    const stack = [...parentsOf(t)];
    const seen = new Set<PatchId>();
    // Patches are older than their children, so nothing older than the
    // oldest candidate can be one.
    const oldest = [...set].sort(comparePatchId)[0];
    while (stack.length > 0) {
      const u = stack.pop()!;
      if (seen.has(u) || comparePatchId(u, oldest) < 0) continue;
      seen.add(u);
      if (set.has(u)) below.add(u);
      stack.push(...parentsOf(u));
    }
  }
  return times.filter((t) => !below.has(t));
}

function ancestorsOf(times: PatchId[], parentsOf: (t: PatchId) => PatchId[]): Set<PatchId> {
  const seen = new Set<PatchId>();
  const stack = [...times];
  while (stack.length > 0) {
    const t = stack.pop()!;
    if (seen.has(t)) continue;
    seen.add(t);
    stack.push(...parentsOf(t));
  }
  return seen;
}

// Every patch the merged value of `heads` is computed from, as PatchGraph
// merges them (heads in time order, each into the merge of those before, from
// their maximal common ancestors, themselves merged the same way). Kept, they
// give the compacted history the same merges and so the same newest value.
function mergeBases(heads: PatchId[], parentsOf: (t: PatchId) => PatchId[]): Set<PatchId> {
  const out = new Set<PatchId>();
  const visit = (set: PatchId[]) => {
    const sorted = [...new Set(set)].sort(comparePatchId);
    if (sorted.length < 2) return;
    let acc = [sorted[0]];
    for (const t of sorted.slice(1)) {
      const a = ancestorsOf(acc, parentsOf);
      const b = ancestorsOf([t], parentsOf);
      const common = [...a].filter((u) => b.has(u));
      const bases = maximal(common, parentsOf);
      const fresh = bases.filter((u) => !out.has(u));
      for (const u of bases) out.add(u);
      if (fresh.length > 0) visit(bases);
      acc = [...acc, t];
    }
  };
  visit(heads);
  return out;
}
