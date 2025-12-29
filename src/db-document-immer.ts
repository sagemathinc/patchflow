/**
 * DbDocumentImmer is an immer-backed, indexed "JSONL table" document:
 * - Stores records as plain JS objects, using immer drafts for immutable updates.
 * - Each record is one JSON object; serialization is one object per line (order-insensitive).
 * - String columns can use diff-match-patch to merge concurrent edits efficiently.
 * - Map-valued fields merge via shallow patches (null deletes keys, values update).
 * - Patches use the legacy syncdb array form: [-1, deletes, 1, adds/updates].
 * - A codec factory wires primary keys + string columns into the patchflow DocCodec interface.
 */
import { produce, type Draft } from "immer";
import { applyPatch as applyStringPatch, makePatch as makeStringPatch } from "./dmp";
import type { CompressedPatch } from "./dmp";
import {
  deepEqual,
  isArray,
  isObject,
  len,
  mapMergePatch,
  toKey,
  toStr,
  type JsMap,
} from "./db-util";
import type { DocCodec, Document } from "./types";

type DbRecord = JsMap | undefined;
type Index = Map<string, Set<number>>;
type Indexes = Map<string, Index>;
export type DbPatch = Array<-1 | 1 | JsMap[]>;

export type WhereCondition = Record<string, unknown>;
export type SetCondition = WhereCondition;

export class DbDocumentImmer implements Document {
  private readonly primaryKeys: Set<string>;
  private readonly stringCols: Set<string>;
  private readonly records: DbRecord[];
  private readonly indexes: Indexes;
  private readonly size: number;
  private toStrCache?: string;

  // Build a new document with primary keys, string columns, and optional prebuilt state.
  constructor(
    primaryKeys: Set<string>,
    stringCols: Set<string>,
    records: DbRecord[] = [],
    indexes?: Indexes,
    size?: number,
  ) {
    if (primaryKeys.size === 0) {
      throw new Error("DbDocumentImmer requires at least one primary key");
    }
    this.primaryKeys = new Set(primaryKeys);
    this.stringCols = new Set(stringCols);
    this.records = records;
    if (indexes && size !== undefined) {
      this.indexes = indexes;
      this.size = size;
    } else {
      const { indexes: built, size: computed } = this.rebuildIndexes(records);
      this.indexes = built;
      this.size = computed;
    }
  }

  // Serialize the document as sorted JSONL.
  public toString(): string {
    if (this.toStrCache != null) return this.toStrCache;
    const obj = this.get({}) as JsMap[];
    this.toStrCache = toStr(obj);
    return this.toStrCache;
  }

  // Check equality by primary-key/value contents.
  public isEqual(other?: DbDocumentImmer): boolean {
    if (!other) return false;
    if (this === other) return true;
    if (this.size !== other.size) return false;
    const thisMap = this.primaryKeyMap();
    const otherMap = other.primaryKeyMap();
    if (thisMap.size !== otherMap.size) return false;
    for (const [pk, rec] of thisMap.entries()) {
      const o = otherMap.get(pk);
      if (!o || !deepEqual(rec, o)) return false;
    }
    return true;
  }

  // Apply an array patch to produce a new document.
  public applyPatch(patch: unknown): DbDocumentImmer {
    if (!Array.isArray(patch)) {
      throw new Error("DbPatch must be an array");
    }
    return this.applyPatchBatch([patch]);
  }

