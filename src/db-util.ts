import { Map as ImMap } from "immutable";

export type JsMap = Record<string, unknown>;

export function toKey(value: unknown): string {
  if (ImMap.isMap(value)) {
    value = value.toJS();
  }
  return stableStringify(value);
}

export function toStr(objs: JsMap[]): string {
  const lines = objs.map((x) => stableStringify(x));
  lines.sort();
  return lines.join("\n");
}

export function mapMergePatch(obj1: JsMap, obj2: JsMap): JsMap {
  const change: JsMap = {};
  for (const key of Object.keys(obj1)) {
    const val1 = obj1[key];
    const val2 = obj2[key];
    if (deepEqual(val1, val2)) continue;
    change[key] = val2 == null ? null : val2;
  }
  for (const key of Object.keys(obj2)) {
    if (obj1[key] != null) continue;
    change[key] = obj2[key];
  }
  return change;
}

export function mergeSet(
  obj: ImMap<string, unknown>,
  change: ImMap<string, unknown>,
): ImMap<string, unknown> {
  change.forEach((v, k) => {
    if (v === null || v == null) {
      obj = obj.delete(k);
    } else {
      obj = obj.set(k, v);
    }
  });
  return obj;
}

export function nonnullCols(f: ImMap<string, unknown>): ImMap<string, unknown> {
  return ImMap(f.filter((v) => v !== null));
}

export function isArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export function copyWithout<T extends JsMap>(obj: T, field: string): T {
  const clone: JsMap = { ...obj };
  delete clone[field];
  return clone as T;
}

export function len(obj?: JsMap): number {
  if (!obj) return 0;
  return Object.keys(obj).length;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) {
        return null;
      }
      seen.add(obj);
      if (Array.isArray(obj)) {
        return obj.map(normalize);
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        out[key] = normalize(obj[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value)) ?? "";
}
