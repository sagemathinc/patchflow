import { List, Map } from "immutable";
import type { DocCodec, Document, Patch, PatchGraphValueOptions } from "./types";

type PatchMap = Map<number, Patch>;

const DEFAULT_DEDUP_TOLERANCE = 3000;

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

  constructor(opts: { codec: DocCodec }) {
    this.codec = opts.codec;
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

  versions(): number[] {
    return this.patches
      .toArray()
      .map(([, patch]) => patch.time)
      .sort((a, b) => a - b);
  }

  version(time: number): Document {
    if (!this.patches.has(time)) {
      throw new Error(`unknown time: ${time}`);
    }
    return this.value({ time });
  }

  value(opts: PatchGraphValueOptions = {}): Document {
    const without = new Set<number>(opts.withoutTimes ?? []);
    const headTimes = opts.time != null ? [opts.time] : this.getHeads();
    if (headTimes.length === 0) {
      return this.codec.fromString("");
    }
    const reachable = this.knownTimes(headTimes);
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

    const ordered = Array.from(reachable.values())
      .filter((t) => t > floor)
      .map((t) => this.patches.get(t)!)
      .sort(patchCmp);

    // dedup file-load patches that are identical and close in time
    this.dedupFileLoads(ordered);

    for (const patch of ordered) {
      if (!patch.patch) continue;
      doc = this.codec.applyPatch(doc, patch.patch);
    }
    return doc;
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
      for (const p of patch.parents ?? []) {
        stack.push(p);
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
        List<unknown>(patch.patch as unknown[]).equals(List<unknown>(last.patch as unknown[]))
      ) {
        ordered.splice(i, 1);
        i -= 1;
        continue;
      }
      last = patch;
    }
  }
}