  // Apply a batch of patches in one pass, updating indexes incrementally.
  public applyPatchBatch(patches: unknown[]): DbDocumentImmer {
    if (patches.length === 0) return this;
    const nextRecords: DbRecord[] = this.records.slice();
    const nextIndexes = this.cloneIndexes(this.indexes);
    let nextSize = this.size;

    const removeFromIndexes = (record: JsMap, idx: number): void => {
      for (const field of this.primaryKeys) {
        const val = record[field];
        if (val == null) continue;
        const key = toKey(val);
        const index = nextIndexes.get(field);
        if (!index) continue;
        const set = index.get(key);
        if (!set) continue;
        set.delete(idx);
        if (set.size === 0) {
          index.delete(key);
        }
      }
    };

    const addToIndexes = (record: JsMap, idx: number): void => {
      for (const field of this.primaryKeys) {
        const val = record[field];
        if (val == null) continue;
        const key = toKey(val);
        let index = nextIndexes.get(field);
        if (!index) {
          index = new Map();
          nextIndexes.set(field, index);
        }
        const set = index.get(key) ?? new Set<number>();
        set.add(idx);
        index.set(key, set);
      }
    };

    const selectWithIndexes = (where: WhereCondition): Set<number> => {
      const n = len(where as JsMap);
      let result: Set<number> | undefined;
      for (const field in where) {
        const value = where[field];
        const index = nextIndexes.get(field);
        if (!index) {
          throw new Error(`field '${field}' must be a primary key`);
        }
        const matches = index.get(toKey(value));
        if (!matches) return new Set();
        if (n === 1) return new Set(matches);
        result = result ? this.intersect(result, matches) : new Set(matches);
      }
      if (!result) {
        result = new Set();
        nextRecords.forEach((rec, idx) => {
          if (rec) result!.add(idx);
        });
      }
      return result;
    };

    const applyDelete = (payload?: JsMap[]): void => {
      if (!payload || payload.length === 0) return;
      for (const where of payload as WhereCondition[]) {
        if (!isObject(where)) {
          throw new Error("DbDocumentImmer.delete expects an object or array of objects");
        }
        const matches = selectWithIndexes(where as WhereCondition);
        for (const idx of matches) {
          const rec = nextRecords[idx];
          if (!rec) continue;
          removeFromIndexes(rec, idx);
          nextRecords[idx] = undefined;
          nextSize -= 1;
        }
      }
    };

    const applySetBatch = (payload?: JsMap[]): void => {
      if (!payload || payload.length === 0) return;
      for (const obj of payload as SetCondition[]) {
        if (!isObject(obj)) {
          throw new Error("DbDocumentImmer.set expects an object or array of objects");
        }
        const { where, set } = this.parse(obj as JsMap);
        const matches = selectWithIndexes(where);
        if (matches.size > 0) {
          for (const idx of matches) {
            const current = nextRecords[idx];
            if (!current) continue;
            const next = this.applySet(current, set);
            if (next === current) continue;
            if (this.primaryKeys.size > 0) {
              for (const field of this.primaryKeys) {
                const oldVal = current[field];
                const newVal = next[field];
                if (!deepEqual(oldVal, newVal)) {
                  if (oldVal != null) {
                    const index = nextIndexes.get(field);
                    const set0 = index?.get(toKey(oldVal));
                    if (set0) {
                      set0.delete(idx);
                      if (set0.size === 0) index?.delete(toKey(oldVal));
                    }
                  }
                  if (newVal != null) {
                    let index = nextIndexes.get(field);
                    if (!index) {
                      index = new Map();
                      nextIndexes.set(field, index);
                    }
                    const set1 = index.get(toKey(newVal)) ?? new Set<number>();
                    set1.add(idx);
                    index.set(toKey(newVal), set1);
                  }
                }
              }
            }
            nextRecords[idx] = next;
          }
          continue;
        }
        // Insert
        const insertObj: JsMap = { ...obj };
        for (const field of this.stringCols) {
          if (insertObj[field] != null && isArray(insertObj[field])) {
            delete insertObj[field];
          }
        }
        this.stripNulls(insertObj);
        const idx = nextRecords.length;
        nextRecords.push(insertObj);
        nextSize += 1;
        addToIndexes(insertObj, idx);
      }
    };

    for (const patch of patches) {
      if (!Array.isArray(patch)) {
        throw new Error("DbPatch must be an array");
      }
      for (let i = 0; i < patch.length; i += 2) {
        const op = patch[i];
        const payload = patch[i + 1] as JsMap[] | undefined;
        if (op === -1) {
          applyDelete(payload);
        } else if (op === 1) {
          applySetBatch(payload);
        }
      }
    }

    return new DbDocumentImmer(
      this.primaryKeys,
      this.stringCols,
      nextRecords,
      nextIndexes,
      nextSize,
    );
  }

