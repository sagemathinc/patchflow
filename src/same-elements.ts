// Element-by-element equality of two patches' contents, exactly as
// immutable.js's List(a).equals(List(b)) decided it (immutable 4.3), without
// importing immutable (so that the immer documents do not bundle it).
// Internal: not exported from the package root.

type Any = Record<PropertyKey, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// immutable.js's `is`: SameValueZero, then valueOf() (Dates, boxed values),
// then value objects (anything with equals() and hashCode(), such as
// immutable collections).
export function immutableIs(a: unknown, b: unknown): boolean {
  if (a === b || (a !== a && b !== b)) return true;
  if (!a || !b) return false;
  let x = a as Any;
  let y = b as Any;
  if (typeof x.valueOf === "function" && typeof y.valueOf === "function") {
    x = x.valueOf();
    y = y.valueOf();
    if (x === y || (x !== x && y !== y)) return true;
    if (!x || !y) return false;
  }
  return (
    typeof x.equals === "function" &&
    typeof x.hashCode === "function" &&
    typeof y.equals === "function" &&
    typeof y.hashCode === "function" &&
    !!x.equals(y)
  );
}

// immutable.js's markers (what isList, isIndexed, ... check)
const has = (value: unknown, marker: string) => !!(value && (value as Any)[marker]);
const LIST = "@@__IMMUTABLE_LIST__@@";
const INDEXED = "@@__IMMUTABLE_INDEXED__@@";
const COLLECTION = "@@__IMMUTABLE_ITERABLE__@@";
const KEYED = "@@__IMMUTABLE_KEYED__@@";
const RECORD = "@@__IMMUTABLE_RECORD__@@";

// immutable.js's isArrayLike
function isArrayLike(value: unknown): boolean {
  if (Array.isArray(value) || typeof value === "string") return true;
  const v = value as Any;
  return (
    !!v &&
    typeof v === "object" &&
    Number.isInteger(v.length) &&
    v.length >= 0 &&
    (v.length === 0
      ? Object.keys(v).length === 1
      : Object.prototype.hasOwnProperty.call(v, v.length - 1))
  );
}

function iteratorFn(value: unknown): (() => Iterator<unknown>) | undefined {
  const v = value as Any;
  const f = v && ((typeof Symbol === "function" && v[Symbol.iterator]) || v["@@iterator"]);
  return typeof f === "function" ? f : undefined;
}

// The elements of List(value), in order: List() itself for immutable lists
// and indexed collections; a keyed collection's (or record's) entries;
// another collection's values; an array-like's indexed values (a string's
// UTF-16 units); an iterable's values.  null where List() throws (a value of
// none of these kinds): such patches are not equal.
function elements(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  const v = value as Any;
  if (has(v, LIST) || has(v, INDEXED)) return v.toArray();
  if (has(v, COLLECTION))
    return has(v, KEYED) ? v.entrySeq().toArray() : v.toIndexedSeq().toArray();
  if (has(v, RECORD)) return v.toSeq().entrySeq().toArray();
  if (isArrayLike(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) out.push(v[i]);
    return out;
  }
  const f = iteratorFn(v);
  if (f) {
    const it = f.call(v);
    const out: unknown[] = [];
    if (!it || typeof it.next !== "function") return out;
    for (let step = it.next(); !step.done; step = it.next()) out.push(step.value);
    return out;
  }
  return null;
}

export function sameElements(a: unknown, b: unknown): boolean {
  const x = elements(a);
  const y = elements(b);
  if (x == null || y == null || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (!immutableIs(x[i], y[i])) return false;
  return true;
}
