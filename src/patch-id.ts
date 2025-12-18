export type PatchId = string;

// We represent PatchId as `${time36}_${clientId}` where:
// - time36 is base36-encoded milliseconds since epoch, left-padded to TIME36_WIDTH
//   so lexicographic order matches numeric time order.
// - clientId is an opaque per-client identifier (often base64url of random bytes).
//
// The underscore delimiter is safe because we decode by fixed width rather than splitting:
// base64url clientIds may include '_' characters.
const TIME36_WIDTH = 11;
const DELIM = "_";

export function encodePatchId(timeMs: number, clientId: string): PatchId {
  if (!Number.isFinite(timeMs)) {
    throw new Error(`timeMs must be finite, got ${timeMs}`);
  }
  if (timeMs < 0) {
    throw new Error(`timeMs must be >= 0, got ${timeMs}`);
  }
  if (!clientId) {
    throw new Error("clientId must be non-empty");
  }
  const time = Math.floor(timeMs);
  const time36 = time.toString(36).padStart(TIME36_WIDTH, "0");
  return `${time36}${DELIM}${clientId}`;
}

export function decodePatchId(id: PatchId): { timeMs: number; clientId: string } {
  if (typeof id !== "string") {
    throw new Error("PatchId must be a string");
  }
  const minLen = TIME36_WIDTH + 2; // time + delim + at least 1 char clientId
  if (id.length < minLen) {
    throw new Error(`Invalid PatchId (too short): ${id}`);
  }
  const time36 = id.slice(0, TIME36_WIDTH);
  const delim = id.slice(TIME36_WIDTH, TIME36_WIDTH + 1);
  if (delim !== DELIM) {
    throw new Error(`Invalid PatchId delimiter: ${id}`);
  }
  const clientId = id.slice(TIME36_WIDTH + 1);
  if (!clientId) {
    throw new Error(`Invalid PatchId clientId: ${id}`);
  }
  const timeMs = Number.parseInt(time36, 36);
  if (!Number.isFinite(timeMs) || Number.isNaN(timeMs) || timeMs < 0) {
    throw new Error(`Invalid PatchId time: ${id}`);
  }
  return { timeMs, clientId };
}

export function legacyPatchId(timeMs: number): PatchId {
  return encodePatchId(timeMs, "legacy");
}

export function comparePatchId(a: PatchId, b: PatchId): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
