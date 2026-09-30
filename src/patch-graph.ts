import { List, Map } from "immutable";
import { LRUCache } from "lru-cache";
import { comparePatchId, decodePatchId } from "./patch-id";
import type { DocCodec, Document, MergeStrategy, Patch, PatchGraphValueOptions } from "./types";

type PatchMap = Map<string, Patch>;

const DEFAULT_DEDUP_TOLERANCE = 3000;
const DEFAULT_VALUE_CACHE_MAX_ENTRIES = 100;
const DEFAULT_VALUE_CACHE_MAX_SIZE = 10_000_000;
const DEFAULT_EXACT_CACHE_MAX_ENTRIES = 2000;

export type PatchGraphOptions = {
  codec: DocCodec;
  mergeStrategy?: MergeStrategy;
  valueCacheMaxEntries?: number;
  valueCacheMaxSize?: number;
  exactCacheMaxEntries?: number;
};

function patchCmp(a: Patch, b: Patch): number {
  return comparePatchId(a.time, b.time);
}

export class PatchGraph {
  private patches: PatchMap = Map<string, Patch>();
  private children: Map<string, Set<string>> = Map<string, Set<string>>();
  private codec: DocCodec;
  public fileTimeDedupTolerance = DEFAULT_DEDUP_TOLERANCE;
  private mergeStrategy: MergeStrategy;
  // Cache single-head values keyed by patch time with a completeness count to avoid full replays.
  private valueCache: LRUCache<string, { doc: Document; count: number }>;
  // Cache reachability/topo for single heads.
  private reachabilityCache = new globalThis.Map<
    string,
    { reachable: Set<string>; ordered: string[] }
  >();
  // Cache merged docs for multi-head evaluations with no exclusions.
  private mergeCache = new globalThis.Map<string, Document>();
  // Cache versions list.
  private versionsCache?: string[];
  // Exact per-patch values and merged values of patch sets, used when the codec
  // provides merge3 (see DocCodec.merge3).
  private exactCache: LRUCache<string, { doc: Document }>;
  private exactMergeCache: LRUCache<string, { doc: Document }>;

  constructor(opts: PatchGraphOptions) {
    this.codec = opts.codec;
    const exactMax = opts.exactCacheMaxEntries ?? DEFAULT_EXACT_CACHE_MAX_ENTRIES;
    this.exactCache = new LRUCache<string, { doc: Document }>({ max: exactMax });
    this.exactMergeCache = new LRUCache<string, { doc: Document }>({ max: exactMax });
    this.mergeStrategy = opts.mergeStrategy ?? "three-way";
    const maxSize = opts.valueCacheMaxSize ?? DEFAULT_VALUE_CACHE_MAX_SIZE;
    const maxEntries = opts.valueCacheMaxEntries ?? DEFAULT_VALUE_CACHE_MAX_ENTRIES;
    if (maxSize != null) {
      const cacheOpts = {
        max: maxEntries,
        maxSize,
        sizeCalculation: (value: { doc: Document; count: number }) => {
          const size = value?.doc?.size?.() ?? value?.doc?.count?.();
          if (!Number.isFinite(size) || size <= 0) return 1;
          return size;
        },
      } as const;
      this.valueCache = new LRUCache<string, { doc: Document; count: number }>({
        ...cacheOpts,
      });
    } else {
      this.valueCache = new LRUCache<string, { doc: Document; count: number }>({
        max: maxEntries,
      });
    }
  }

  add(input: Patch[]): Patch[] {
    const added: Patch[] = [];
    if (input.length === 0) return added;
    for (const patch of input) {
      const existing = this.patches.get(patch.time);
      if (existing) {
        // merge in snapshot info if it arrives later
        if (patch.isSnapshot && patch.snapshot != null && !existing.snapshot) {
          this.clearExactCaches();
          this.patches = this.patches.set(patch.time, {
            ...existing,
            isSnapshot: true,
            snapshot: patch.snapshot,
            seqInfo: patch.seqInfo ?? existing.seqInfo,
          });
        }
        continue;
      }
      const normalized: Patch = {
        ...patch,
        parents: patch.parents ?? [],
      };
      if (this.children.has(normalized.time)) {
        // This patch fills a gap below patches already known, whose exact values
        // may have been unavailable or computed differently.
        this.clearExactCaches();
      }
      this.patches = this.patches.set(normalized.time, normalized);
      for (const parent of normalized.parents ?? []) {
        const kids = this.children.get(parent) ?? new Set<string>();
        kids.add(normalized.time);
        this.children = this.children.set(parent, kids);
      }
      added.push(normalized);
    }
    if (added.length === 0) return added;
    // Any structural change invalidates cached reachability/versions/merges.
    this.reachabilityCache.clear();
    this.mergeCache.clear();
    this.versionsCache = undefined;
    return added;
  }

