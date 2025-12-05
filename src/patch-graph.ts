import { List, Map } from "immutable";
import { LRUCache } from "lru-cache";
import type {
  DocCodec,
  Document,
  MergeStrategy,
  Patch,
  PatchGraphValueOptions,
} from "./types";

type PatchMap = Map<number, Patch>;

const DEFAULT_DEDUP_TOLERANCE = 3000;

// TOOD: make this easily configurable
const VALUE_CACHE_SIZE = 32;

function patchCmp(a: Patch, b: Patch): number {
  const av = a.version ?? 0;
  const bv = b.version ?? 0;
  const au = a.userId ?? 0;
  const bu = b.userId ?? 0;
  if (a.time !== b.time) return a.time - b.time;
  if (av !== bv) return av - bv;
  return au - bu;
}

export class PatchGraph {
  private patches: PatchMap = Map<number, Patch>();
  private children: Map<number, Set<number>> = Map<number, Set<number>>();
  private codec: DocCodec;
  public fileTimeDedupTolerance = DEFAULT_DEDUP_TOLERANCE;
  private mergeStrategy: MergeStrategy;
  // Cache single-head values keyed by patch time with a completeness count to avoid full replays.
  private valueCache = new LRUCache<number, { doc: Document; count: number }>({
    max: VALUE_CACHE_SIZE,
  });
  // Cache reachability/topo for single heads.
  private reachabilityCache = new globalThis.Map<
    number,
    { reachable: Set<number>; ordered: number[] }
  >();
  // Cache merged docs for multi-head evaluations with no exclusions.
  private mergeCache = new globalThis.Map<string, Document>();
  // Cache versions list.
  private versionsCache?: number[];

