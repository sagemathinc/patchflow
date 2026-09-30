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
});
