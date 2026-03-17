import { isEmptyPatch } from "./patch-utils";

describe("isEmptyPatch", () => {
  it("treats missing patches as empty", () => {
    expect(isEmptyPatch(undefined)).toBe(true);
    expect(isEmptyPatch(null)).toBe(true);
  });

  it("detects empty wrapped db patches", () => {
    expect(isEmptyPatch([1, []])).toBe(true);
    expect(isEmptyPatch([1, [{ id: 1 }]])).toBe(false);
  });

  it("detects empty array-like patches", () => {
    expect(isEmptyPatch([])).toBe(true);
    expect(isEmptyPatch(["x"])).toBe(false);
    expect(isEmptyPatch(new Uint8Array())).toBe(true);
    expect(isEmptyPatch(new Uint8Array([1]))).toBe(false);
  });
});
