// Probe: the cost of commit(next) vs previewCommit(next) + commit(next, { preview })
// on a large single-head document and on an 8-head merge, each in a fresh
// process. Run after `pnpm build`:
//
//   node scripts/probe-preview-commit.cjs
//
// Reports wall time of the final commit (or preview + commit) and the bytes
// it allocated (heap used after it, no GC run during it, minus heap used
// before it, after a full GC).
const { execFileSync } = require("node:child_process");

if (process.argv[2] === "child") {
  child(process.argv[3], process.argv[4]);
} else {
  const rows = [];
  for (const shape of ["single", "merge8"]) {
    for (const mode of ["plain", "preview"]) {
      const out = execFileSync(
        process.execPath,
        ["--expose-gc", "--max-semi-space-size=512", __filename, "child", shape, mode],
        { encoding: "utf8" },
      );
      rows.push(JSON.parse(out));
    }
  }
  console.table(rows);
}

function child(shape, mode) {
  const pf = require("../dist/cjs/index.js");
  const doc = (s) => new pf.StringDocument(s);
  const codec = {
    ...pf.StringCodec,
    merge3: (base, a, b, ancestors) =>
      doc(
        pf.mergeStrings3({
          base: base.toString(),
          a: a.toString(),
          b: b.toString(),
          ancestors: ancestors?.map(String),
        }),
      ),
  };
  let now = 1000;
  const clock = () => now;
  const mk = async (clientId) => {
    const s = new pf.Session({
      codec,
      patchStore: new pf.MemoryPatchStore([]),
      clock,
      clientId,
    });
    await s.init();
    return s;
  };
  const line = (i) => `line ${i} ${"abcdefghij".repeat(8)}\n`;
  const big = Array.from({ length: 4_000 }, (_, i) => line(i)).join("");
  (async () => {
    let a;
    let next;
    if (shape === "single") {
      a = await mk("a");
      a.commit(doc(big));
      now += 1;
      // Change every 10th line: a large patch.
      next = doc(
        big
          .split("\n")
          .map((l, i) => (i % 10 === 0 ? l.toUpperCase() : l))
          .join("\n"),
      );
    } else {
      const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const ss = [];
      for (const id of ids) ss.push(await mk(id));
      a = ss[0];
      const e0 = a.commit(doc(big));
      for (const t of ss.slice(1)) t.applyRemote(e0);
      now += 1;
      const lines = big.split("\n");
      const heads = ss.map((t, k) =>
        t.commit(
          doc(lines.map((l, i) => (i % 8 === k && i % 3 === 0 ? `${l} by ${k}` : l)).join("\n")),
        ),
      );
      for (const e of heads.slice(1)) a.applyRemote(e);
      if (a.getHeads().length !== 8) throw new Error("expected 8 heads");
      now += 1;
      next = doc(`${a.getDocument()}merged\n`);
    }
    global.gc();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    let envelope;
    if (mode === "preview") {
      const preview = a.previewCommit(next);
      envelope = a.commit(next, { preview });
    } else {
      envelope = a.commit(next);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const allocated = process.memoryUsage().heapUsed - before;
    process.stdout.write(
      JSON.stringify({
        shape,
        mode,
        ms: Math.round(ms),
        allocatedMB: +(allocated / 2 ** 20).toFixed(1),
        envelopeKB: Math.round(JSON.stringify(envelope).length / 1024),
        parents: envelope.parents.length,
      }),
    );
  })();
}
