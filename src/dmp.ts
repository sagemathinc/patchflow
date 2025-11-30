import { DiffMatchPatch, PatchObject } from "@cocalc/diff-match-patch";

export type CompressedPatch = [[-1 | 0 | 1, string][], number, number, number, number][];

const dmp = new DiffMatchPatch();
dmp.diffTimeout = 0.2;

export const diffMain = dmp.diff_main.bind(dmp);
export const patchMake = dmp.patch_make.bind(dmp);

export function compressPatch(patch: PatchObject[]): CompressedPatch {
  return patch.map((p) => [p.diffs, p.start1, p.start2, p.length1, p.length2]);
}

export function decompressPatch(patch: CompressedPatch): PatchObject[] {
  return patch.map((p) => {
    const obj = new PatchObject();
    obj.diffs = p[0].map(([op, text]) => [op, text]);
    obj.start1 = p[1];
    obj.start2 = p[2];
    obj.length1 = p[3];
    obj.length2 = p[4];
    return obj;
  });
}

export function makePatch(s0: string, s1: string): CompressedPatch {
  return compressPatch(dmp.patch_make(s0, s1));
}

export function applyPatch(patch: CompressedPatch, s: string): [string, boolean] {
  let result;
  try {
    result = dmp.patch_apply(decompressPatch(patch), s);
  } catch (err) {
    return [s, false];
  }
  const clean = result[1].every(Boolean);
  return [result[0], clean];
}

// Diff3-style merge: given a common ancestor (base) and two descendants (local, remote),
// weave the edits deterministically:
// - Keep identical changes once.
// - Prefer local when both touch the same span differently (no conflict markers).
// - Apply unique inserts from each side at their base positions.
// - Drop segments deleted by local or remote.
// This avoids duplicate application and produces a single merged string suitable for
// realtime collaboration without manual conflict resolution.
export function threeWayMerge(opts: { base: string; local: string; remote: string }): string {
  const { base, local, remote } = opts;
  // Fast paths
  if (local === remote) return local;
  if (base === remote) return local;
  if (base === local) return remote;

  type Edit = { start: number; end: number; text: string; type: "insert" | "delete" };

  const diffToEdits = (
    diffs: [number, string][],
  ): {
    inserts: Map<number, string[]>;
    deletes: Edit[];
  } => {
    let pos = 0;
    const inserts = new Map<number, string[]>();
    const deletes: Edit[] = [];
    for (const [op, text] of diffs) {
      const len = text.length;
      if (op === 0) {
        pos += len;
      } else if (op === -1) {
        deletes.push({ start: pos, end: pos + len, text, type: "delete" });
        pos += len;
      } else if (op === 1) {
        const arr = inserts.get(pos) ?? [];
        arr.push(text);
        inserts.set(pos, arr);
      }
    }
    return { inserts, deletes };
  };

  const localEdits = diffToEdits(dmp.diff_main(base, local));
  const remoteEdits = diffToEdits(dmp.diff_main(base, remote));

  // Boundaries to slice base into unaffected segments
  const boundaries = new Set<number>([0, base.length]);
  for (const e of [...localEdits.deletes, ...remoteEdits.deletes]) {
    boundaries.add(e.start);
    boundaries.add(e.end);
  }
  for (const pos of [...localEdits.inserts.keys(), ...remoteEdits.inserts.keys()]) {
    boundaries.add(pos);
  }
  const points = Array.from(boundaries).sort((a, b) => a - b);

  const hasDelete = (edits: Edit[], start: number, end: number): boolean =>
    edits.some((e) => e.start <= start && e.end >= end);

  const mergedPieces: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const pos = points[i];
    // Apply insertions at this boundary, preferring local; de-dupe identical remote inserts.
    const localIns = localEdits.inserts.get(pos) ?? [];
    const remoteIns = remoteEdits.inserts.get(pos) ?? [];
    if (localIns.length > 0) {
      mergedPieces.push(...localIns);
      for (const r of remoteIns) {
        if (!localIns.includes(r)) {
          mergedPieces.push(r);
        }
      }
    } else if (remoteIns.length > 0) {
      mergedPieces.push(...remoteIns);
    }

    if (i === points.length - 1) continue;
    const next = points[i + 1];
    const segment = base.slice(pos, next);
    const localDeleted = hasDelete(localEdits.deletes, pos, next);
    const remoteDeleted = hasDelete(remoteEdits.deletes, pos, next);

    if (localDeleted) {
      // prefer local: drop segment
      continue;
    }
    if (remoteDeleted) {
      continue;
    }
    mergedPieces.push(segment);
  }

  return mergedPieces.join("");
}
