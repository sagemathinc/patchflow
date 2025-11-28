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

export function threeWayMerge(opts: { base: string; local: string; remote: string }): string {
  if (opts.base === opts.remote) {
    return opts.local;
  }
  return dmp.patch_apply(dmp.patch_make(opts.base, opts.remote), opts.local)[0];
}
