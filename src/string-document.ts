import { applyPatch, makePatch, type CompressedPatch } from "./dmp";
import type { Document } from "./types";

export class StringDocument implements Document {
  private readonly value: string;

  constructor(value = "") {
    this.value = value;
  }

  public toString(): string {
    return this.value;
  }

  public isEqual(other?: StringDocument): boolean {
    return this.value === (other ? other.value : undefined);
  }

  public applyPatch(patch: CompressedPatch): StringDocument {
    return new StringDocument(applyPatch(patch, this.value)[0]);
  }

  public makePatch(other: StringDocument): CompressedPatch {
    return makePatch(this.value, other.value);
  }

  public set(x: unknown): StringDocument {
    if (typeof x === "string") {
      return new StringDocument(x);
    }
    throw new Error("StringDocument.set expects a string");
  }

  public get(): never {
    throw new Error("get queries on strings are not supported");
  }

  public delete(): never {
    throw new Error("delete on strings is not supported");
  }

  public count(): number {
    return this.value.length;
  }
}

export const StringCodec = {
  fromString: (text: string) => new StringDocument(text),
  toString: (doc: StringDocument) => doc.toString(),
  applyPatch: (doc: StringDocument, patch: CompressedPatch) => doc.applyPatch(patch),
  makePatch: (a: StringDocument, b: StringDocument) => a.makePatch(b),
};
