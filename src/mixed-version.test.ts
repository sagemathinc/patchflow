/*
Measurement (opt-in, MIXED_FUZZ=1): clients with exact merges (new) and
clients without (old, applying all patches in time order) editing the same
text, as during a deploy before everyone has reloaded. Reports how often old
and new clients show different text once all patches are delivered, and
whether they agree again after everyone makes one more edit.
MIXED_FUZZ_RUNS (default 200), MIXED_FUZZ_DELAY (default 300 ms).
*/

import { Session } from "./session";
import { mergeStrings3 } from "./merge3";
import { StringDocument } from "./string-document";
import type { DocCodec, PatchEnvelope, PatchStore } from "./types";

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
const { merge3: _unused, ...oldCodec } = exactCodec;
void _unused;

const RUNS = Number(process.env.MIXED_FUZZ_RUNS ?? 200);
const DELAY = Number(process.env.MIXED_FUZZ_DELAY ?? 300);

async function run(seed: number) {
  let s = seed;
  const rng = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let clock = 1_000_000;
  const kinds = (process.env.MIXED_KINDS ?? "new,new,old").split(",") as ("new" | "old")[];
  const n = kinds.length;
  const listeners: ((env: PatchEnvelope) => void)[][] = Array.from({ length: n }, () => []);
  // In order per recipient, as a CoCalc stream delivers.
  const stream: PatchEnvelope[] = [];
  const arrival: number[] = [];
  const received = Array(n).fill(0);
  const store = (): PatchStore => ({
    loadInitial: async () => ({ patches: [] }),
    append: (env) => {
      stream.push(env);
      arrival.push(clock + Math.floor(rng() * DELAY));
    },
    subscribe: (fn) => {
      const id = subscribers++;
      listeners[id].push(fn);
      return () => {};
    },
  });
  let subscribers = 0;
  const deliver = (all = false) => {
    for (let to = 0; to < n; to++) {
      while (received[to] < stream.length && (all || arrival[received[to]] <= clock)) {
        const env = stream[received[to]++];
        for (const fn of listeners[to]) fn(env);
      }
    }
  };
  const sessions: Session[] = [];
  for (let id = 0; id < n; id++) {
    const session = new Session({
      codec: kinds[id] === "new" ? exactCodec : oldCodec,
      patchStore: store(),
      clock: () => clock,
      userId: id + 1,
      clientId: `c${id}`,
    });
    await session.init();
    sessions.push(session);
  }
  const edit = (c: number) => {
    const lines = sessions[c].getDocument().toString().split("\n").filter(Boolean);
    if (lines.length > 4 && rng() < 0.3) lines.splice(Math.floor(rng() * lines.length), 1);
    else if (lines.length > 0 && rng() < 0.3) {
      const i = Math.floor(rng() * lines.length);
      lines[i] = lines[i] + " x";
    } else lines.splice(Math.floor(rng() * (lines.length + 1)), 0, `t${clock}`);
    sessions[c].commit(exactCodec.fromString(lines.join("\n") + "\n"));
  };
  for (let step = 0; step < 100; step++) {
    clock += Math.floor(rng() * 400);
    deliver();
    edit(Math.floor(rng() * n));
  }
  clock += 10_000;
  deliver(true);
  const values = sessions.map((x) => x.getDocument().toString());
  const newAgree = values[0] === values[1];
  const sorted = (v: string) => v.split("\n").filter(Boolean).sort().join("\n");
  const sameLines = new Set(values.map(sorted)).size === 1;
  const allAgree = new Set(values).size === 1;
  // Everyone edits once more, sequentially with full delivery in between.
  for (let c = 0; c < n; c++) {
    clock += 1000;
    edit(c);
    clock += 10_000;
    deliver(true);
  }
  const after = sessions.map((x) => x.getDocument().toString());
  return { newAgree, allAgree, sameLines, agreeAfter: new Set(after).size === 1 };
}

(process.env.MIXED_FUZZ ? describe : describe.skip)("mixed old and new clients", () => {
  it("measures disagreement", async () => {
    let newDisagree = 0;
    let disagree = 0;
    let stillAfter = 0;
    let contentDiffers = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = await run(seed);
      if (!r.newAgree) newDisagree++;
      if (!r.allAgree) disagree++;
      if (!r.agreeAfter) stillAfter++;
      if (!r.sameLines) contentDiffers++;
    }
    // eslint-disable-next-line no-console
    console.log(
      `mixed versions, ${RUNS} sessions (delay ${DELAY} ms): new clients disagree ${newDisagree}, ` +
        `old and new disagree ${disagree} (different lines, not just order: ${contentDiffers}), ` +
        `still disagree after one more edit each ${stillAfter}`,
    );
    expect(newDisagree).toBe(0);
  }, 600_000);
});