  // Compute a patch from this document to another.
  public makePatch(other: DbDocumentImmer): DbPatch {
    if (other.size === 0) {
      return [-1, [{}]];
    }
    const thisMap = this.primaryKeyMap();
    const otherMap = other.primaryKeyMap();

    const deletes: JsMap[] = [];
    const adds: JsMap[] = [];
    const changes: JsMap[] = [];

    for (const [pk, record] of thisMap.entries()) {
      if (!otherMap.has(pk)) {
        deletes.push(this.primaryKeyPart(record));
      }
    }

    for (const [pk, record] of otherMap.entries()) {
      const from = thisMap.get(pk);
      if (!from) {
        adds.push(record);
        continue;
      }
      const diff = this.diffRecord(from, record);
      if (diff) {
        changes.push(diff);
      }
    }

    const patch: DbPatch = [];
    if (deletes.length > 0) {
      patch.push(-1, deletes);
    }
    if (adds.length > 0 || changes.length > 0) {
      patch.push(1, [...adds, ...changes]);
    }
    return patch;
  }

  // Insert or update records matching a where clause.
  public set(obj: unknown): DbDocumentImmer {
    if (Array.isArray(obj)) {
      return (obj as SetCondition[]).reduce<DbDocumentImmer>((acc, x) => acc.set(x), this);
    }
    if (!isObject(obj)) {
      throw new Error("DbDocumentImmer.set expects an object or array of objects");
    }
    const { where, set } = this.parse(obj as JsMap);
    const matches = this.select(where);
    if (matches.size > 0) {
      const nextRecords = produce<DbRecord[]>(this.records, (draft: Draft<DbRecord[]>) => {
        for (const idx of matches) {
          const current = draft[idx];
          if (!current) continue;
          draft[idx] = this.applySet(current, set);
        }
      });
      return this.withRecords(nextRecords);
    }
    // Insert
    const insertObj: JsMap = { ...obj };
    for (const field of this.stringCols) {
      if (insertObj[field] != null && isArray(insertObj[field])) {
        delete insertObj[field];
      }
    }
    this.stripNulls(insertObj);
    const nextRecords = [...this.records, insertObj];
    return this.withRecords(nextRecords);
  }

  // Delete records matching a where clause.
  public delete(where?: unknown): DbDocumentImmer {
    if (Array.isArray(where)) {
      return (where as WhereCondition[]).reduce<DbDocumentImmer>((acc, x) => acc.delete(x), this);
    }
    const cond = where ?? {};
    if (!isObject(cond)) {
      throw new Error("DbDocumentImmer.delete expects an object or array of objects");
    }
    const matches = this.select(cond as WhereCondition);
    if (matches.size === 0) return this;
    const nextRecords = produce<DbRecord[]>(this.records, (draft: Draft<DbRecord[]>) => {
      for (const idx of matches) {
        draft[idx] = undefined;
      }
    });
    return this.withRecords(nextRecords);
  }

  // Return all records matching a where clause.
  public get(where: unknown = {}): JsMap[] {
    const matches = this.select(isObject(where) ? (where as WhereCondition) : {});
    const results: JsMap[] = [];
    for (const idx of matches) {
      const rec = this.records[idx];
      if (rec) {
        results.push(rec);
      }
    }
    return results;
  }

  // Return first record matching a where clause.
  public getOne(where: unknown = {}): JsMap | undefined {
    const matches = this.select(isObject(where) ? (where as WhereCondition) : {});
    const first = Math.min(...matches);
    if (!Number.isFinite(first)) return undefined;
    return this.records[first];
  }

