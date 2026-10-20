// Probe: the cost of commit(next) vs previewCommit(next) + commit(next, { preview })
// on a large single-head document and on an 8-head merge, each in a fresh
// process. Run after `pnpm build`:
//
//   node scripts/probe-preview-commit.cjs
//
// Reports, for the final commit (or preview + commit) only:
// - ms: wall time;
// - heapMB: heap used after it minus heap used before it (after a full GC;
//   misses garbage collected during it);
// - abMB / extMB: the same for ArrayBuffer and external memory;
// - peakRssMB: the process's peak RSS (maxRSS) after it, and peakRssDeltaMB
//   how much it raised the peak reached before it (0 if it stayed below).
// Shapes: "single" (a large single-head commit), "merge8" (an 8-head merge)
// and "binary" (the large single-head commit with a Uint8Array patch).
const { execFileSync } = require("node:child_process");

if (process.argv[2] === "child") {
  child(process.argv[3], process.argv[4]);
} else {
  const rows = [];
  for (const shape of ["single", "binary", "merge8"]) {
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
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const toBytes = (p) => enc.encode(JSON.stringify(p));
  const fromBytes = (p) => JSON.parse(dec.decode(p));
  const binary = shape === "binary";
  const codec = {
    ...pf.StringCodec,
    ...(binary
      ? {
          makePatch: (a, b) => toBytes(pf.StringCodec.makePatch(a, b)),
          applyPatch: (d, p) => pf.StringCodec.applyPatch(d, fromBytes(p)),
          applyPatchBatch: (d, ps) => pf.StringCodec.applyPatchBatch(d, ps.map(fromBytes)),
        }
      : {}),
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
    if (shape === "single" || shape === "binary") {
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
    const before = process.memoryUsage();
    const peakBefore = process.resourceUsage().maxRSS;
    const t0 = process.hrtime.bigint();
    let envelope;
    if (mode === "preview") {
      const preview = a.previewCommit(next);
      envelope = a.commit(next, { preview });
    } else {
      envelope = a.commit(next);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const after = process.memoryUsage();
    const peakAfter = process.resourceUsage().maxRSS;
    const mb = (bytes) => +(bytes / 2 ** 20).toFixed(1);
    process.stdout.write(
      JSON.stringify({
        shape,
        mode,
        ms: Math.round(ms),
        heapMB: mb(after.heapUsed - before.heapUsed),
        abMB: mb(after.arrayBuffers - before.arrayBuffers),
        extMB: mb(after.external - before.external),
        peakRssMB: mb(peakAfter * 1024),
        peakRssDeltaMB: mb((peakAfter - peakBefore) * 1024),
        patchKB: Math.round(
          (envelope.patch instanceof Uint8Array
            ? envelope.patch.byteLength
            : JSON.stringify(envelope.patch).length) / 1024,
        ),
        parents: envelope.parents.length,
      }),
    );
  })();
}
