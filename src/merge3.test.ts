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

  // Merged in both argument orders, which must agree.
  const both = (base: string, a: string, b: string) => {
    const result = merge(base, a, b);
    expect(merge(base, b, a)).toBe(result);
    return result;
  };

  it("applies both sides' typing in the same word", () => {
    // Before, both versions of the word were kept: every keystroke two people
    // typed concurrently repeated the whole word (or line).
    expect(both("hello world", "hxello world", "helloy world")).toBe("hxelloy world");
    expect(both("x blahlkjj\n", "x blahlkjj1\n", "x blahlkjja\n")).toBe("x blahlkjj1a\n");
  });

  it("merges two people typing at the end of a line of a notebook cell", () => {
    const base = "# hi - blah blahjj\nfrom pylab import plot\nplot([1,2,3])\n";
    const at = (typed: string) => base.replace("blahjj", `blahjj${typed}`);
    expect(both(base, at("1"), at("a"))).toBe(at("1a"));
    // Several keystrokes each, as when both keep typing before syncing.
    expect(both(base, at("123"), at("abc"))).toBe(at("123abc"));
  });

  it("applies a character typed and one deleted elsewhere in the same word", () => {
    // One side typed an "o", the other deleted one: both apply.
    expect(both("hello world\n", "helloo world\n", "hell world\n")).toBe("hello world\n");
    expect(both("abcdef ghi\n", "abXcdef ghi\n", "abcde ghi\n")).toBe("abXcde ghi\n");
  });

  it("applies both sides' whitespace changes symmetrically", () => {
    // Review of #14: one of two space insertions was dropped, depending on order.
    expect(both("abcdefgh", "abc defgh", "abcdef gh")).toBe("abc def gh");
    expect(both("base0123456789", "base0 123456789", "base0123 456789")).toBe("base0 123 456789");
  });

  it("never combines halves of two different characters outside the BMP", () => {
    // Review of #14: U+10800 and U+10401 merged into U+10801.
    const cp = (c: number) => String.fromCodePoint(c);
    const line = (c: number) => `prefix ${cp(c)} suffix`;
    const merged = both(line(0x10400), line(0x10800), line(0x10401));
    expect(merged).toContain(cp(0x10800));
    expect(merged).toContain(cp(0x10401));
    expect(merged).not.toContain(cp(0x10801));
  });

  it("aligns many long lines both sides appended to in bounded time", () => {
    // Review of #14: comparing line contents for every pair took seconds.
    const lines = (suffix: string) =>
      Array.from({ length: 160 }, (_, i) => "a".repeat(12_000) + i + suffix).join("\n") + "\n";
    const start = performance.now();
    merge(lines(""), lines("X"), lines("Y"));
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("still keeps both versions when both sides replaced the same characters", () => {
    expect(both("a cat b\n", "a dog b\n", "a cow b\n")).toBe("a cow dog b\n");
    expect(both("The Color of Pomegranates\n", "", "The Colour of Pomegranates\n")).toBe(
      "The Colour of Pomegranates",
    );
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

  it("aligns a last line without a final newline like any other line", () => {
    // Found by CoCalc's notebook fuzzer: both sides edited the unterminated
    // last line and one also added lines before it; they were joined to it.
    const base = "import math\nnew line x4";
    const a = "import math\nadded one\nadded two\nnew mine line x4";
    const b = "import math\nnew x4 theirs";
    const out = merge(base, a, b);
    expect(out.split("\n")).toEqual([
      "import math",
      "added one",
      "added two",
      "new mine x4 theirs",
    ]);
    expect(merge("a\nb", "a\nb\n", "a\nB")).toBe("a\nB\n");
    expect(merge("a\nb\n", "a\nb", "a\nB\n")).toBe("a\nB");
  });

  it("pairs a changed line with the closest of several edits of it", () => {
    // CoCalc notebook fuzzer: side a added lines that all resemble the line it
    // edited; they paired with the first of them, keeping both versions.
    const base = "head x0\nnew line t4\n";
    const a = "head x0\nnew b20 line b16\nnew line b21\nnew b13 line t4\n";
    const b = "head x0\nnew t4 t19\n";
    expect(merge(base, a, b).split("t4").length - 1).toBe(1);
  });

  it("merges a line one side trimmed and the other extended", () => {
    // CoCalc notebook fuzzer: the diff matched a space instead of a word, so
    // the trimmed line was not seen as an edit and both versions were kept.
    expect(merge("aa bb cc dd\n", "aa bb cc dd B\n", "aa dd A\n")).toBe("aa dd A B\n");
    expect(merge("z = 0 q\n", "z = 0 q B\n", "z q A\n")).toBe("z q A B\n");
  });

  it("merges concurrent rewrites of many long lines in bounded work", () => {
    // Review of #4: pairing lines by a word-level LCS was quadratic in words
    // inside the quadratic line alignment (80 lines of 100 words: 15 s).
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const base = Array.from({ length: 80 }, (_, i) => `${i} ${words} original\n`).join("");
    const start = Date.now();
    const out = merge(
      base,
      base.split("original").join("left"),
      base.split("original").join("right"),
    );
    expect(Date.now() - start).toBeLessThan(5000);
    const lines = out.split("\n").filter((line) => line !== "");
    expect(lines.length).toBe(80);
    expect(lines[7]).toBe(`7 ${words} left right`);
  });

  it("aligns edits of one line by its words, not the spaces between them", () => {
    // CoCalc tasks fuzzer: a diff that matched spaces instead of words made
    // two independent edits of one line overlap, and a word was kept twice.
    expect(merge("the x2 b8 a10 a12", "b17 the x2 b8 a10", "the x2 a10 a15 a16 a12")).toBe(
      "b17 the x2 a10 a15 a16",
    );
  });

  it("merges a line one side split with edits the other made elsewhere in it", () => {
    // CoCalc collaborative meeting notes in a browser: one person pressed
    // Enter in the middle of a heading while another typed at its end. Line by
    // line, both the edited heading and the split-off tail were kept, so the
    // tail's words appeared twice.
    expect(
      merge(
        "# Notes\n\n## Discussion w1 w2 w3 tk\n\n## Action items\n",
        "# Notes\n\n## Discussion w1\n\nnew\n\n## w2 w3 tk\n\n## Action items\n",
        "# Notes\n\n## Discussion w1 w2 w3 tk4\n\nmore\n\n## Action items\n",
      ),
    ).toBe("# Notes\n\n## Discussion w1\n\nnew\n\n## w2 w3 tk4\n\nmore\n\n## Action items\n");
  });

  it("keeps changes to neighboring words of one line", () => {
    // With no unchanged word between them, the two edits form one chunk; both
    // versions of both words used to be kept.
    expect(merge("the quick brown fox\n", "the QUICK brown fox\n", "the quick BROWN fox\n")).toBe(
      "the QUICK BROWN fox\n",
    );
    expect(merge("x aaDisc bbDisc y", "x aaDisc bb cDisc y", "x aa dDisc bbDisc y")).toBe(
      "x aa dDisc bb cDisc y",
    );
  });

  it("merges random concurrent word and line edits symmetrically, keeping each new word once", () => {
    let seed = 1;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    let token = 0;
    // Insert words, type onto a word, split a line, delete a word, add a line.
    const edit = (words: string[], side: string): string[] => {
      const w = [...words];
      for (let k = 1 + rnd(3); k > 0; k--) {
        const i = rnd(w.length + 1);
        const r = rnd(5);
        const t = `${side}${token++}`;
        if (r === 0) w.splice(i, 0, t);
        else if (r === 1 && i < w.length) w[i] += t;
        else if (r === 2 && i < w.length) w.splice(i, 0, "\n");
        else if (r === 3 && i < w.length && w[i] !== "\n") w.splice(i, 1);
        else w.splice(i, 0, t, "\n");
      }
      return w;
    };
    const text = (w: string[]) => w.join(" ").replace(/ ?\n ?/g, "\n") + "\n";
    const tokens = (s: string) => s.match(/[ab]\d+/g) ?? [];
    const problems: string[] = [];
    for (let run = 0; run < 2000; run++) {
      const words = Array.from({ length: 3 + rnd(10) }, (_, i) => (rnd(5) === 0 ? "\n" : `w${i}`));
      const [base, a, b] = [words, edit(words, "a"), edit(words, "b")].map(text);
      const merged = merge(base, a, b);
      if (merge(base, b, a) !== merged)
        problems.push(`asymmetric: ${JSON.stringify({ base, a, b })}`);
      const all = tokens(merged);
      for (const t of new Set([...tokens(a), ...tokens(b)])) {
        const n = all.filter((x) => x === t).length;
        if (n !== 1) problems.push(`${t} ${n} times: ${JSON.stringify({ base, a, b, merged })}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("adds lines both sides added once when one side also reindented what follows", () => {
    // CoCalc markdown fuzzer: both sides had the same new list, and one also
    // nested the table after it into the list.
    expect(
      merge(
        "notes\n| a | b |\n| 1 | 2 |\n",
        "notes\n1. one x8\n   - sub x9\n| a | b |\n| 1 | 2 |\n",
        "notes\n1. one x8\n   - sub x9\n     | a | b |\n     | 1 | 2 |\n",
      ),
    ).toBe("notes\n1. one x8\n   - sub x9\n     | a | b |\n     | 1 | 2 |\n");
  });

  it("keeps a line added after a line the other side changed to end with it", () => {
    // Review of #8: "og" added after "cat" is not the end of "dog".
    expect(merge("cat\n", "dog\n", "cat\nog\n")).toBe("dog\nog\n");
    expect(merge("cat\n", "cat\nog\n", "dog\n")).toBe("dog\nog\n");
    expect(merge("old\n", "changed\n", "old\ned\n")).toBe("changed\ned\n");
    expect(merge("old\n", "old\ned\n", "changed\n")).toBe("changed\ned\n");
  });

  it("does not take an indent for a line added before the line", () => {
    // Review of #8: both sides added "new"; one also indented "original".
    expect(merge("original\n", "new\n  original\n", "new\noriginal\n")).toBe("new\n  original\n");
    expect(merge("original\n", "new\noriginal\n", "new\n  original\n")).toBe("new\n  original\n");
  });
});