  // Report primary-key changes relative to another document.
  public changes(prev?: DbDocumentImmer): Set<JsMap> {
    if (!prev) {
      return new Set(this.get({}));
    }
    const currentMap = this.primaryKeyMap();
    const prevMap = prev.primaryKeyMap();
    const changed = new Set<JsMap>();
    for (const [pk, rec] of currentMap.entries()) {
      const prevRec = prevMap.get(pk);
      if (!prevRec || !deepEqual(prevRec, rec)) {
        changed.add(this.primaryKeyPart(rec));
      }
    }
    for (const [pk, rec] of prevMap.entries()) {
      if (!currentMap.has(pk)) {
        changed.add(this.primaryKeyPart(rec));
      }
    }
    return changed;
  }

  // Count defined records.
  public count(): number {
    return this.size;
  }

  // Replace underlying records and rebuild indexes.
  private withRecords(records: DbRecord[]): DbDocumentImmer {
    const { indexes, size } = this.rebuildIndexes(records);
    return new DbDocumentImmer(this.primaryKeys, this.stringCols, records, indexes, size);
  }

  // Deep-clone indexes so we can mutate them safely in batch operations.
  private cloneIndexes(indexes: Indexes): Indexes {
    const next: Indexes = new Map();
    for (const [field, index] of indexes.entries()) {
      const nextIndex: Index = new Map();
      for (const [key, set] of index.entries()) {
        nextIndex.set(key, new Set(set));
      }
      next.set(field, nextIndex);
    }
    return next;
  }

  // Build indexes and size from a record array.
  private rebuildIndexes(records: DbRecord[]): { indexes: Indexes; size: number } {
    const indexes: Indexes = new Map();
    for (const field of this.primaryKeys) {
      indexes.set(field, new Map());
    }
    let size = 0;
    records.forEach((rec, idx) => {
      if (!rec) return;
      size += 1;
      for (const field of this.primaryKeys) {
        const val = rec[field];
        if (val == null) continue;
        const k = toKey(val);
        const index = indexes.get(field)!;
        const set = index.get(k) ?? new Set<number>();
        set.add(idx);
        index.set(k, set);
      }
    });
    return { indexes, size };
  }

  // Select matching record indices via primary-key index.
  private select(where: WhereCondition): Set<number> {
    const n = len(where as JsMap);
    let result: Set<number> | undefined;
    for (const field in where) {
      const value = where[field];
      const index = this.indexes.get(field);
      if (!index) {
        throw new Error(`field '${field}' must be a primary key`);
      }
      const matches = index.get(toKey(value));
      if (!matches) return new Set();
      if (n === 1) return new Set(matches);
      result = result ? this.intersect(result, matches) : new Set(matches);
    }
    if (!result) {
      // empty where -> everything
      result = new Set();
      this.records.forEach((rec, idx) => {
        if (rec) result!.add(idx);
      });
    }
    return result;
  }

  // Intersect two index sets.
  private intersect(a: Set<number>, b: Set<number>): Set<number> {
    const out = new Set<number>();
    for (const x of a) {
      if (b.has(x)) out.add(x);
    }
    return out;
  }

  // Split an object into where (PK) and set parts.
  private parse(obj: JsMap): { where: JsMap; set: JsMap } {
    const where: JsMap = {};
    const set: JsMap = {};
    for (const field in obj) {
      const val = obj[field];
      if (this.primaryKeys.has(field)) {
        if (val != null) {
          where[field] = val;
        }
      } else {
        set[field] = val;
      }
    }
    return { where, set };
  }

  // Apply a set payload to a record, handling strings and map merges.
  private applySet(current: JsMap, set: JsMap): JsMap {
    return produce<JsMap>(current, (draft: Draft<JsMap>) => {
      for (const field in set) {
        const value = set[field];
        if (value === null) {
          delete draft[field];
          continue;
        }
        if (this.stringCols.has(field)) {
          if (isArray(value)) {
            const next = applyStringPatch(
              value as CompressedPatch,
              (draft[field] as string) ?? "",
            )[0];
            draft[field] = next;
            continue;
          }
          if (typeof value !== "string") {
            throw new Error(`'${field}' must be a string`);
          }
        }
        if (isObject(draft[field]) && isObject(value)) {
          draft[field] = this.mergeObject(draft[field] as JsMap, value as JsMap);
        } else {
          draft[field] = value;
        }
      }
    });
  }

