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
  if (draft.isEqual(base)) {
    return updatedBase;
  }
  const delta = base.makePatch(draft);
  return updatedBase.applyPatch(delta) as T;
}