  constructor(opts: { codec: DocCodec; mergeStrategy?: MergeStrategy }) {
    this.codec = opts.codec;
    this.mergeStrategy = opts.mergeStrategy ?? "three-way";
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
        const kids = this.children.get(parent) ?? new Set<number>();
        kids.add(normalized.time);
        this.children = this.children.set(parent, kids);
      }
    }
    // Any structural change invalidates cached reachability/versions/merges.
    this.reachabilityCache.clear();
    this.mergeCache.clear();
    this.versionsCache = undefined;
  }

  getHeads(): number[] {
    const allTimes = new Set(this.patches.keySeq().toArray());
    const parents = new Set<number>();
    this.patches.forEach((patch) => {
      for (const p of patch.parents ?? []) {
        parents.add(p);
      }
    });
    for (const p of parents) {
      allTimes.delete(p);
    }
    return Array.from(allTimes.values()).sort((a, b) =>
      patchCmp(this.patches.get(a)!, this.patches.get(b)!),
    );
  }

  getPatch(time: number): Patch {
    const p = this.patches.get(time);
    if (!p) {
      throw new Error(`unknown time: ${time}`);
    }
    return p;
  }

  getParents(time: number): number[] {
    return [...(this.getPatch(time).parents ?? [])];
  }

  getAncestors(
    times: number | number[],
    opts: { includeSelf?: boolean; stopAtSnapshots?: boolean } = {},
  ): number[] {
    const includeSelf = opts.includeSelf ?? true;
    const stopAtSnapshots = opts.stopAtSnapshots ?? true;
    const seeds = Array.isArray(times) ? [...times] : [times];
    const seedSet = new Set(seeds);
    const stack = [...seeds];
    const visited = new Set<number>();
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
    return Array.from(visited.values()).sort((a, b) => a - b);
  }

  getParentChains(
    time: number,
    opts: { stopAtSnapshots?: boolean; limit?: number } = {},
  ): number[][] {
    const stopAtSnapshots = opts.stopAtSnapshots ?? true;
    const limit = opts.limit ?? 1000;
    const start = this.getPatch(time); // throws if missing
    const chains: number[][] = [];
    const stack: { node: Patch; path: number[] }[] = [
      { node: start, path: [time] },
    ];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      const parents = node.parents ?? [];
      const terminal =
        parents.length === 0 || (stopAtSnapshots && node.isSnapshot === true);
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

  versions(opts: { start?: number; end?: number } = {}): number[] {
    const { start = -Infinity, end = Infinity } = opts;
    if (this.versionsCache == null) {
      this.versionsCache = this.patches
        .toArray()
        .map(([, patch]) => patch.time)
        .sort((a, b) => a - b);
    }
    return this.versionsCache.filter((t) => t >= start && t <= end);
  }

  versionsInRange(opts: { start?: number; end?: number } = {}): number[] {
    const { start = -Infinity, end = Infinity } = opts;
    return this.versions().filter((t) => t >= start && t <= end);
  }

  version(time: number): Document {
    if (!this.patches.has(time)) {
      throw new Error(`unknown time: ${time}`);
    }
    return this.value({ time });
  }

  value(opts: PatchGraphValueOptions = {}): Document {
    if (opts.time != null && !this.patches.has(opts.time)) {
      throw new Error(`unknown time: ${opts.time}`);
    }
    const without = new Set<number>(opts.withoutTimes ?? []);
    const headTimes = opts.time != null ? [opts.time] : this.getHeads();
    if (headTimes.length === 0) {
      return this.codec.fromString("");
    }
    // Fast path: single head, no exclusions; reuse cached prefix if reachability unchanged.
    if (without.size === 0 && headTimes.length === 1) {
      const head = headTimes[0];
      const doc = this.applyAllValue([head], without, true);
      return doc;
    }

    if (headTimes.length > 1 && without.size === 0) {
      const key = headTimes
        .slice()
        .sort((a, b) => a - b)
        .join(",");
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
    headTimes: number[],
    without: Set<number>,
    useCache: boolean = false,
    allowMergeCache: boolean = false,
  ): Document {
    let reachable: Set<number>;
    let orderedTimes: number[] | undefined;
    if (useCache && headTimes.length === 1 && without.size === 0) {
      const cachedReach = this.reachabilityCache.get(headTimes[0]);
      if (cachedReach) {
        reachable = new Set(cachedReach.reachable);
        orderedTimes = cachedReach.ordered;
      } else {
        reachable = this.knownTimes(headTimes);
        orderedTimes = Array.from(reachable).sort((a, b) => a - b);
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
    let floor = -Infinity;
    if (snapshot) {
      floor = snapshot.time;
      doc = this.codec.fromString(snapshot.snapshot!);
    } else {
      doc = this.codec.fromString("");
    }

    const ordered = (orderedTimes ?? Array.from(reachable.values()))
      .filter((t) => t > floor)
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

    for (let i = startIndex; i < ordered.length; i++) {
      const patch = ordered[i];
      if (!patch.patch) continue;
      doc = this.codec.applyPatch(doc, patch.patch);
      if (useCache) {
        this.valueCache.set(patch.time, { doc, count: i + 1 });
      }
    }
    if (allowMergeCache && headTimes.length > 1 && without.size === 0) {
      const key = headTimes
        .slice()
        .sort((a, b) => a - b)
        .join(",");
      this.mergeCache.set(key, doc);
    }
    return doc;
  }

  private sortHeads(headTimes: number[]): number[] {
    return [...headTimes].sort((a, b) =>
      patchCmp(this.patches.get(a)!, this.patches.get(b)!),
    );
  }

  private newestCommonAncestor(
    a: Set<number>,
    b: Set<number>,
  ): number | undefined {
    let best: number | undefined;
    for (const t of a) {
      if (!b.has(t)) continue;
      if (best === undefined || t > best) {
        best = t;
      }
    }
    return best;
  }

  private knownTimes(heads: number[]): Set<number> {
    const seen = new Set<number>();
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

  private latestSnapshot(times: number[]): Patch | undefined {
    let best: Patch | undefined;
    for (const t of times) {
      const p = this.patches.get(t);
      if (p?.isSnapshot && p.snapshot != null) {
        if (!best || p.time > best.time) {
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
        patch.time - last.time <= this.fileTimeDedupTolerance &&
        List<unknown>(patch.patch as unknown[]).equals(
          List<unknown>(last.patch as unknown[]),
        )
      ) {
        ordered.splice(i, 1);
        i -= 1;
        continue;
      }
      last = patch;
    }
  }

  history(
    opts: { start?: number; end?: number; includeSnapshots?: boolean } = {},
  ): Patch[] {
    const { start = -Infinity, end = Infinity, includeSnapshots = true } = opts;
    return this.patches
      .toArray()
      .map(([, patch]) => patch)
      .filter((p) => p.time >= start && p.time <= end)
      .filter((p) => includeSnapshots || !p.isSnapshot)
      .sort(patchCmp);
  }
}