  // Extract only primary key fields from a record.
  private primaryKeyPart(x: JsMap): JsMap {
    const where: JsMap = {};
    for (const k of Object.keys(x)) {
      if (this.primaryKeys.has(k)) {
        where[k] = x[k];
      }
    }
    return where;
  }

  // Build a map from primary-key JSON to record content.
  private primaryKeyMap(): Map<string, JsMap> {
    const map = new Map<string, JsMap>();
    this.records.forEach((rec) => {
      if (!rec) return;
      const key = toKey(this.primaryKeyPart(rec));
      map.set(key, rec);
    });
    return map;
  }

  // Compute a per-record diff for patch generation.
  private diffRecord(from: JsMap, to: JsMap): JsMap | undefined {
    const obj = this.primaryKeyPart(to);
    let changed = false;

    for (const key in from) {
      if (!Object.prototype.hasOwnProperty.call(to, key)) {
        obj[key] = null;
        changed = true;
      }
    }
    for (const key in to) {
      const v = to[key];
      const prev = from[key];
      if (deepEqual(prev, v)) continue;
      if (this.stringCols.has(key) && prev != null && v != null) {
        if (typeof prev === "string" && typeof v === "string") {
          obj[key] = makeStringPatch(prev, v);
          changed = true;
        }
      } else if (isObject(prev) && isObject(v)) {
        obj[key] = mapMergePatch(prev as JsMap, v as JsMap);
        changed = true;
      } else {
        obj[key] = v;
        changed = true;
      }
    }
    return changed ? obj : undefined;
  }

  // Remove null-valued fields in-place.
  private stripNulls(obj: JsMap): void {
    for (const key of Object.keys(obj)) {
      if (obj[key] === null) {
        delete obj[key];
      }
    }
  }

  // Merge two map-like objects, treating null as delete.
  private mergeObject(base: JsMap, change: JsMap): JsMap {
    return produce<JsMap>(base, (draft: Draft<JsMap>) => {
      for (const key of Object.keys(change)) {
        const val = change[key];
        if (val === null || val === undefined) {
          delete draft[key];
        } else {
          draft[key] = val;
        }
      }
    });
  }
}

export const createImmerDbCodec = (opts: {
  primaryKeys: string[];
  stringCols?: string[];
}): DocCodec => {
  const pk = new Set(opts.primaryKeys);
  const stringCols = new Set(opts.stringCols ?? []);
  return {
    fromString: (text: string) => fromString(text, pk, stringCols),
    toString: (doc: Document) => (doc as DbDocumentImmer).toString(),
    applyPatch: (doc: Document, patch: unknown) => (doc as DbDocumentImmer).applyPatch(patch),
    applyPatchBatch: (doc: Document, patches: unknown[]) => {
      return (doc as DbDocumentImmer).applyPatchBatch(patches);
    },
    makePatch: (a: Document, b: Document) => (a as DbDocumentImmer).makePatch(b as DbDocumentImmer),
  };
};

export function fromString(
  s: string,
  primaryKeys: Set<string>,
  stringCols: Set<string>,
): DbDocumentImmer {
  const obj: JsMap[] = [];
  for (const line of s.split("\n")) {
    if (line.length === 0) continue;
    try {
      const x = JSON.parse(line);
      if (typeof x === "object") {
        obj.push(x as JsMap);
      } else {
        throw new Error("each line must be an object");
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`CORRUPT db-doc string: ${e} -- skipping '${line}'`);
    }
  }
  return new DbDocumentImmer(primaryKeys, stringCols, obj);
}
