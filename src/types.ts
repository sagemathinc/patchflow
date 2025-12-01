import type { CompressedPatch } from "./dmp";

// Ingestion assumptions (handled by adapters/transports, kept out of core):
// - Patch.time is unique within a graph (dedupe at the PatchStore boundary).
// - Parents must already exist or be delivered alongside the patch; children are not delivered
//   without ancestors. If history is truncated, loadInitial must return hasMore=true.
// - Snapshot metadata is inline: when isSnapshot is true, snapshot/seqInfo are present on the
//   same envelope (no separate “snapshot message” later).
// - Patches are immutable once appended; transports may replay envelopes idempotently but must
//   not mutate existing patches.
// - Adapters provide a consistent ordering signal (time/wall/version) and do not reorder parents.
// A Patch represents a change with logical time and ancestry.
export interface Patch {
  time: number;
  wall?: number;
  patch?: unknown;
  userId?: number;
  size?: number;
  parents?: number[];
  version?: number;
  isSnapshot?: boolean;
  snapshot?: string;
  seqInfo?: { seq: number; prevSeq?: number };
  file?: boolean;
  // Optional transport provenance.
  source?: string;
}

// Immutable document contract used by the patch graph.
export interface Document {
  applyPatch(patch: unknown): Document;
  makePatch(other: Document): unknown;
  isEqual(other?: Document): boolean;
  toString(): string;
  set(value: unknown): Document;
  get(key?: unknown): unknown;
  getOne?(key?: unknown): unknown;
  delete?(key?: unknown): Document;
  changes?(prev?: Document): unknown;
  count(): number;
}

export interface DocCodec {
  fromString(text: string): Document;
  toString(doc: Document): string;
  applyPatch(doc: Document, patch: unknown): Document;
  makePatch(a: Document, b: Document): unknown;
}

export type MergeStrategy = "apply-all" | "three-way";

export type PatchGraphValueOptions = {
  time?: number;
  withoutTimes?: number[];
  mergeStrategy?: MergeStrategy;
};

// Optional metadata describing where a patch came from (e.g., transport id).
export interface PatchEnvelope extends Patch {
  source?: string;
}

export interface PatchStore {
  loadInitial(opts?: { sinceTime?: number }): Promise<{
    patches: PatchEnvelope[];
    hasMore?: boolean;
  }>;
  append(envelope: PatchEnvelope): Promise<void>;
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
