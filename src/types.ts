import type { CompressedPatch } from "./dmp";

// A Patch represents a change with logical time and ancestry.
export interface Patch {
  time: number;
  wall?: number;
  patch?: CompressedPatch;
  userId?: number;
  size?: number;
  parents?: number[];
  version?: number;
  isSnapshot?: boolean;
  snapshot?: string;
  seqInfo?: { seq: number; prevSeq?: number };
  file?: boolean;
}

// Immutable document contract used by the patch graph.
export interface Document {
  applyPatch(patch: CompressedPatch): Document;
  makePatch(other: Document): CompressedPatch;
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
  applyPatch(doc: Document, patch: CompressedPatch): Document;
  makePatch(a: Document, b: Document): CompressedPatch;
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
