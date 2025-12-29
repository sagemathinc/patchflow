/**
 * DbDocument is an immutable, indexed "JSONL table" document:
 * - Backed by immutable.js List/Map with a primary-key index for fast lookups.
 * - Each record is a JSON object; serialization is one JSON object per line (order-insensitive).
 * - String columns can be marked as diff/patch fields and will use diff-match-patch to compress
 *   and merge concurrent edits instead of last-write-wins.
 * - Map-valued fields merge via a shallow "patch" (null deletes keys, values update).
 * - Patches are compact array forms: [-1, deletes, 1, adds/updates], mirroring legacy syncdb.
 * - A codec factory wires primary keys + string columns into the patchflow DocCodec interface.
 */
import { List, Map as ImMap, Set as ImSet, fromJS } from "immutable";
import { applyPatch as applyStringPatch, makePatch as makeStringPatch } from "./dmp";
import type { CompressedPatch } from "./dmp";
import {
  copyWithout,
  deepEqual,
  isArray,
  isObject,
  len,
  mapMergePatch,
  mergeSet,
  nonnullCols,
  toKey,
  toStr,
  type JsMap,
} from "./db-util";
import type { DocCodec, Document } from "./types";

type RecordValue = ImMap<string, unknown> | undefined;
type Records = List<RecordValue>;
type Index = ImMap<string, ImSet<number>>;
type Indexes = ImMap<string, Index>;
export type DbPatch = Array<-1 | 1 | JsMap[]>;

export type WhereCondition = Record<string, unknown>;
export type SetCondition = ImMap<string, unknown> | WhereCondition;

type ChangeTracker = {
  changes: ImSet<ImMap<string, unknown>>;
  fromDb: DbDocument;
};

export class DbDocument implements Document {
  private primaryKeys: Set<string>;
  private stringCols: Set<string>;
  private records: Records;
  private everything: ImSet<number>;
  private indexes: Indexes;
  private changeTracker: ChangeTracker;
  public readonly size: number;
  private toStrCache?: string;

  // Build a document backed by immutable.js with optional precomputed state.
  constructor(
    primaryKeys: Set<string>,
    stringCols: Set<string>,
    records: Records = List(),
    everything?: ImSet<number>,
    indexes?: Indexes,
    changeTracker?: ChangeTracker,
  ) {
    if (primaryKeys.size === 0) {
      throw new Error("DbDocument requires at least one primary key");
    }
    this.primaryKeys = new Set(primaryKeys);
    this.stringCols = new Set(stringCols);
    this.records = records;
    this.everything = everything ?? this.initEverything();
    this.size = this.everything.size;
    this.indexes = indexes ?? this.initIndexes();
    this.changeTracker = changeTracker ?? this.initChangeTracker();
  }

  // Serialize as sorted JSONL.
  public toString(): string {
    if (this.toStrCache != null) {
      return this.toStrCache;
    }
    const obj = this.get({}).toJS() as JsMap[];
    this.toStrCache = toStr(obj);
    return this.toStrCache;
  }

  // Check equality by comparing record contents.
  public isEqual(other?: DbDocument): boolean {
    if (other == null) return false;
    if (this.records === other.records) return true;
    if (this.size !== other.size) return false;
    return ImSet(this.records).add(undefined).equals(ImSet(other.records).add(undefined));
  }

  // Apply an array patch to produce a new document.
  public applyPatch(patch: unknown): DbDocument {
    if (!Array.isArray(patch)) {
      throw new Error("DbPatch must be an array");
    }
    return patch.reduce<DbDocument>((acc, _, idx) => {
      if (idx % 2 === 1) return acc;
      const op = patch[idx];
      const payload = patch[idx + 1] as JsMap[] | undefined;
      if (op === -1) {
        return acc.delete(payload as WhereCondition[]);
      }
      if (op === 1) {
        return acc.set(payload as SetCondition[]);
      }
      return acc;
    }, this);
  }

  public applyPatchBatch(patches: unknown[]): DbDocument {
    let current: DbDocument = this;
    for (const patch of patches) {
      current = current.applyPatch(patch);
    }
    return current;
  }

