// sameElements must decide exactly as immutable.js's List(a).equals(List(b)),
// which PatchGraph's file-load dedup used before it stopped importing immutable.
import { List, Map as ImMap } from "immutable";
import { sameElements } from "./same-elements";

const listEquals = (a: unknown, b: unknown) => List(a as unknown[]).equals(List(b as unknown[]));

describe("sameElements agrees with List(a).equals(List(b))", () => {
  const shared = [1, 2];
  const cases: [string, unknown[], unknown[]][] = [
    ["equal numbers and strings", [1, "a", [0, "x"]], [1, "a", [0, "x"]]],
    ["the same nested array", [shared, 3], [shared, 3]],
    ["+0 and -0", [0], [-0]],
    ["NaN and NaN", [NaN], [NaN]],
    ["equal Dates", [new Date(5)], [new Date(5)]],
    ["a Date and its time", [new Date(5)], [5]],
    ["different Dates", [new Date(5)], [new Date(6)]],
    ["equal immutable Maps (value objects)", [ImMap({ a: 1 })], [ImMap({ a: 1 })]],
    ["different immutable Maps", [ImMap({ a: 1 })], [ImMap({ a: 2 })]],
    ["boxed and primitive strings", [Object("s")], ["s"]],
    ["null and undefined", [null], [undefined]],
    ["0 and false", [0], [false]],
    ["different lengths", [1, 2], [1]],
    ["empty arrays", [], []],
  ];
  for (const [name, a, b] of cases) {
    it(name, () => {
      expect(sameElements(a, b)).toBe(listEquals(a, b));
    });
  }
  it("nested arrays with equal contents compare by identity, as List did", () => {
    const a = [[1, 2]],
      b = [[1, 2]];
    expect(listEquals(a, b)).toBe(false);
    expect(sameElements(a, b)).toBe(false);
  });
  it("strings compare as List(string) did", () => {
    expect(sameElements("abc", "abc")).toBe(listEquals("abc", "abc"));
    expect(sameElements("abc", "abd")).toBe(listEquals("abc", "abd"));
  });
});