  // Heads whose merged value value() returns, and on which Session commits.
  // With exact merges (codec.merge3), a patch whose parent is missing from
  // inside the loaded history (a gap, e.g. from out-of-order delivery) is held
  // back with its descendants until the parent arrives, instead of being
  // fuzzy-applied to text it was not made against. A missing parent older than
  // all loaded history (history loaded from a snapshot) holds nothing back.
  getValueHeads(): string[] {
    const heads = this.getHeads();
    if (this.codec.merge3 == null || this.mergeStrategy === "apply-all") return heads;
    const waiting = this.waitingPatches();
    if (waiting.size === 0) return heads;
    const settled: string[] = [];
    this.patches.forEach((_, time) => {
      if (waiting.has(time)) return;
      const kids = this.children.get(time);
      if (kids && Array.from(kids).some((kid) => this.patches.has(kid) && !waiting.has(kid)))
        return;
      settled.push(time);
    });
    return settled.length > 0 ? settled.sort(comparePatchId) : heads;
  }

  // Remove the changes of the excluded patches from `doc`, the exact value of
  // `heads`, newest first: each is reverted like git revert, by a three-way
  // merge of its own value (base), the current value and its parents' value.
  // Excluded patches that are not ancestors of the heads change nothing.
  private revertExact(doc: Document, heads: string[], without: Set<string>): Document | undefined {
    const merge3 = this.codec.merge3!;
    const reachable = this.ancestry(heads)?.times;
    if (reachable == null) return undefined;
    const excluded = Array.from(without)
      .filter((t) => reachable.has(t))
      .sort(comparePatchId)
      .reverse();
    for (const time of excluded) {
      const patch = this.patches.get(time)!;
      if (patch.isSnapshot || patch.patch == null) continue;
      const after = this.exactValue(time);
      const parents = patch.parents ?? [];
      const before =
        parents.length === 0 ? this.codec.fromString("") : this.exactValueOfSet(parents);
      if (after == null || before == null) return undefined;
      doc = merge3(after, doc, before);
    }
    return doc;
  }

  // Patches below a gap in the loaded history, with their descendants. A
  // valid snapshot is self-contained, so waiting stops there.
  private waitingPatches(): Set<string> {
    let oldest: string | undefined;
    this.patches.forEach((_, time) => {
      if (oldest === undefined || comparePatchId(time, oldest) < 0) oldest = time;
    });
    const stack: string[] = [];
    this.patches.forEach((patch, time) => {
      if (patch.isSnapshot && patch.snapshot != null) return;
      const gap = (patch.parents ?? []).some(
        (parent) => !this.patches.has(parent) && comparePatchId(parent, oldest!) > 0,
      );
      if (gap) stack.push(time);
    });
    const waiting = new Set<string>();
    while (stack.length > 0) {
      const time = stack.pop()!;
      if (waiting.has(time)) continue;
      waiting.add(time);
      for (const kid of this.children.get(time) ?? []) {
        const patch = this.patches.get(kid);
        if (patch != null && !(patch.isSnapshot && patch.snapshot != null)) stack.push(kid);
      }
    }
    return waiting;
  }

  getHeads(): string[] {
    const allTimes = new Set(this.patches.keySeq().toArray());
    const parents = new Set<string>();
    this.patches.forEach((patch) => {
      for (const p of patch.parents ?? []) {
        parents.add(p);
      }
    });
    for (const p of parents) {
      allTimes.delete(p);
    }
    return Array.from(allTimes.values()).sort(comparePatchId);
  }

  getPatch(time: string): Patch {
    const p = this.patches.get(time);
    if (!p) {
      throw new Error(`unknown time: ${time}`);
    }
    return p;
  }

  getParents(time: string): string[] {
    return [...(this.getPatch(time).parents ?? [])];
  }