  // Compute a patch from this document to another.
  public makePatch(other: DbDocument): DbPatch {
    if (other.size === 0) {
      return [-1, [{}]];
    }

    let t0 = ImSet(this.records);
    let t1 = ImSet(other.records);
    const common = t0.intersect(t1).add(undefined);
    t0 = t0.subtract(common);
    t1 = t1.subtract(common);

    if (t0.size === 0) {
      return [1, t1.toJS() as JsMap[]];
    }
    if (t1.size === 0) {
      const v: JsMap[] = [];
      t0.forEach((x) => {
        if (x != null) {
          v.push(this.primaryKeyPart(x.toJS() as JsMap));
        }
      });
      return [-1, v];
    }

    const k0 = ImSet(
      t0.filter((x): x is ImMap<string, unknown> => x != null).map(this.primaryKeyCols, this),
    );
    const k1 = ImSet(
      t1.filter((x): x is ImMap<string, unknown> => x != null).map(other.primaryKeyCols, other),
    );

    const add: JsMap[] = [];
    let remove: JsMap[] | undefined;

    const deletes = k0.subtract(k1);
    if (deletes.size > 0) {
      remove = deletes.toJS() as JsMap[];
    }

    const inserts = k1.subtract(k0);
    if (inserts.size > 0) {
      inserts.forEach((k) => {
        if (k != null) {
          const x = other.getOne(k.toJS() as JsMap);
          if (x != null) {
            add.push(x.toJS() as JsMap);
          }
        }
      });
    }

    const changed = k1.intersect(k0);
    if (changed.size > 0) {
      changed.forEach((k) => {
        if (k == null) return;
        const obj = k.toJS() as JsMap;
        const pk = this.primaryKeyPart(obj);
        const from0 = this.getOne(pk);
        const to0 = other.getOne(pk);
        if (from0 == null || to0 == null) return;
        const from = from0.toJS() as JsMap;
        const to = to0.toJS() as JsMap;

        for (const key in from) {
          if (to[key] == null) {
            obj[key] = null;
          }
        }
        for (const key in to) {
          const v = to[key];
          if (deepEqual(from[key], v)) continue;
          if (this.stringCols.has(key) && from[key] != null && v != null) {
            if (typeof from[key] === "string" && typeof v === "string") {
              obj[key] = makeStringPatch(from[key] as string, v as string);
            }
          } else if (isObject(from[key]) && isObject(v)) {
            obj[key] = mapMergePatch(from[key] as JsMap, v as JsMap);
          } else {
            obj[key] = v;
          }
        }
        add.push(obj);
      });
    }

    const patch: DbPatch = [];
    if (remove != null) {
      patch.push(-1, remove);
    }
    if (add.length > 0) {
      patch.push(1, add);
    }
    return patch;
  }

  // Insert or update records matching a where clause.
  public set(obj: unknown): DbDocument {
    if (Array.isArray(obj)) {
      return (obj as SetCondition[]).reduce<DbDocument>((acc, x) => acc.set(x), this);
    }
    if (ImMap.isMap(obj)) {
      obj = (obj as ImMap<string, unknown>).toJS();
    }
    if (!isObject(obj)) {
      throw new Error("DbDocument.set expects an object or array of objects");
    }
    const { set, where } = this.parse(obj);
    const matches = this.select(where);
    let { changes } = this.changeTracker;
    const firstMatch = matches != null ? matches.min() : undefined;
    if (firstMatch != null) {
      let record = this.records.get(firstMatch);
      if (record == null) {
        throw new Error("record missing for primary key match");
      }
      const before = record;
      for (const field in set) {
        const value = set[field];
        if (value === null) {
          record = record.delete(field);
          continue;
        }
        if (this.stringCols.has(field)) {
          if (isArray(value)) {
            const next = applyStringPatch(
              value as CompressedPatch,
              (before.get(field, "") as string) ?? "",
            )[0];
            record = record.set(field, next);
            continue;
          }
          if (typeof value !== "string") {
            throw new Error(`'${field}' must be a string`);
          }
        }
        const cur = record.get(field);
        const change = ImMap.isMap(value)
          ? (value as ImMap<string, unknown>)
          : (fromJS(value) as unknown);
        if (ImMap.isMap(cur) && ImMap.isMap(change)) {
          record = record.set(
            field,
            mergeSet(cur as ImMap<string, unknown>, change as ImMap<string, unknown>),
          );
        } else {
          record = record.set(field, change);
        }
      }
      if (!before.equals(record)) {
        changes = changes.add(this.primaryKeyCols(record));
        return new DbDocument(
          this.primaryKeys,
          this.stringCols,
          this.records.set(firstMatch, record),
          this.everything,
          this.indexes,
          { changes, fromDb: this.changeTracker.fromDb },
        );
      }
      return this;
    }

    let insertObj = obj;
    for (const field of this.stringCols) {
      if ((insertObj as JsMap)[field] != null && isArray((insertObj as JsMap)[field])) {
        insertObj = copyWithout(insertObj as JsMap, field);
      }
    }
    const record = nonnullCols(fromJS(insertObj) as ImMap<string, unknown>);
    changes = changes.add(this.primaryKeyCols(record));
    const records = this.records.push(record);
    const n = records.size - 1;
    const everything = this.everything.add(n);
    let indexes = this.indexes;
    for (const field of this.primaryKeys) {
      const val = (insertObj as JsMap)[field];
      if (val != null) {
        let index = indexes.get(field) ?? ImMap<string, ImSet<number>>();
        const k = toKey(val);
        const matches = (index.get(k) ?? ImSet<number>()).add(n);
        index = index.set(k, matches);
        indexes = indexes.set(field, index);
      }
    }
    return new DbDocument(this.primaryKeys, this.stringCols, records, everything, indexes, {
      changes,
      fromDb: this.changeTracker.fromDb,
    });
  }

