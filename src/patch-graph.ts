import { List, Map } from "immutable";
import { LRUCache } from "lru-cache";
import { comparePatchId, decodePatchId } from "./patch-id";
import type {
  DocCodec,
  Document,
  Inconsistency,
  MergeStrategy,
  Patch,
  PatchGraphValueOptions,
} from "./types";
import { hashString, sameHashFormat } from "./value-hash";

type PatchMap = Map<string, Patch>;

const DEFAULT_DEDUP_TOLERANCE = 3000;
const DEFAULT_VALUE_CACHE_MAX_ENTRIES = 100;
const DEFAULT_VALUE_CACHE_MAX_SIZE = 10_000_000;
const DEFAULT_EXACT_CACHE_MAX_ENTRIES = 2000;
// Bound on the total size (see docSize) of cached exact values: a long history
// of a large text would otherwise keep thousands of full copies of it.
const DEFAULT_EXACT_CACHE_MAX_SIZE = 10_000_000;
const RECENT_EXACT_ENTRIES = 8;

export type PatchGraphOptions = {
  codec: DocCodec;
  mergeStrategy?: MergeStrategy;
  valueCacheMaxEntries?: number;
  valueCacheMaxSize?: number;
  exactCacheMaxEntries?: number;
  exactCacheMaxSize?: number;
  // Called when an exact value does not match the hash its author recorded
  // (Patch.hash): this client and the author disagree about the document.
  // Values computed by the apply-all fallback are approximations and are not
  // checked.
  onInconsistency?: (inconsistency: Inconsistency) => void;
};

// Size of a cached exact value: characters of a text, records of a database
// document. Not doc.size(), which estimates a database document's JSONL text:
// cached versions of one share their unchanged records, so that would count
// each about a thousand times over and leave room for only a few dozen
// values, fewer than merging a wide concurrent history needs.
function docSize(value: { doc: Document }): number {
  const doc = value?.doc as any;
  const size = doc?.count?.() ?? doc?.size?.();
  return Number.isFinite(size) && size > 0 ? Math.ceil(size) : 1;
}

// Keep `doc` as the most recent entry of a small insertion-ordered map.
function remember(map: globalThis.Map<string, Document>, key: string, doc: Document): void {
  map.delete(key);
  map.set(key, doc);
  if (map.size > RECENT_EXACT_ENTRIES) map.delete(map.keys().next().value!);
}

