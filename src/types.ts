import type { CompressedPatch } from "./dmp";
import type { PatchId } from "./patch-id";

// Ingestion assumptions (handled by adapters/transports, kept out of core):
// - Patch.time is unique within a graph (dedupe at the PatchStore boundary).
// - Parents must already exist or be delivered alongside the patch; children are not delivered
//   without ancestors. If history is truncated, loadInitial must return hasMore=true.
// - Snapshot metadata is inline: when isSnapshot is true, snapshot/seqInfo are present on the
//   same envelope (no separate “snapshot message” later).
// - Patches are immutable once appended; transports may replay envelopes idempotently but must
//   not mutate existing patches.
// - Adapters provide a consistent ordering signal (time/wall/version) and do not reorder parents.
// A JSON-compatible value for patch metadata.
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JSONValue }
  | JSONValue[];

// A Patch represents a change with logical time and ancestry.
export interface Patch {
  time: PatchId;
  wall?: number;
  patch?: unknown;
  userId?: number;
  size?: number;
  parents?: PatchId[];
  version?: number;
  isSnapshot?: boolean;
  snapshot?: string;
  seqInfo?: { seq: number; prevSeq?: number };
  file?: boolean;
  // Arbitrary JSON metadata (immutable once stored). Useful for tags like "deleted" or commit messages.
  meta?: { [key: string]: JSONValue };
  // Optional transport provenance.
  source?: string;
  // Hash of the document value right after this patch, as its author
  // computed it (see value-hash.ts). Every client that computes the exact value
  // of this patch must get the same hash; a difference is an inconsistency
  // (see PatchGraphOptions.onInconsistency). A snapshot record carries the
  // hash of the patch it is a snapshot of.
  hash?: string;
  // A patch with several parents (a merge commit) is, like any patch, a diff
  // from the merged value of its parents. From this version on it also
  // records that merged value, as its author computed it: mergePatch applied
  // to the exact value of mergeParent, one of the parents. Computing the
  // value of the patch then needs no merge, so changing the merge algorithm
  // (DocCodec.merge3) later never changes the values of patches already in a
  // history, like a git merge commit, which records its merged tree. Clients
  // that do not know these fields still read `patch` as before. A merge
  // commit without them, written by an earlier version, see isLegacyMerge in
  // patch-graph.ts.
  mergeParent?: PatchId;
  mergePatch?: unknown;
}

// A value that does not match the hash its author recorded (Patch.hash).
export interface Inconsistency {
  // "patch": the exact value of a patch; "snapshot": a snapshot's text, the
  // starting point of values computed from it.
  kind: "patch" | "snapshot";
  time: PatchId;
  expected: string;
  actual: string;
  userId?: number;
}

// Immutable document contract used by the patch graph.
export interface Document {
  applyPatch(patch: unknown): Document;
  applyPatchBatch(patches: unknown[]): Document;
  makePatch(other: Document): unknown;
  isEqual(other?: Document): boolean;
  toString(): string;
  set(value: unknown): Document;
  get(key?: unknown): unknown;
  getOne?(key?: unknown): unknown;
  delete?(key?: unknown): Document;
  changes?(prev?: Document): unknown;
  size?(): number;
  count(): number;
  // Hash of the value (see value-hash.ts); by default the hash of toString().
  hash?(): string;
}

export interface DocCodec {
  fromString(text: string): Document;
  toString(doc: Document): string;
  applyPatch(doc: Document, patch: unknown): Document;
  applyPatchBatch(doc: Document, patches: unknown[]): Document;
  makePatch(a: Document, b: Document): unknown;
  // Optional deterministic three-way merge of two documents that diverged from
  // `base`; `a` is the earlier and `b` the later head. When provided, the patch
  // graph applies each patch to the exact value of its parents and merges
  // concurrent heads with this function, instead of applying all patches in
  // time order with fuzzy patch application. In a criss-cross history the base
  // is itself a merge of several common ancestors; their individual values are
  // then passed as `ancestors`, so content they already had is not mistaken for
  // new content added by both sides.
  merge3?(base: Document, a: Document, b: Document, ancestors?: Document[]): Document;
  // Hash of a value (see value-hash.ts); by default doc.hash(), or the hash of
  // toString(doc). Must be the same for equal values on every client.
  hash?(doc: Document): string;
}

export type MergeStrategy = "apply-all" | "three-way";

export type PatchGraphValueOptions = {
  time?: PatchId;
  withoutTimes?: PatchId[];
  mergeStrategy?: MergeStrategy;
};

// Optional metadata describing where a patch came from (e.g., transport id).
export interface PatchEnvelope extends Patch {
  source?: string;
}

export interface PatchStore {
  loadInitial(opts?: { since?: PatchId; sinceTime?: number }): Promise<{
    patches: PatchEnvelope[];
    hasMore?: boolean;
  }>;
  append(envelope: PatchEnvelope): void;
  subscribe(onEnvelope: (env: PatchEnvelope) => void): () => void;
}

export interface FileAdapter {
  read(): Promise<string>;
  write(content: string, opts?: { base?: string }): Promise<void>;
  watch?(onChange: (delta?: { patch?: CompressedPatch; seq?: number }) => void): () => void;
}

export interface PresenceAdapter {
  publish(state: unknown): void;
  subscribe(onState: (state: unknown, clientId: string) => void): () => void;
}

export interface CursorPresence {
  type: "cursor";
  time: number;
  locs: unknown;
  userId?: number;
  docId?: string;
}

export interface CursorSnapshot extends CursorPresence {
  clientId: string;
}