  // Delete records matching a where clause.
  public delete(where?: unknown): DbDocument {
    if (Array.isArray(where)) {
      return (where as WhereCondition[]).reduce<DbDocument>((acc, x) => acc.delete(x), this);
    }
    if (this.everything.size === 0) {
      return this;
    }
    if (where == null) {
      where = {};
    }
    if (!isObject(where)) {
      throw new Error("DbDocument.delete expects an object or array of objects");
    }
    let { changes } = this.changeTracker;
    const remove = this.select(where as WhereCondition);
    if (remove.size === this.everything.size) {
      changes = changes.union(
        this.records.filter((record) => record != null).map(this.primaryKeyCols, this),
      );
      return new DbDocument(this.primaryKeys, this.stringCols, undefined, undefined, undefined, {
        changes,
        fromDb: this.changeTracker.fromDb,
      });
    }

    let indexes = this.indexes;
    for (const field of this.primaryKeys) {
      let index = indexes.get(field);
      if (!index) continue;
      remove.forEach((n) => {
        if (n == null) return;
        const record = this.records.get(n);
        if (record == null) return;
        const val = record.get(field);
        if (val == null) return;
        const k = toKey(val);
        const matches = index!.get(k)?.delete(n);
        if (!matches) return;
        index = matches.size === 0 ? index!.delete(k) : index!.set(k, matches);
      });
      indexes = indexes.set(field, index);
    }

    let records = this.records;
    remove.forEach((n) => {
      if (n == null) return;
      const record = records.get(n);
      if (record == null) return;
      changes = changes.add(this.primaryKeyCols(record));
      records = records.set(n, undefined);
    });

    const everything = this.everything.subtract(remove);
    return new DbDocument(this.primaryKeys, this.stringCols, records, everything, indexes, {
      changes,
      fromDb: this.changeTracker.fromDb,
    });
  }

  // Return all records matching the where clause.
  public get(where: unknown = {}): Records {
    if (!isObject(where)) {
      return List();
    }
    const matches = this.select(where as WhereCondition);
    return List(this.records.filter((_, n) => n != null && matches.includes(n)));
  }

  // Return the first matching record, if any.
  public getOne(where: unknown = {}): RecordValue {
    if (!isObject(where)) {
      return;
    }
    const matches = this.select(where as WhereCondition);
    const min = matches.min();
    if (min == null) return;
    return this.records.get(min);
  }

  // Compute changed primary keys versus another document.
  public changes(prev?: DbDocument): ImSet<RecordValue> {
    if (prev == null) {
      return ImSet(
        ImSet(this.records)
          .filter((x) => x != null)
          .map(this.primaryKeyCols, this),
      );
    }
    return this.changedKeys(prev);
  }

  // Count defined records.
  public count(): number {
    return this.size;
  }

