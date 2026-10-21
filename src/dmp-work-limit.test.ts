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
