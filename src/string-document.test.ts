import { StringDocument } from "./string-document";

describe("StringDocument", () => {
  it("supports equality, count, and patch roundtrip", () => {
    const a = new StringDocument("abc");
    const b = new StringDocument("abcd");
    expect(a.isEqual(new StringDocument("abc"))).toBe(true);
    expect(a.count()).toBe(3);
    const patch = a.makePatch(b);
    expect(a.applyPatch(patch).toString()).toBe("abcd");
  });

  it("throws on unsupported operations", () => {
    const doc = new StringDocument("x");
    expect(() => doc.get()).toThrow();
    expect(() => doc.delete()).toThrow();
    expect(() => doc.set(123)).toThrow();
  });
});
