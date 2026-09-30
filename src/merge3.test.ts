import { mergeStrings3 } from "./merge3";

const merge = (base: string, a: string, b: string) => mergeStrings3({ base, a, b });

describe("mergeStrings3", () => {
  it("applies non-overlapping changes from both sides", () => {
    expect(merge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toBe("A\nb\nC\n");
  });

  it("keeps changes to different words of one line", () => {
    expect(
      merge(
        "A long line about the plan.\n",
        "A long line about the new plan.\n",
        "A really long line about the plan.\n",
      ),
    ).toBe("A really long line about the new plan.\n");
  });

  it("applies the same change made on both sides once", () => {
    const base = "a\n\nb\n\nmoved\n\nc\n";
    const moved = "a\n\nmoved\n\nb\n\nc\n";
    const merged = merge(base, moved, `${moved}d\n`);
    expect(merged.split("moved").length - 1).toBe(1);
    expect(merged).toContain("d\n");
  });

  it("never relocates a deletion onto similar text", () => {
    const base = "x\n\n- - tke1q nested\n- tke2q flat\n\ny\n\n- - tke10q nested\n- tke11q flat\n";
    expect(merge(base, base.replace("tke1q", ""), base.replace("- - tke1q", "- tke1q"))).toContain(
      "tke10q",
    );
  });

  it("keeps both concurrent insertions at one position", () => {
    expect(merge("a\n", "a\none\n", "a\ntwo\n")).toBe("a\none\ntwo\n");
  });

  it("does not let a whitespace-only change override content", () => {
    const base = "1. x\n\n\n";
    expect(merge(base, "1. x\n\n", "1. x\n\n| t |\n")).toContain("| t |");
  });

  it("keeps a line added next to a line the other side deleted", () => {
    expect(merge("a\nX\nb\n", "a\nX\nnew\nb\n", "a\nb\n")).toBe("a\nnew\nb\n");
    expect(merge("a\nX\nb\n", "a\nb\n", "a\nX\nnew\nb\n")).toBe("a\nnew\nb\n");
  });

  it("keeps both sides of a true conflict instead of dropping one", () => {
    expect(merge("the cat sat", "the dog sat", "the cow sat")).toBe("the cow dog sat");
  });

  it("keeps both versions of a word both sides changed", () => {
    expect(merge("hello world", "hxello world", "helloy world")).toBe("helloy hxello world");
  });

  it("never splices the characters of two conflicting words", () => {
    expect(
      merge("the quick fox tok1q jumps", "the quick fox tok2q jumps", "the quick fox tok3q jumps"),
    ).toBe("the quick fox tok2q tok3q jumps");
  });

  it("keeps both lines when both sides replaced the same line", () => {
    expect(merge("a\nold line\nz\n", "a\nfirst rewrite\nz\n", "a\nsecond rewrite\nz\n")).toBe(
      "a\nfirst rewrite\nsecond rewrite\nz\n",
    );
  });

  it("does not split an edit around a blank line the diffs matched differently", () => {
    // Found by CoCalc's editor fuzzer: both sides rewrote the same Markdown
    // line; one also added a block before it and dropped the trailing blank.
    const base = "x\n\n****six** fourteen**   thirteen \n\n";
    const a = "x\n\n**six** fourteen   thirteen \n\n";
    const b = "x\n\n> quoted\n\n**six** fourteen    new thirteen \n";
    const out = merge(base, a, b);
    expect(out.split("six").length - 1).toBe(1);
    expect(out).toContain("> quoted");
    expect(out).toContain("new thirteen");
  });

  it("does not depend on wall-clock time", () => {
    // Review of #2: a diff deadline made replicas disagree when slow.
    const input = { base: "a\nb\nc\nd\ne\nf\n", a: "a\nB\nc\nd\nE\nf\n", b: "a\nb\nC\nd\ne\nF\n" };
    const normal = mergeStrings3(input);
    const now = Date.now;
    let tick = 0;
    let slow: string;
    try {
      Date.now = () => (tick += 1000);
      slow = mergeStrings3(input);
    } finally {
      Date.now = now;
    }
    expect(normal).toBe("a\nB\nC\nd\nE\nF\n");
    expect(slow).toBe(normal);
  });

  it("never fuses lines added at the end without a final newline", () => {
    expect(merge("header\n", "header\nalpha", "header\nbeta")).toBe("header\nalpha\nbeta");
    expect(merge("", "alpha", "beta")).toBe("alpha\nbeta");
    expect(merge("x", "x alpha", "x beta")).toBe("x alpha beta");
  });

  it("merges concurrent rewrites of a large block in bounded work", () => {
    const n = 2000;
    const lines = (word: string) =>
      Array.from({ length: n }, (_, i) => `line ${i} ${word}\n`).join("");
    const out = merge(lines("original"), lines("left"), lines("right"));
    const outLines = out.split("\n").filter((line) => line !== "");
    expect(outLines.length).toBe(n);
    expect(outLines[123]).toBe("line 123 left right");
  });

  it("merges the incident case exactly: un-nest and delete on one line", () => {
    // CoCalc incident 2026-09-28; a review fix briefly broke this.
    expect(merge("- - tke1q nested\n", "- -  nested\n", "- tke1q nested\n")).toBe("-  nested\n");
  });
});
