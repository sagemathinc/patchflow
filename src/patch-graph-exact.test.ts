import { PatchGraph } from "./patch-graph";
import { legacyPatchId } from "./patch-id";
import { mergeStrings3 } from "./merge3";
import { StringDocument } from "./string-document";
import type { DocCodec, Document, Patch } from "./types";

const exactCodec: DocCodec = {
  fromString: (s) => new StringDocument(s),
  toString: (d) => d.toString(),
  applyPatch: (d, p) => d.applyPatch(p),
  applyPatchBatch: (d, ps) => d.applyPatchBatch(ps),
  makePatch: (a, b) => a.makePatch(b),
  merge3: (base, a, b, ancestors) =>
    new StringDocument(
      mergeStrings3({
        base: base.toString(),
        a: a.toString(),
        b: b.toString(),
        ancestors: ancestors?.map((d) => d.toString()),
      }),
    ),
};
const { merge3: _unused, ...legacyCodec } = exactCodec;
void _unused;

const doc = (s: string) => new StringDocument(s);
const patch = (time: string, parents: string[], from: string, to: string): Patch => ({
  time,
  parents,
  patch: doc(from).makePatch(doc(to)),
  userId: 0,
});

describe("PatchGraph exact values (codec with merge3)", () => {
  it("does not apply a concurrent deletion to similar text elsewhere", () => {
    const base =
      "intro\n\n- - tke1q nested\n- tke2q flat\n\nmiddle\n\n- - tke10q nested\n- tke11q flat\n";
    const [t0, t1, t2] = [1, 2, 3].map(legacyPatchId);
    const patches = [
      patch(t0, [], "", base),
      patch(t1, [t0], base, base.replace("- - tke1q", "- tke1q")), // un-nest a line
      patch(t2, [t0], base, base.replace("tke1q", "")), // concurrently delete its token
    ];
    const exact = new PatchGraph({ codec: exactCodec });
    exact.add(patches);
    expect(exact.value().toString()).toContain("tke10q");
    // The legacy algorithm shows the problem this fixes.
    const legacy = new PatchGraph({ codec: legacyCodec });
    legacy.add(patches);
    expect(legacy.value().toString()).not.toContain("tke10q");
  });

  it("computes linear history exactly as before", () => {
    const texts = ["", "a\n", "a\nb\n", "a\nB\n", "x\na\nB\n"];
    const times = texts.map((_, i) => legacyPatchId(i + 1));
    const patches = texts
      .slice(1)
      .map((to, i) => patch(times[i + 1], i === 0 ? [] : [times[i]], texts[i], to));
    const exact = new PatchGraph({ codec: exactCodec });
    const legacy = new PatchGraph({ codec: legacyCodec });
    exact.add(patches);
    legacy.add(patches);
    for (const p of patches) {
      expect(exact.version(p.time).toString()).toBe(legacy.version(p.time).toString());
    }
    expect(exact.value().toString()).toBe("x\na\nB\n");
  });

  it("gives the exact value each client saw at a patch", () => {
    const [t0, t1, t2, t3] = [1, 2, 3, 4].map(legacyPatchId);
    const exact = new PatchGraph({ codec: exactCodec });
    exact.add([
      patch(t0, [], "", "a\nb\n"),
      patch(t1, [t0], "a\nb\n", "A\nb\n"),
      patch(t2, [t0], "a\nb\n", "a\nB\n"),
    ]);
    const merged = exact.value().toString();
    expect(merged).toBe("A\nB\n");
    exact.add([patch(t3, [t1, t2], merged, `${merged}c\n`)]);
    expect(exact.version(t2).toString()).toBe("a\nB\n");
    expect(exact.value().toString()).toBe("A\nB\nc\n");
  });

  it("does not depend on the order patches are added", () => {
    const [t0, t1, t2, t3] = [1, 2, 3, 4].map(legacyPatchId);
    const patches = [
      patch(t0, [], "", "one\ntwo\nthree\n"),
      patch(t1, [t0], "one\ntwo\nthree\n", "one\n2\nthree\n"),
      patch(t2, [t0], "one\ntwo\nthree\n", "one\ntwo\nthree\nfour\n"),
      patch(t3, [t0], "one\ntwo\nthree\n", "zero\none\ntwo\nthree\n"),
    ];
    const values = new Set<string>();
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 0, 3, 2],
      [2, 3, 0, 1],
    ]) {
      const g = new PatchGraph({ codec: exactCodec });
      for (const i of order) {
        g.add([patches[i]]);
        g.value(); // compute (and cache) intermediate values
      }
      values.add(g.value().toString());
    }
    expect([...values]).toEqual(["zero\none\n2\nthree\nfour\n"]);
  });

  it("applies identical concurrent file loads once", () => {
    const [t0, t1] = [1, 2].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([
      { ...patch(t0, [], "", "file contents\n"), file: true },
      { ...patch(t1, [], "", "file contents\n"), file: true },
    ]);
    expect(g.value().toString()).toBe("file contents\n");
  });

  it("falls back when a parent below a patch is missing", () => {
    const [t0, t1] = [1, 2].map(legacyPatchId);
    const g = new PatchGraph({ codec: exactCodec });
    g.add([patch(t1, [t0], "a\n", "a\nb\n")]);
    expect(() => g.value()).not.toThrow();
  });

  it("loses and duplicates nothing under random concurrent inserts and deletes", () => {
    let seed = 1;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const runs = Number(process.env.PF_RUNS ?? 30);
    const steps = Number(process.env.PF_STEPS ?? 12);
    for (let run = 0; run < runs; run++) {
      const g = new PatchGraph({ codec: exactCodec });
      let time = 1;
      const t0 = legacyPatchId(time++);
      const initial =
        Array.from({ length: 6 }, (_, i) => `line ${i} tok${run}x${i}q`).join("\n") + "\n";
      g.add([patch(t0, [], "", initial)]);
      const inserted = new Set<string>(initial.match(/tok\d+x\d+q/g)!);
      const deleted = new Set<string>();
      // Three clients each make edits on top of the heads they have seen.
      const seen: string[][] = [[t0], [t0], [t0]];
      for (let step = 0; step < steps; step++) {
        const c = Math.floor(rng() * 3);
        const parents = seen[c];
        const base = parentsValue(g, parents);
        const lines = base.split("\n").filter((l) => l !== "");
        let next: string;
        if (rng() < 0.6 || lines.length === 0) {
          const tok = `tok${run}n${step}q`;
          inserted.add(tok);
          lines.splice(Math.floor(rng() * (lines.length + 1)), 0, `new ${tok}`);
          next = lines.join("\n") + "\n";
        } else {
          const i = Math.floor(rng() * lines.length);
          for (const tok of lines[i].match(/tok\d+[xn]\d+q/g) ?? []) deleted.add(tok);
          lines.splice(i, 1);
          next = lines.join("\n") + "\n";
        }
        const t = legacyPatchId(time++);
        g.add([patch(t, parents, base, next)]);
        seen[c] = [t];
        // Sometimes a client catches up with everything.
        if (rng() < 0.3) seen[Math.floor(rng() * 3)] = g.getHeads();
      }
      const final = g.value().toString();
      for (const tok of inserted) {
        const count = final.split(tok).length - 1;
        if ((count !== 1 && !deleted.has(tok)) || count > 1) {
          if (process.env.PF_DEBUG) {
            const orig = (exactCodec as any).merge3;
            const calls: any[] = [];
            (exactCodec as any).merge3 = (base: any, a: any, b: any, ancestors: any) => {
              const out = orig(base, a, b, ancestors);
              calls.push({
                ancestors: ancestors?.map(String),
                base: base.toString(),
                a: a.toString(),
                b: b.toString(),
                out: out.toString(),
              });
              return out;
            };
            (g as any).clearExactCaches();
            g.value();
            (exactCodec as any).merge3 = orig;
            const n = (text: string) => text.split(tok).length - 1;
            const bad = calls.find(
              (c) =>
                n(c.out) > Math.max(n(c.a), n(c.b)) ||
                ((c.a.includes(tok) || c.b.includes(tok)) &&
                  !c.base.includes(tok) &&
                  !c.out.includes(tok)),
            );
            // eslint-disable-next-line no-console
            console.log(
              `run ${run} token ${tok} count ${count}\n${JSON.stringify(bad ?? calls, null, 1)}`,
            );
          }
        }
        expect(count).toBeLessThanOrEqual(1);
        if (!deleted.has(tok)) expect(count).toBe(1);
      }
    }
  });
});

function parentsValue(g: PatchGraph, parents: string[]): string {
  // The value a client committing on top of `parents` started from.
  const heads = parents;
  return (heads.length === 1 ? g.version(heads[0]) : mergedValue(g, heads)).toString();
}

function mergedValue(g: PatchGraph, heads: string[]): Document {
  // Merged value of a set of heads, as the graph computes it for those heads.
  return (g as any).exactValueOfSet(heads);
}