function isRoot(patch: Patch): boolean {
  return (patch.parents ?? []).length === 0 && !(patch.isSnapshot && patch.snapshot != null);
}

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
  // Heads and patches waiting on a missing parent, until the graph changes.
  private headsCache?: string[];
  private rootKnownCache?: boolean;
  private completeFromStart = false;
  private oldestCache?: string;
  // The most recently requested exact values, kept even when a document is
  // too large for the size-bounded cache, so the current value is never
  // recomputed from far back.
  private recentExact = new globalThis.Map<string, Document>();
  // Likewise the most recent merged values of patch sets (e.g. concurrent heads).
  private recentMerged = new globalThis.Map<string, Document>();
  // Values requested during the outermost exact computation (see pinExact).
  // The size bounded caches can evict a value while a merge of a wide
  // criss-cross history still needs it; recomputing it there repeats the
  // whole merge recursion below it, which grows exponentially.
  private pinnedExact?: globalThis.Map<string, Document>;
  private pinnedMerged?: globalThis.Map<string, Document>;
  private waitingCache?: Set<string>;
  // Incremented whenever the graph changes in a way that can change values:
  // new patches, or a snapshot record upgraded with its patch (see add).
  private revisionCount = 0;
  private unavailableCache?: { revision: number; value: boolean };
  private onInconsistency?: (inconsistency: Inconsistency) => void;
  // Patches whose value has been checked against their hash: true if it
  // matched. A value is checked once, the first time it is computed.
  private hashChecked = new globalThis.Map<string, boolean>();
  // Snapshots checked against their patch's hash (the text and the hash of a
  // snapshot never change), and the inconsistencies reported.
  private snapshotOk = new globalThis.Map<string, boolean>();
  private reported = new Set<string>();

  constructor(opts: PatchGraphOptions) {
    this.codec = opts.codec;
    this.onInconsistency = opts.onInconsistency;
    const exactMax = opts.exactCacheMaxEntries ?? DEFAULT_EXACT_CACHE_MAX_ENTRIES;
    const exactMaxSize = opts.exactCacheMaxSize ?? DEFAULT_EXACT_CACHE_MAX_SIZE;
    const exactOpts = { max: exactMax, maxSize: exactMaxSize, sizeCalculation: docSize };
    this.exactCache = new LRUCache<string, { doc: Document }>(exactOpts);
    this.exactMergeCache = new LRUCache<string, { doc: Document }>(exactOpts);
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
          this.waitingCache = undefined;
          this.headsCache = undefined;
          this.patches = this.patches.set(patch.time, {
            ...existing,
            isSnapshot: true,
            snapshot: patch.snapshot,
            seqInfo: patch.seqInfo ?? existing.seqInfo,
          });
        } else if (
          existing.isSnapshot &&
          existing.patch == null &&
          !patch.isSnapshot &&
          patch.patch != null
        ) {
          // A snapshot record carries only the value, not the parents: a client
          // that loaded the document from a snapshot and then loads older history
          // gets the patch itself here. Without its parents the snapshotted patch
          // looks like a root, and merges whose common ancestor is below it
          // (concurrent work) would merge from an empty base, duplicating the
          // whole document.
          const upgraded: Patch = {
            ...patch,
            parents: patch.parents ?? [],
            isSnapshot: true,
            snapshot: existing.snapshot,
            seqInfo: existing.seqInfo ?? patch.seqInfo,
          };
          this.patches = this.patches.set(patch.time, upgraded);
          for (const parent of upgraded.parents ?? []) {
            const kids = this.children.get(parent) ?? new Set<string>();
            kids.add(upgraded.time);
            this.children = this.children.set(parent, kids);
          }
          this.clearExactCaches();
          this.headsCache = undefined;
          this.waitingCache = undefined;
          this.oldestCache = undefined;
          this.reachabilityCache.clear();
          this.mergeCache.clear();
          this.versionsCache = undefined;
          // Not a new patch, so add() does not return it, but values change.
          this.revisionCount++;
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
    this.revisionCount++;
    this.updateHeadsAndWaiting(added);
    // Any structural change invalidates cached reachability/versions/merges.
    this.reachabilityCache.clear();
    this.mergeCache.clear();
    this.versionsCache = undefined;
    return added;
  }

  // Changes whenever values may have changed (see revisionCount); a caller
  // holding a value computed from the graph recomputes it when this changes,
  // even if add() returned no new patches.
  revision(): number {
    return this.revisionCount;
  }

  // Update the cached heads and waiting patches for newly added patches, or
  // drop them to be recomputed. The common case, a new patch on top of known
  // history, is a cheap update rather than a scan of the whole history.
  private updateHeadsAndWaiting(added: Patch[]): void {
    // A patch whose children are already known fills a gap: recompute.
    const fillsGap = added.some((patch) =>
      Array.from(this.children.get(patch.time) ?? []).some((kid) => this.patches.has(kid)),
    );
    if (fillsGap) {
      this.headsCache = undefined;
      this.waitingCache = undefined;
      this.oldestCache = undefined;
      return;
    }
    if (this.headsCache != null) {
      const heads = new Set(this.headsCache);
      for (const patch of added) heads.add(patch.time);
      for (const patch of added) {
        for (const parent of patch.parents ?? []) heads.delete(parent);
      }
      this.headsCache = Array.from(heads).sort(comparePatchId);
    }
    const oldest = this.oldestCache;
    if (
      this.waitingCache == null ||
      oldest == null ||
      this.rootKnownCache == null ||
      added.some((patch) => comparePatchId(patch.time, oldest) <= 0 || isRoot(patch))
    ) {
      // An older patch changes which missing parents count as gaps.
      this.waitingCache = undefined;
      this.oldestCache = undefined;
      return;
    }
    // In time order, so a patch sees whether its parents in this batch wait.
    for (const patch of added.slice().sort(patchCmp)) {
      if (patch.isSnapshot && patch.snapshot != null) continue;
      const waits = (patch.parents ?? []).some(
        (parent) =>
          this.waitingCache!.has(parent) || this.isGap(parent, oldest, this.rootKnownCache!),
      );
      if (waits) this.waitingCache.add(patch.time);
    }
  }

  // Whether the loaded history is not enough for the exact value: a patch is
  // held back waiting for a missing parent, or the value depends on a patch
  // that is not loaded. The latter happens to a document loaded from a
  // snapshot when patches made concurrently with the snapshotted patch were
  // appended to the stream before it: they are neither in the snapshot's value
  // nor loaded, and later patches build on them. value() then falls back to
  // applying all loaded patches in time order, which can differ from what
  // clients with the full history see, so the caller should load more
  // history (e.g. back to the previous snapshot) while this is true.
  needsMoreHistory(): boolean {
    if (this.codec.merge3 == null || this.mergeStrategy === "apply-all") return false;
    if (this.patches.size === 0) return false;
    const waiting = this.waitingPatches();
    if (waiting.size > 0) {
      // Only waiting patches the current heads depend on matter; one below a
      // loaded snapshot is covered by it.
      const seen = new Set<string>();
      const stack = this.getHeads();
      while (stack.length > 0) {
        const t = stack.pop()!;
        if (seen.has(t)) continue;
        seen.add(t);
        const patch = this.patches.get(t);
        if (patch == null || waiting.has(t)) return true;
        if (patch.isSnapshot && patch.snapshot != null) continue;
        stack.push(...(patch.parents ?? []));
      }
    }
    const heads = this.getValueHeads();
    return heads.length > 0 && this.exactValueOfSet(heads) == null;
  }

  // Whether every other loaded patch is an ancestor or a descendant of
  // `time`. A snapshot at such a patch is a clean cut of the history: a client
  // that loads the snapshot and the patches after it can compute exact values
  // without older history (see needsMoreHistory), unless a patch made before
  // the snapshot is appended later (e.g. by a client that was offline).
  isCut(time: string): boolean {
    if (!this.patches.has(time)) return false;
    const related = new Set<string>();
    const walk = (start: string, next: (t: string) => Iterable<string>) => {
      const stack = [start];
      while (stack.length > 0) {
        const t = stack.pop()!;
        if (related.has(t) && t !== start) continue;
        related.add(t);
        for (const u of next(t)) if (this.patches.has(u) && !related.has(u)) stack.push(u);
      }
    };
    // Ancestry continues through snapshots: a snapshot ends reconstructing a
    // value, not the ancestor relation.
    walk(time, (t) => this.patches.get(t)!.parents ?? []);
    walk(time, (t) => this.children.get(t) ?? []);
    return related.size === this.patches.size;
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
    // Everything can be waiting only when the history is known to be complete
    // from the start (see isGap); then the value is that of no patches yet.
    return settled.sort(comparePatchId);
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

  // The caller knows it has every patch from the start of the history (e.g.
  // it began with an empty history and receives the stream in full): then a
  // missing parent has not arrived yet, even before the first patch has.
  markCompleteFromStart(): void {
    if (this.completeFromStart) return;
    this.completeFromStart = true;
    this.waitingCache = undefined;
    this.oldestCache = undefined;
  }

  // Whether a parent is missing from inside the loaded history. With the
  // first patch (a root) loaded, the history is complete from the start, so
  // any missing parent has not arrived yet. Otherwise (history loaded from a
  // snapshot) only a missing parent newer than all loaded history is a gap; an
  // older one may be below the loaded range.
  private isGap(parent: string, oldest: string, rootKnown: boolean): boolean {
    if (this.patches.has(parent)) return false;
    return rootKnown || comparePatchId(parent, oldest) > 0;
  }

  // Patches below a gap in the loaded history, with their descendants. A
  // valid snapshot is self-contained, so waiting stops there.
  private waitingPatches(): Set<string> {
    if (this.waitingCache == null) this.waitingCache = this.computeWaitingPatches();
    return this.waitingCache;
  }

  private computeWaitingPatches(): Set<string> {
    let oldest: string | undefined;
    let rootKnown = false;
    this.patches.forEach((patch, time) => {
      if (oldest === undefined || comparePatchId(time, oldest) < 0) oldest = time;
      if (isRoot(patch)) rootKnown = true;
    });
    if (this.completeFromStart) rootKnown = true;
    this.oldestCache = oldest;
    this.rootKnownCache = rootKnown;
    const stack: string[] = [];
    this.patches.forEach((patch, time) => {
      if (patch.isSnapshot && patch.snapshot != null) return;
      const gap = (patch.parents ?? []).some((parent) => this.isGap(parent, oldest!, rootKnown));
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
    if (this.headsCache == null) this.headsCache = this.computeHeads();
    return this.headsCache.slice();
  }

  private computeHeads(): string[] {
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

  // Hash of a value (see value-hash.ts).
  hashOf(doc: Document): string {
    if (this.codec.hash) return this.codec.hash(doc);
    if (typeof doc.hash === "function") return doc.hash();
    return hashString(this.codec.toString(doc));
  }

  // The exact merged value of a set of patches (e.g. the parents of a new
  // patch), or undefined if it cannot be computed from the loaded history or
  // the graph does not compute exact values.
  exactValueOf(times: string[]): Document | undefined {
    if (this.codec.merge3 == null || this.mergeStrategy === "apply-all") return undefined;
    if (times.length === 0) return this.codec.fromString("");
    return this.exactValueOfSet(times);
  }

  // Whether this client's exact value of a patch matches the hash its author
  // recorded: "ok", "mismatch" (also reported to onInconsistency), or
  // "unknown" if the patch has no hash or the exact value cannot be computed.
  verifyValue(time: string): "ok" | "mismatch" | "unknown" {
    const patch = this.patches.get(time);
    if (patch?.hash == null) return "unknown";
    const doc = this.exactValueOf([time]);
    if (doc == null) return "unknown";
    const ok = this.checkHash(patch, doc);
    return ok == null ? "unknown" : ok ? "ok" : "mismatch";
  }

  // Compare a computed value with the patch's hash, once per patch; report a
  // mismatch. Undefined if there is nothing to compare.
  private checkHash(patch: Patch, doc: Document): boolean | undefined {
    const expected = patch.hash;
    if (expected == null) return undefined;
    const known = this.hashChecked.get(patch.time);
    if (known != null) return known;
    const actual = this.hashOf(doc);
    if (!sameHashFormat(expected, actual)) return undefined;
    const ok = actual === expected;
    this.hashChecked.set(patch.time, ok);
    if (!ok)
      this.report({ kind: "patch", time: patch.time, expected, actual, userId: patch.userId });
    return ok;
  }

  // Whether exact values start from this patch's snapshot text: "use" (a
  // snapshot whose text matches its patch's hash, or that cannot be checked),
  // "bad" (it does not match: reported, and values are computed from the patch
  // itself instead), or "none" (not a snapshot).
  private snapshotState(patch: Patch): "use" | "bad" | "none" {
    if (!(patch.isSnapshot && patch.snapshot != null)) return "none";
    const expected = patch.hash;
    if (expected == null) return "use";
    let ok = this.snapshotOk.get(patch.time);
    if (ok == null) {
      const actual = this.hashOf(this.codec.fromString(patch.snapshot));
      if (!sameHashFormat(expected, actual)) return "use";
      ok = actual === expected;
      this.snapshotOk.set(patch.time, ok);
      if (!ok) {
        // Values computed before (e.g. by the apply-all fallback) may have
        // started from it.
        this.valueCache.clear();
        this.mergeCache.clear();
        this.report({ kind: "snapshot", time: patch.time, expected, actual, userId: patch.userId });
      }
    }
    return ok ? "use" : "bad";
  }

  // Whether the value depends on a snapshot that differs from its patch's
  // value and that patch's exact value cannot be computed yet, because the
  // patch or one of its ancestors is not loaded: then no trustworthy value is
  // known (value() is a best-effort view without that snapshot) until more
  // history is loaded (needsMoreHistory() is true). Session refuses to commit
  // and to write the value to a file then.
  valueUnavailable(): boolean {
    if (this.unavailableCache?.revision === this.revisionCount) {
      return this.unavailableCache.value;
    }
    let value = false;
    // Patches below a rejected snapshot are needed to compute its value; other
    // missing patches are merely below the loaded history.
    const seen = new globalThis.Map<string, boolean>();
    const stack = this.getValueHeads().map((t) => ({ t, needed: false }));
    while (stack.length > 0 && !value) {
      const { t, needed } = stack.pop()!;
      const before = seen.get(t);
      if (before === true || (before === false && !needed)) continue;
      seen.set(t, needed);
      const patch = this.patches.get(t);
      if (patch == null) {
        if (needed) value = true;
        continue;
      }
      const state = this.snapshotState(patch);
      if (state === "use") continue;
      if (state === "bad" && patch.patch == null) {
        value = true;
        continue;
      }
      const below = needed || state === "bad";
      for (const parent of patch.parents ?? []) stack.push({ t: parent, needed: below });
    }
    this.unavailableCache = { revision: this.revisionCount, value };
    return value;
  }

  // Report an inconsistency once.
  private report(inconsistency: Inconsistency): void {
    const key = `${inconsistency.kind}:${inconsistency.time}:${inconsistency.actual}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.onInconsistency?.(inconsistency);
  }

  private clearExactCaches(): void {
    this.hashChecked.clear();
    this.exactCache.clear();
    this.exactMergeCache.clear();
    this.recentExact.clear();
    this.recentMerged.clear();
  }

  // Exact value of a single patch: the patch applied to the (merged) value of
  // its parents, or the snapshot text of a snapshot. Returns undefined if a
  // needed patch is missing. Computed iteratively, parents first.
  private exactValue(time: string): Document | undefined {
    return this.pinExact(() => this.computeExactValue(time));
  }

  // Run an exact computation, keeping every value it requests from
  // exactValue and exactValueOfSet until the outermost one returns, so each
  // is computed at most once per computation whatever the cache limits.
  // Intermediate values of a single exactValue walk are not pinned: they are
  // released as the walk proceeds, so a long history is not held at once.
  private pinExact<T>(f: () => T): T {
    if (this.pinnedExact != null) return f();
    this.pinnedExact = new globalThis.Map();
    this.pinnedMerged = new globalThis.Map();
    try {
      return f();
    } finally {
      this.pinnedExact = undefined;
      this.pinnedMerged = undefined;
    }
  }

  private computeExactValue(time: string): Document | undefined {
    // A requested value is checked against its hash even when it was
    // computed earlier as an intermediate value, which is not checked.
    const hit =
      this.pinnedExact?.get(time) ?? this.recentExact.get(time) ?? this.exactCache.get(time)?.doc;
    if (hit) {
      const patch = this.patches.get(time);
      if (patch != null && this.snapshotState(patch) !== "use") this.checkHash(patch, hit);
      return hit;
    }
    // Values computed (or found in the cache) during this call. A value is
    // released as soon as the patches that need it have been computed, so a
    // long history does not hold every intermediate value at once; the size
    // bounded cache keeps the recent ones.
    const computed = new globalThis.Map<string, Document>();
    const uses = new globalThis.Map<string, number>([[time, 1]]);
    const get = (t: string) =>
      computed.get(t) ??
      this.pinnedExact?.get(t) ??
      this.recentExact.get(t) ??
      this.exactCache.get(t)?.doc;
    const order: string[] = [];
    const visited = new Set<string>();
    const stack: { t: string; expanded: boolean }[] = [{ t: time, expanded: false }];
    while (stack.length > 0) {
      const { t, expanded } = stack.pop()!;
      if (expanded) {
        order.push(t);
        continue;
      }
      if (visited.has(t)) continue;
      visited.add(t);
      const hit =
        this.pinnedExact?.get(t) ?? this.recentExact.get(t) ?? this.exactCache.get(t)?.doc;
      if (hit) {
        computed.set(t, hit);
        continue;
      }
      const patch = this.patches.get(t);
      if (!patch) return undefined;
      stack.push({ t, expanded: true });
      const snapshot = this.snapshotState(patch);
      if (snapshot === "use") continue;
      // A snapshot that differs from its patch's value is not used: the value
      // is computed from the patch itself, which needs its parents; if the
      // patch is not loaded, the exact value is unknown until more history is
      // (see needsMoreHistory).
      if (snapshot === "bad" && patch.patch == null) return undefined;
      for (const parent of patch.parents ?? []) {
        if (!this.patches.has(parent)) return undefined;
        uses.set(parent, (uses.get(parent) ?? 0) + 1);
        if (!visited.has(parent)) stack.push({ t: parent, expanded: false });
      }
    }
    const release = (t: string) => {
      const n = (uses.get(t) ?? 1) - 1;
      uses.set(t, n);
      if (n <= 0) computed.delete(t);
    };
    for (const t of order) {
      const patch = this.patches.get(t)!;
      let doc: Document | undefined;
      const useSnapshot = this.snapshotState(patch) === "use";
      const parents = useSnapshot ? [] : (patch.parents ?? []);
      if (useSnapshot) {
        doc = this.codec.fromString(patch.snapshot!);
      } else {
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
      // Check the requested value. (Intermediate values are checked when they
      // are requested themselves, e.g. as heads, to keep loading cheap; a
      // snapshot's text is checked before it is used, see snapshotState.)
      if (t === time && !useSnapshot) this.checkHash(patch, doc);
      for (const parent of parents) release(parent);
    }
    const doc = get(time);
    if (doc != null) {
      remember(this.recentExact, time, doc);
      this.pinnedExact?.set(time, doc);
    }
    return doc;
  }

  // Exact merged value of a set of patches (heads or a merge patch's parents):
  // fold them in time order, merging each into the accumulated value with
  // merge3 from the value of their maximal common ancestors.
  private exactValueOfSet(
    times: string[],
    get: (t: string) => Document | undefined = () => undefined,
  ): Document | undefined {
    return this.pinExact(() => this.computeExactValueOfSet(times, get));
  }

  private computeExactValueOfSet(
    times: string[],
    get: (t: string) => Document | undefined,
  ): Document | undefined {
    const sorted = this.sortHeads(Array.from(new Set(times)));
    if (sorted.length === 1) return get(sorted[0]) ?? this.exactValue(sorted[0]);
    const key = sorted.join(",");
    const pinned = this.pinnedMerged?.get(key);
    if (pinned) return pinned;
    const recent = this.recentMerged.get(key);
    if (recent) {
      this.pinnedMerged?.set(key, recent);
      return recent;
    }
    const cached = this.exactMergeCache.get(key);
    if (cached) {
      this.pinnedMerged?.set(key, cached.doc);
      return cached.doc;
    }
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
    remember(this.recentMerged, key, acc);
    this.pinnedMerged?.set(key, acc);
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
      // Never start from a snapshot that differs from its patch's value.
      if (p != null && this.snapshotState(p) === "use") {
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