  getAncestors(
    times: string | string[],
    opts: { includeSelf?: boolean; stopAtSnapshots?: boolean } = {},
  ): string[] {
    const includeSelf = opts.includeSelf ?? true;
    const stopAtSnapshots = opts.stopAtSnapshots ?? true;
    const seeds = Array.isArray(times) ? [...times] : [times];
    const seedSet = new Set(seeds);
    const stack = [...seeds];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (visited.has(t)) continue;
      const patch = this.patches.get(t);
      if (!patch) {
        throw new Error(`unknown time: ${t}`);
      }
      if (includeSelf || !seedSet.has(t)) {
        visited.add(t);
      }
      if (stopAtSnapshots && patch.isSnapshot) continue;
      for (const p of patch.parents ?? []) {
        stack.push(p);
      }
    }
    return Array.from(visited.values()).sort(comparePatchId);
  }

  getParentChains(
    time: string,
    opts: { stopAtSnapshots?: boolean; limit?: number } = {},
  ): string[][] {
    const stopAtSnapshots = opts.stopAtSnapshots ?? true;
    const limit = opts.limit ?? 1000;
    const start = this.getPatch(time); // throws if missing
    const chains: string[][] = [];
    const stack: { node: Patch; path: string[] }[] = [{ node: start, path: [time] }];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      const parents = node.parents ?? [];
      const terminal = parents.length === 0 || (stopAtSnapshots && node.isSnapshot === true);
      if (terminal) {
        chains.push(path);
        if (chains.length > limit) {
          throw new Error("parent chain limit exceeded");
        }
        continue;
      }
      for (const p of parents) {
        const parent = this.patches.get(p);
        if (!parent) {
          throw new Error(`unknown parent ${p}`);
        }
        stack.push({ node: parent, path: [...path, p] });
      }
    }
    return chains.sort((a, b) =>
      [...a]
        .reverse()
        .join(",")
        .localeCompare([...b].reverse().join(",")),
    );
  }

  versions(opts: { start?: string; end?: string } = {}): string[] {
    const { start, end } = opts;
    if (this.versionsCache == null) {
      this.versionsCache = this.patches
        .toArray()
        .map(([, patch]) => patch.time)
        .sort(comparePatchId);
    }
    return this.versionsCache.filter((t) => {
      if (start != null && comparePatchId(t, start) < 0) return false;
      if (end != null && comparePatchId(t, end) > 0) return false;
      return true;
    });
  }

  versionsInRange(opts: { start?: string; end?: string } = {}): string[] {
    const { start, end } = opts;
    return this.versions().filter((t) => {
      if (start != null && comparePatchId(t, start) < 0) return false;
      if (end != null && comparePatchId(t, end) > 0) return false;
      return true;
    });
  }

  version(time: string): Document {
    if (!this.patches.has(time)) {
      throw new Error(`unknown time: ${time}`);
    }
    return this.value({ time });
  }

  value(opts: PatchGraphValueOptions = {}): Document {
    if (opts.time != null && !this.patches.has(opts.time)) {
      throw new Error(`unknown time: ${opts.time}`);
    }
    const without = new Set<string>(opts.withoutTimes ?? []);
    const strategy = opts.mergeStrategy ?? this.mergeStrategy;
    const exactPath = this.codec.merge3 != null && strategy !== "apply-all";
    const headTimes =
      opts.time != null ? [opts.time] : exactPath ? this.getValueHeads() : this.getHeads();
    if (headTimes.length === 0) {
      return this.codec.fromString("");
    }
    if (exactPath) {
      // Exact values: every patch applies to the value of its own parents, and
      // concurrent heads merge from their common ancestor. Excluded patches
      // (undo) are reverted three-way from that value. Falls back to applying
      // all patches in time order when history needed for that is missing
      // (e.g., below a snapshot, or a parent not yet received).
      let exact = this.exactValueOfSet(headTimes);
      if (exact != null && without.size > 0) {
        exact = this.revertExact(exact, headTimes, without);
      }
      if (exact != null) return exact;
    }
    // Fast path: single head, no exclusions; reuse cached prefix if reachability unchanged.
    if (without.size === 0 && headTimes.length === 1) {
      const head = headTimes[0];
      const cacheAll = opts.time != null;
      const doc = this.applyAllValue([head], without, true, false, cacheAll);
      return doc;
    }

    if (headTimes.length > 1 && without.size === 0) {
      const key = headTimes.slice().sort(comparePatchId).join(",");
      const cached = this.mergeCache.get(key);
      if (cached) {
        return cached;
      }
      const doc = this.applyAllValue(headTimes, without, false, true);
      this.mergeCache.set(key, doc);
      return doc;
    }

    return this.applyAllValue(headTimes, without);
  }

  private applyAllValue(
    headTimes: string[],
    without: Set<string>,
    useCache: boolean = false,
    allowMergeCache: boolean = false,
    cacheAll: boolean = true,
  ): Document {
    let reachable: Set<string>;
    let orderedTimes: string[] | undefined;
    if (useCache && headTimes.length === 1 && without.size === 0) {
      const cachedReach = this.reachabilityCache.get(headTimes[0]);
      if (cachedReach) {
        reachable = new Set(cachedReach.reachable);
        orderedTimes = cachedReach.ordered;
      } else {
        reachable = this.knownTimes(headTimes);
        orderedTimes = Array.from(reachable).sort(comparePatchId);
        this.reachabilityCache.set(headTimes[0], {
          reachable: new Set(reachable),
          ordered: orderedTimes,
        });
      }
    } else {
      reachable = this.knownTimes(headTimes);
    }
    for (const w of without) {
      reachable.delete(w);
    }
    if (reachable.size === 0) {
      return this.codec.fromString("");
    }
    const snapshot = this.latestSnapshot(Array.from(reachable.values()));
    let doc: Document;
    let floor: string | undefined;
    if (snapshot) {
      floor = snapshot.time;
      doc = this.codec.fromString(snapshot.snapshot!);
    } else {
      doc = this.codec.fromString("");
    }

    const ordered = (orderedTimes ?? Array.from(reachable.values()))
      .filter((t) => (floor ? comparePatchId(t, floor) > 0 : true))
      .map((t) => this.patches.get(t)!)
      .sort(patchCmp);

    // dedup file-load patches that are identical and close in time
    this.dedupFileLoads(ordered);

    // If allowed, seed from the most recent cached value whose applied-count matches.
    let startIndex = 0;
    if (useCache) {
      for (let i = ordered.length - 1; i >= 0; i--) {
        const cached = this.valueCache.get(ordered[i].time);
        if (cached && cached.count === i + 1) {
          doc = cached.doc;
          startIndex = i + 1;
          break;
        }
      }
    }

    if (!useCache) {
      const patches: unknown[] = [];
      for (let i = startIndex; i < ordered.length; i++) {
        const patch = ordered[i];
        if (!patch.patch) continue;
        patches.push(patch.patch);
      }
      if (patches.length > 0) {
        doc = this.codec.applyPatchBatch(doc, patches);
      }
    } else if (!cacheAll) {
      const patches: unknown[] = [];
      for (let i = startIndex; i < ordered.length; i++) {
        const patch = ordered[i];
        if (!patch.patch) continue;
        patches.push(patch.patch);
      }
      if (patches.length > 0) {
        doc = this.codec.applyPatchBatch(doc, patches);
        const last = ordered[ordered.length - 1];
        this.valueCache.set(last.time, { doc, count: ordered.length });
      }
    } else {
      for (let i = startIndex; i < ordered.length; i++) {
        const patch = ordered[i];
        if (!patch.patch) continue;
        doc = this.codec.applyPatch(doc, patch.patch);
        if (useCache) {
          this.valueCache.set(patch.time, { doc, count: i + 1 });
        }
      }
    }
    if (allowMergeCache && headTimes.length > 1 && without.size === 0) {
      const key = headTimes.slice().sort(comparePatchId).join(",");
      this.mergeCache.set(key, doc);
    }
    return doc;
  }

  private clearExactCaches(): void {
    this.exactCache.clear();
    this.exactMergeCache.clear();
  }

  // Exact value of a single patch: the patch applied to the (merged) value of
  // its parents, or the snapshot text of a snapshot. Returns undefined if a
  // needed patch is missing. Computed iteratively, parents first.
  private exactValue(time: string): Document | undefined {
    const cached = this.exactCache.get(time);
    if (cached) return cached.doc;
    const computed = new globalThis.Map<string, Document>();
    const get = (t: string) => computed.get(t) ?? this.exactCache.get(t)?.doc;
    const order: string[] = [];
    const visited = new Set<string>();
    const stack: { t: string; expanded: boolean }[] = [{ t: time, expanded: false }];
    while (stack.length > 0) {
      const { t, expanded } = stack.pop()!;
      if (expanded) {
        order.push(t);
        continue;
      }
      if (visited.has(t) || this.exactCache.has(t)) continue;
      visited.add(t);
      const patch = this.patches.get(t);
      if (!patch) return undefined;
      stack.push({ t, expanded: true });
      if (patch.isSnapshot && patch.snapshot != null) continue;
      for (const parent of patch.parents ?? []) {
        if (!this.patches.has(parent)) return undefined;
        if (!visited.has(parent) && !this.exactCache.has(parent)) {
          stack.push({ t: parent, expanded: false });
        }
      }
    }
    for (const t of order) {
      const patch = this.patches.get(t)!;
      let doc: Document | undefined;
      if (patch.isSnapshot && patch.snapshot != null) {
        doc = this.codec.fromString(patch.snapshot);
      } else {
        const parents = patch.parents ?? [];
        let base: Document | undefined;
        if (parents.length === 0) {
          base = this.codec.fromString("");
        } else if (parents.length === 1) {
          base = get(parents[0]) ?? this.exactValue(parents[0]);
        } else {
          base = this.exactValueOfSet(parents, get);
        }
        if (base == null) return undefined;
        doc = patch.patch != null ? this.codec.applyPatch(base, patch.patch) : base;
      }
      computed.set(t, doc);
      this.exactCache.set(t, { doc });
    }
    return get(time);
  }

  // Exact merged value of a set of patches (heads or a merge patch's parents):
  // fold them in time order, merging each into the accumulated value with
  // merge3 from the value of their maximal common ancestors.
  private exactValueOfSet(
    times: string[],
    get: (t: string) => Document | undefined = () => undefined,
  ): Document | undefined {
    const sorted = this.sortHeads(Array.from(new Set(times)));
    if (sorted.length === 1) return get(sorted[0]) ?? this.exactValue(sorted[0]);
    const key = sorted.join(",");
    const cached = this.exactMergeCache.get(key);
    if (cached) return cached.doc;
    const merge3 = this.codec.merge3!;
    let acc = get(sorted[0]) ?? this.exactValue(sorted[0]);
    if (acc == null) return undefined;
    let accTimes = [sorted[0]];
    for (const t of sorted.slice(1)) {
      const value = get(t) ?? this.exactValue(t);
      if (value == null) return undefined;
      const merge = this.mergeBase(accTimes, t);
      if (merge == null) return undefined;
      acc = merge3(merge.base, acc, value, merge.ancestors);
      accTimes = [...accTimes, t];
    }
    this.exactMergeCache.set(key, { doc: acc });
    return acc;
  }

  // Value of the maximal common ancestors of two sides, or the empty document
  // if both sides go back to independent roots. Undefined if the loaded history
  // does not reach a common ancestor.
  private mergeBase(
    sideA: string[],
    t: string,
  ): { base: Document; ancestors?: Document[] } | undefined {
    const found = this.commonAncestors(sideA, [t]) ?? this.commonAncestorsFull(sideA, [t]);
    if (found == null) return undefined;
    const { maximal, complete } = found;
    if (maximal.length === 0) {
      // Merging against an empty base when history is merely truncated would
      // duplicate everything; only do it for genuinely independent roots.
      return complete ? { base: this.codec.fromString("") } : undefined;
    }
    const base = this.exactValueOfSet(maximal);
    if (base == null) return undefined;
    if (maximal.length === 1) return { base };
    const ancestors: Document[] = [];
    for (const time of maximal) {
      const value = this.exactValue(time);
      if (value == null) return undefined;
      ancestors.push(value);
    }
    return { base, ancestors };
  }

  // Maximal common ancestors of two sides, found like git's merge-base: walk
  // back from both sides newest first, marking which sides reach each patch,
  // until everything left to visit is below a common ancestor. The cost depends
  // on how far back the sides diverged, not on the length of the history.
  // Relies on every patch being newer than its parents (Session guarantees
  // this); returns undefined if that does not hold, so the caller falls back.
  private commonAncestors(
    sideA: string[],
    sideB: string[],
  ): { maximal: string[]; complete: boolean } | undefined {
    const A = 1;
    const B = 2;
    const STALE = 4;
    const flags = new globalThis.Map<string, number>();
    const popped = new Set<string>();
    const queue: string[] = []; // ascending by time; the newest is popped first
    const push = (time: string, flag: number): boolean => {
      const old = flags.get(time) ?? 0;
      const next = old | flag;
      if (next === old) return true;
      if (popped.has(time)) return false; // reached after it was processed
      flags.set(time, next);
      if (old === 0) {
        let lo = 0;
        let hi = queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (comparePatchId(queue[mid], time) < 0) lo = mid + 1;
          else hi = mid;
        }
        queue.splice(lo, 0, time);
      }
      return true;
    };
    for (const time of sideA) push(time, A);
    for (const time of sideB) push(time, B);
    const maximal: string[] = [];
    let complete = true;
    while (queue.some((time) => !((flags.get(time) ?? 0) & STALE))) {
      const time = queue.pop()!;
      popped.add(time);
      let flag = flags.get(time)!;
      if ((flag & (A | B)) === (A | B) && !(flag & STALE)) {
        maximal.push(time);
        flag |= STALE;
        flags.set(time, flag);
      }
      const patch = this.patches.get(time);
      if (!patch) {
        if (!(flag & STALE)) complete = false;
        continue;
      }
      for (const parent of patch.parents ?? []) {
        if (comparePatchId(parent, time) >= 0) return undefined;
        if (!push(parent, flag)) return undefined;
      }
    }
    return { maximal, complete };
  }

  // Same result by comparing full ancestries; used when patch times are not
  // ordered parent before child.
  private commonAncestorsFull(
    sideA: string[],
    sideB: string[],
  ): { maximal: string[]; complete: boolean } | undefined {
    const a = this.ancestry(sideA);
    const b = this.ancestry(sideB);
    if (a == null || b == null) return undefined;
    const common = new Set<string>();
    for (const x of a.times) if (b.times.has(x)) common.add(x);
    const maximal = Array.from(common).filter(
      (c) => !Array.from(this.children.get(c) ?? []).some((kid) => common.has(kid)),
    );
    return { maximal, complete: a.complete && b.complete };
  }

  // All ancestors (including the given times) present in the graph, and whether
  // the traversal reached only true roots (no missing parents).
  private ancestry(times: string[]): { times: Set<string>; complete: boolean } | undefined {
    const seen = new Set<string>();
    let complete = true;
    const stack = [...times];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      const patch = this.patches.get(t);
      if (!patch) {
        complete = false;
        continue;
      }
      seen.add(t);
      for (const p of patch.parents ?? []) stack.push(p);
    }
    return { times: seen, complete };
  }

  private sortHeads(headTimes: string[]): string[] {
    return [...headTimes].sort(comparePatchId);
  }

  private newestCommonAncestor(a: Set<string>, b: Set<string>): string | undefined {
    let best: string | undefined;
    for (const t of a) {
      if (!b.has(t)) continue;
      if (best === undefined || comparePatchId(t, best) > 0) {
        best = t;
      }
    }
    return best;
  }

  private knownTimes(heads: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...heads];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      const patch = this.patches.get(t);
      if (!patch) continue;
      seen.add(t);
      if ((patch.parents?.length ?? 0) > 0 && !patch.isSnapshot) {
        for (const p of patch.parents ?? []) {
          stack.push(p);
        }
      }
    }
    return seen;
  }

  private latestSnapshot(times: string[]): Patch | undefined {
    let best: Patch | undefined;
    for (const t of times) {
      const p = this.patches.get(t);
      if (p?.isSnapshot && p.snapshot != null) {
        if (!best || comparePatchId(p.time, best.time) > 0) {
          best = p;
        }
      }
    }
    return best;
  }

  private dedupFileLoads(ordered: Patch[]): void {
    if (ordered.length < 2) return;
    let last: Patch | undefined;
    for (let i = 0; i < ordered.length; i++) {
      const patch = ordered[i];
      if (!patch.file) {
        last = patch;
        continue;
      }
      if (
        last &&
        last.file &&
        last.patch &&
        patch.patch &&
        decodePatchId(patch.time).timeMs - decodePatchId(last.time).timeMs <=
          this.fileTimeDedupTolerance &&
        List<unknown>(patch.patch as unknown[]).equals(List<unknown>(last.patch as unknown[]))
      ) {
        ordered.splice(i, 1);
        i -= 1;
        continue;
      }
      last = patch;
    }
  }

  history(opts: { start?: string; end?: string; includeSnapshots?: boolean } = {}): Patch[] {
    const { start, end, includeSnapshots = true } = opts;
    return this.patches
      .toArray()
      .map(([, patch]) => patch)
      .filter((p) => {
        if (start != null && comparePatchId(p.time, start) < 0) return false;
        if (end != null && comparePatchId(p.time, end) > 0) return false;
        return true;
      })
      .filter((p) => includeSnapshots || !p.isSnapshot)
      .sort(patchCmp);
  }
}
