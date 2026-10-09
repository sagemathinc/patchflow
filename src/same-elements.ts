// Element-by-element equality of two patches' contents, exactly as
// immutable.js's List(a).equals(List(b)) decided it, without importing
// immutable (so that the immer documents do not bundle it).  Internal: not
// exported from the package root.

// immutable.js's `is`: SameValueZero, then valueOf() (Dates, boxed values),
// then value objects (anything with equals() and hashCode(), such as
// immutable collections).
export function immutableIs(a: unknown, b: unknown): boolean {
  if (a === b || (a !== a && b !== b)) return true;
  if (!a || !b) return false;
  let x = a as {
    valueOf?: () => unknown;
    equals?: (o: unknown) => boolean;
    hashCode?: () => number;
  };
  let y = b as typeof x;
  if (typeof x.valueOf === "function" && typeof y.valueOf === "function") {
    const va = x.valueOf();
    const vb = y.valueOf();
    if (va === vb || (va !== va && vb !== vb)) return true;
    if (!va || !vb) return false;
    x = va as typeof x;
    y = vb as typeof y;
  }
  return (
    !!x &&
    !!y &&
    typeof x.equals === "function" &&
    typeof x.hashCode === "function" &&
    typeof y.equals === "function" &&
    typeof y.hashCode === "function" &&
    !!x.equals(y)
  );
}

// What List() makes of a value: an array's (or array-like's, strings
// included) elements; null for anything else (where List() would throw).
function elements(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split("");
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { length?: unknown }).length === "number"
  ) {
    return Array.prototype.slice.call(value);
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
