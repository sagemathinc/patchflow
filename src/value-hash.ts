/*
Hashes of document values, stored with each patch so that every client can
check that it computes the same value for the same history (see Patch.hash).

The formats are part of the stored history: never change what an existing
prefix means. A new algorithm needs a new prefix; hashes with a prefix a
client does not know are not compared (see sameHashFormat).
*/

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

// Two 32-bit lanes of a fast non-cryptographic hash of the UTF-16 code units
// of a string (cyrb53, extended to 64 bits).
function lanes(s: string): [number, number] {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

// Hash of a text value.
export function hashString(s: string): string {
  const [a, b] = lanes(s);
  return `s1:${hex(b)}${hex(a)}`;
}

// JSON with object keys sorted, so that equal records give the same text
// whatever order their keys were set in.
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (typeof (value as any).toJSON === "function") {
    return canonicalJson((value as any).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as object)
    .filter((k) => (value as any)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(",")}}`;
}

// Records are immutable, so each one is hashed once.
const recordLanes = new WeakMap<object, [number, number]>();

// Hash of a set of database records: the sum of the hashes of their
// canonical JSON, so it does not depend on the order of the records and
// unchanged records of a large document are not hashed again. `toJs` turns a
// record into plain JSON (e.g. an immutable.js Map's toJS).
export function hashRecords(
  records: Iterable<object | undefined | null>,
  toJs: (record: object) => unknown = (r) => r,
): string {
  let a = 0;
  let b = 0;
  let n = 0;
  for (const record of records) {
    if (record == null) continue;
    let h = recordLanes.get(record);
    if (h == null) {
      h = lanes(canonicalJson(toJs(record)));
      recordLanes.set(record, h);
    }
    a = (a + h[0]) >>> 0;
    b = (b + h[1]) >>> 0;
    n++;
  }
  return `d1:${n}:${hex(b)}${hex(a)}`;
}

// Whether two hashes were made with the same algorithm and can be compared.
export function sameHashFormat(a: string, b: string): boolean {
  return a.slice(0, a.indexOf(":") + 1) === b.slice(0, b.indexOf(":") + 1) && a.includes(":");
}
