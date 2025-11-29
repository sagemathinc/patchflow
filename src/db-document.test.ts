import { Map as ImMap } from "immutable";
import { createDbCodec } from "./db-document-immutable";
import { createImmerDbCodec } from "./db-document-immer";
import type { JsMap } from "./db-util";
import type { DocCodec } from "./types";

type Backend = {
  name: string;
  codec: () => DocCodec;
};

const backends: Backend[] = [
  { name: "immutable", codec: () => createDbCodec({ primaryKeys: ["id"], stringCols: ["body"] }) },
  { name: "immer", codec: () => createImmerDbCodec({ primaryKeys: ["id"], stringCols: ["body"] }) },
];

type TestDoc = {
  set(value: unknown): TestDoc;
  get(where?: unknown): unknown;
  getOne(where?: unknown): unknown;
  makePatch(other: unknown): unknown;
  applyPatch(patch: unknown): TestDoc;
  delete(where?: unknown): TestDoc;
  count(): number;
  toString(): string;
  isEqual(other: unknown): boolean;
};

const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const maybeList = value as { toArray?: () => unknown[] } | undefined;
  if (maybeList?.toArray) {
    return maybeList.toArray();
  }
  return [];
};

const getField = (record: unknown, key: string): unknown => {
  if (ImMap.isMap(record)) return (record as ImMap<string, unknown>).get(key);
  return (record as JsMap | undefined)?.[key];
};

const toPlain = (record: unknown): JsMap | undefined => {
  if (record == null) return undefined;
  if (ImMap.isMap(record)) return (record as ImMap<string, unknown>).toJS() as JsMap;
  return record as JsMap;
};

describe.each(backends)("%s DbDocument", ({ codec }) => {
  const newDoc = (): TestDoc => codec().fromString("") as unknown as TestDoc;

  it("inserts records and queries by primary key", () => {
    const empty = newDoc();
    const doc = empty.set({ id: 1, title: "a" } as JsMap);
    expect(doc.count()).toBe(1);
    const record = asArray(doc.get({ id: 1 }))[0];
    expect(getField(record, "title")).toBe("a");
  });

  it("creates string patches for string columns and applies them", () => {
    const empty = newDoc();
    const base = empty.set({ id: 1, body: "hello" } as JsMap);
    const next = base.set({ id: 1, body: "1hello2" } as JsMap);
    const patch = base.makePatch(next);
    const updated = base.applyPatch(patch);
    const body = getField(updated.getOne({ id: 1 }), "body");
    expect(body).toBe("1hello2");
    const addPayload = (patch as unknown[]).find((p) => Array.isArray(p)) as JsMap[] | undefined;
    expect(addPayload).toBeDefined();
    expect(JSON.stringify(addPayload)).toContain("hello");
  });

  it("supports deletes and preserves other rows", () => {
    const empty = newDoc();
    const doc = empty.set([
      { id: 1, body: "one" },
      { id: 2, body: "two" },
    ] as JsMap[]);
    const afterDelete = doc.delete({ id: 1 });
    expect(afterDelete.count()).toBe(1);
    expect(asArray(afterDelete.get({})).length).toBe(1);
    const remaining = afterDelete.getOne({ id: 2 });
    expect(getField(remaining, "body")).toBe("two");
  });

  it("round-trips through string serialization", () => {
    const empty = newDoc();
    const doc = empty.set([
      { id: 2, body: "b" },
      { id: 1, body: "a" },
    ] as JsMap[]);
    const serialized = doc.toString();
    const parsedDoc = codec().fromString(serialized) as unknown as TestDoc;
    expect(parsedDoc.isEqual(doc)).toBe(true);
    expect(parsedDoc.count()).toBe(2);
  });

  it("merges map fields via merge patches", () => {
    const empty = newDoc();
    const base = empty.set({ id: 1, meta: { a: 1, b: 2 } } as JsMap);
    const next = base.set({ id: 1, meta: { a: 1, b: null, c: 3 } } as JsMap);
    const patch = base.makePatch(next);
    const updated = base.applyPatch(patch);
    const meta = getField(updated.getOne({ id: 1 }), "meta");
    expect(toPlain(meta)).toEqual({ a: 1, c: 3 });
  });
});
