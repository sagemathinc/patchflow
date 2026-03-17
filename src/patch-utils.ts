export function isEmptyPatch(patch: unknown): boolean {
  if (patch == null) return true;
  if (
    Array.isArray(patch) &&
    patch.length === 2 &&
    typeof patch[0] === "number" &&
    Array.isArray(patch[1])
  ) {
    return patch[1].length === 0;
  }
  if (Array.isArray(patch) || typeof (patch as any).length === "number") {
    return Number((patch as any).length) === 0;
  }
  if (typeof (patch as any).size === "number") {
    return Number((patch as any).size) === 0;
  }
  if (typeof (patch as any).byteLength === "number") {
    return Number((patch as any).byteLength) === 0;
  }
  return false;
}
