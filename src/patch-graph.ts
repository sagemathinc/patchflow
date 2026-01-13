import { List, Map } from "immutable";
import { LRUCache } from "lru-cache";
import { comparePatchId, decodePatchId } from "./patch-id";
import type { DocCodec, Document, MergeStrategy, Patch, PatchGraphValueOptions } from "./types";

type PatchMap = Map<string, Patch>;

const DEFAULT_DEDUP_TOLERANCE = 3000;
const DEFAULT_VALUE_CACHE_MAX_ENTRIES = 100;
const DEFAULT_VALUE_CACHE_MAX_SIZE = 10_000_000;

export type PatchGraphOptions = {
  codec: DocCodec;
  mergeStrategy?: MergeStrategy;
  valueCacheMaxEntries?: number;
  valueCacheMaxSize?: number;
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

  constructor(opts: PatchGraphOptions) {
    this.codec = opts.codec;
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

  add(input: Patch[]): void {
    if (input.length === 0) return;
    for (const patch of input) {
      const existing = this.patches.get(patch.time);
      if (existing) {
        // merge in snapshot info if it arrives later
        if (patch.isSnapshot && patch.snapshot != null && !existing.snapshot) {
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
      this.patches = this.patches.set(normalized.time, normalized);
      for (const parent of normalized.parents ?? []) {
        const kids = this.children.get(parent) ?? new Set<string>();
        kids.add(normalized.time);
        this.children = this.children.set(parent, kids);
      }
    }
    // Any structural change invalidates cached reachability/versions/merges.
    this.reachabilityCache.clear();
    this.mergeCache.clear();
    this.versionsCache = undefined;
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
    const headTimes = opts.time != null ? [opts.time] : this.getHeads();
    if (headTimes.length === 0) {
      return this.codec.fromString("");
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
