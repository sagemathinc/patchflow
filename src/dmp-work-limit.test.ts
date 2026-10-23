import { applyPatch, diffMain, DIFF_WORK_LIMIT, makePatch } from "./dmp";

// Texts whose diff is too costly to finish within the budget: unrelated
// random text, so the cutoff decides the result.
function random(n: number, seed: number): string {
  let s = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    out += String.fromCharCode(97 + (s % 26));
  }
  return out;
}

describe("diffs are bounded by work, not the clock", () => {
  const a = random(100_000, 1);
  const b = random(100_000, 2);
  const small = ["the quick brown fox", "the quick red fox jumps"];

  afterEach(() => vi.restoreAllMocks());

  it("uses diffWorkLimit (25M)", () => {
    expect(DIFF_WORK_LIMIT).toBe(25_000_000);
  });

  it("never reads the clock: makePatch, diffMain and applyPatch", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw Error("the clock was read");
    });
    const patch = makePatch(small[0], small[1]);
    expect(applyPatch(patch, small[0])).toEqual([small[1], true]);
    expect(diffMain(small[0], small[1]).length).toBeGreaterThan(0);
    // ... nor for a diff cut off by the budget.
    expect(applyPatch(makePatch(a, b), a)).toEqual([b, true]);
  });

  it("the same texts give the same patch whatever the clock says", () => {
    const reference = JSON.stringify(makePatch(a, b));
    let t = 0;
    for (const clock of [
      () => 0, // frozen
      () => (t += 60_000), // racing: a minute per read
      () => Date.UTC(2100, 0, 1), // far ahead
    ]) {
      vi.spyOn(Date, "now").mockImplementation(clock);
      expect(JSON.stringify(makePatch(a, b))).toBe(reference);
      vi.restoreAllMocks();
    }
  });
});

// Fixed in @cocalc/diff-match-patch 1.1.1.
describe("a patch keeps every edit", () => {
  const line = (i: number) => `line ${i}: ` + "abcdefghij".repeat(6) + "\n";
  function long(bytes: number): string {
    let s = "";
    for (let i = 0; s.length < bytes; i++) s += line(i);
    return s;
  }

  for (const kb of [800, 2048]) {
    it(`a one-line edit to ${kb} KB is a patch of the line, not the whole text (0.15)`, () => {
      const a = long(kb * 1024);
      const mid = a.indexOf("\n", a.length >> 1) + 1;
      const b = a.slice(0, mid) + "EDITED " + a.slice(mid);
      const patch = makePatch(a, b);
      expect(JSON.stringify(patch).length).toBeLessThan(1000);
      expect(applyPatch(patch, a)).toEqual([b, true]);
    });
  }

  it("an emoji changed only in its high surrogate is not lost (😀 to 🨀)", () => {
    for (const [a, b] of [
      ["😀", "🨀"],
      ["x 😀 y", "x 🨀 y"],
      ["😀😁", "🨀🨁"],
      ["p".repeat(400_000) + "😀" + "s".repeat(400_000), "p".repeat(400_000) + "🨀" + "s".repeat(400_000)],
    ]) {
      expect(applyPatch(makePatch(a, b), a)).toEqual([b, true]);
    }
  });
});