  // Build the set of defined record indices.
  private initEverything(): ImSet<number> {
    const v: number[] = [];
    for (let n = 0; n < this.records.size; n += 1) {
      if (this.records.get(n) != null) {
        v.push(n);
      }
    }
    return ImSet(v);
  }

  // Build primary-key indexes from current records.
  private initIndexes(): Indexes {
    let indexes: Indexes = ImMap();
    for (const field of this.primaryKeys) {
      indexes = indexes.set(field, ImMap());
    }
    this.records.forEach((record, n) => {
      if (record == null) return;
      indexes.forEach((index, field) => {
        const val = record.get(field);
        if (val == null) return;
        const k = toKey(val);
        let matches = index.get(k);
        if (matches != null) {
          matches = matches.add(n);
        } else {
          matches = ImSet([n]);
        }
        indexes = indexes.set(field, index.set(k, matches));
      });
    });
    return indexes;
  }

  // Initialize empty change tracker.
  private initChangeTracker(): ChangeTracker {
    return { changes: ImSet(), fromDb: this };
  }

  // Select record indices matching primary-key fields.
  private select(where: WhereCondition): ImSet<number> {
    if (ImMap.isMap(where)) {
      where = where.toJS();
    }
    const n = len(where as JsMap);
    let result: ImSet<number> | undefined;
    for (const field in where) {
      const value = (where as JsMap)[field];
      const index = this.indexes.get(field);
      if (index == null) {
        throw new Error(`field '${field}' must be a primary key`);
      }
      const v = index.get(toKey(value));
      if (v == null) {
        return ImSet();
      }
      if (n === 1) {
        return v;
      }
      result = result != null ? result.intersect(v) : v;
    }
    if (result == null) {
      return this.everything;
    }
    return result;
  }

  // Separate primary-key and non-key fields.
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

  // Extract primary-key columns from a record map.
  private primaryKeyCols(f: ImMap<string, unknown>): ImMap<string, unknown> {
    return f.filter((_, k) => k != null && this.primaryKeys.has(k));
  }

  // Build object containing only primary keys.
  private primaryKeyPart(x: JsMap): JsMap {
    const where: JsMap = {};
    for (const k in x) {
      const v = x[k];
      if (this.primaryKeys.has(k)) {
        where[k] = v;
      }
    }
    return where;
  }

  // Compute changed primary-key sets versus another document.
  private changedKeys(other: DbDocument): ImSet<RecordValue> {
    if (this.records === other.records) {
      return ImSet();
    }
    let t0: ImSet<RecordValue> = ImSet(ImSet(this.records).filter((x) => x != null));
    let t1: ImSet<RecordValue> = ImSet(ImSet(other.records).filter((x) => x != null));
    const common = t0.intersect(t1);
    t0 = t0.subtract(common);
    t1 = t1.subtract(common);
    const k0 = ImSet(
      t0.filter((x): x is ImMap<string, unknown> => x != null).map(this.primaryKeyCols, this),
    );
    const k1 = ImSet(
      t1.filter((x): x is ImMap<string, unknown> => x != null).map(other.primaryKeyCols, other),
    );
    return ImSet(k0.union(k1));
  }
}

export const createDbCodec = (opts: { primaryKeys: string[]; stringCols?: string[] }): DocCodec => {
  const pk = new Set(opts.primaryKeys);
  const stringCols = new Set(opts.stringCols ?? []);
  return {
    fromString: (text: string) => fromString(text, pk, stringCols),
    toString: (doc: Document) => (doc as DbDocument).toString(),
    applyPatch: (doc: Document, patch: unknown) => (doc as DbDocument).applyPatch(patch),
    applyPatchBatch: (doc: Document, patches: unknown[]) => {
      let current = doc as DbDocument;
      for (const patch of patches) {
        current = current.applyPatch(patch);
      }
      return current;
    },
    makePatch: (a: Document, b: Document) => (a as DbDocument).makePatch(b as DbDocument),
  };
};

export function fromString(
  s: string,
  primaryKeys: Set<string>,
  stringCols: Set<string>,
): DbDocument {
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
  // Preserve immutable records; ensure nested objects are converted to Immutable structures.
  const immutableRecords = List(obj.map((x) => fromJS(x) as ImMap<string, unknown>));
  return new DbDocument(primaryKeys, stringCols, immutableRecords);
}
