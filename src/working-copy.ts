import type { Document } from "./types";

/**
 * Rebase a draft document onto a newer base by applying the diff between
 * the previous base and the draft to the updated base.
 */
export function rebaseDraft<T extends Document>({
  base,
  draft,
  updatedBase,
}: {
  base: T;
  draft: T;
  updatedBase: T;
}): T {
  // If nothing changed in the draft relative to the old base, just adopt the new base.
  if (draft.isEqual(base)) {
    return updatedBase;
  }
  // If the new base already matches the draft, skip rebasing to avoid double-applying.
  if (draft.isEqual(updatedBase)) {
    return updatedBase;
  }
  // For string-like documents, use a true three-way merge to avoid duplicate application.
  const baseStr = (base as any).toString?.();
  const draftStr = (draft as any).toString?.();
  const updatedStr = (updatedBase as any).toString?.();
  if (
    typeof baseStr === "string" &&
    typeof draftStr === "string" &&
    typeof updatedStr === "string"
  ) {
    const { threeWayMerge } = require("./dmp") as typeof import("./dmp");
    const merged = threeWayMerge({ base: baseStr, local: draftStr, remote: updatedStr });
    const setter =
      (updatedBase as any).set ??
      ((x: string) => {
        const Ctor = (updatedBase as any).constructor;
        return new Ctor(x);
      });
    try {
      return setter.call(updatedBase, merged) as T;
    } catch {
      // fall through to patch-based rebase
    }
  }

  const delta = base.makePatch(draft);
  const rebased = updatedBase.applyPatch(delta) as T;

  return rebased;
}
