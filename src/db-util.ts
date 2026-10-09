import jsonstable from "fast-json-stable-stringify";
import deepEqual from "fast-deep-equal/es6";
export { deepEqual };

export type JsMap = Record<string, unknown>;

// An immutable.js Map (or OrderedMap), recognized as Map.isMap does, without
// importing immutable: the immer documents never need it.
const IS_IMMUTABLE_MAP = "@@__IMMUTABLE_MAP__@@";
function isImmutableMap(value: unknown): value is { toJS(): unknown } {
  return (
    !!value && typeof value === "object" && !!(value as Record<string, unknown>)[IS_IMMUTABLE_MAP]
  );
}

export function toKey(value: unknown): string {
  if (isImmutableMap(value)) {
    value = value.toJS();
  }
  // must be stable, especially if value contains objects, which is technically allowed
  return jsonstable(value);
}

export function toStr(objs: JsMap[]): string {
  const lines = objs.map((x) => JSON.stringify(x));
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
