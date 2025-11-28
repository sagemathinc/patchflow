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
  set(value: any): Document;
  get(key?: any): any;
  getOne?(key?: any): any;
  delete?(key?: any): Document;
  changes?(prev?: Document): any;
  count(): number;
}

export interface DocCodec {
  fromString(text: string): Document;
  toString(doc: Document): string;
  applyPatch(doc: Document, patch: CompressedPatch): Document;
  makePatch(a: Document, b: Document): CompressedPatch;
}

export type PatchGraphValueOptions = {
  time?: number;
  withoutTimes?: number[];
};
