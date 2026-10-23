/*
Benchmark compactHistory on a long linear history of a large text.

  pnpm bench:compact [patches] [kilobytes]

Builds a history of `patches` one-line edits (one a minute) to a text of
about `kilobytes` KB that starts as a snapshot, with a snapshot every
`every` patches as CoCalc stores them (0: none), then compacts it with
several policies, reporting time, memory, versions and bytes.

  pnpm bench:compact [patches] [kilobytes] [every]
*/

import { compactHistory, type CompactionPolicy } from "../src/compact-history";
import { mergeStrings3 } from "../src/merge3";
import { encodePatchId } from "../src/patch-id";
import { StringDocument } from "../src/string-document";
import type { DocCodec, Patch } from "../src/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const codec: DocCodec = {
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

const n = Number(process.argv[2] ?? 50_000);
// (Up to about 700 KB: from about 800 KB, @cocalc/diff-match-patch 1.1.0's
// work budget runs out on any edit and patches replace the whole text.)
const kb = Number(process.argv[3] ?? 500);
const every = Number(process.argv[4] ?? 300);
const T0 = 19_675 * DAY;

let t = Date.now();
const lines = Array.from({ length: Math.ceil((kb * 1024) / 64) }, (_, i) =>
  `line ${i} ${"x".repeat(56)}`.slice(0, 63),
);
let prev = codec.fromString(lines.join("\n"));
const patches: Patch[] = [
  {
    time: encodePatchId(T0, "u0"),
    parents: [],
    userId: 0,
    isSnapshot: true,
    snapshot: prev.toString(),
  },
];
for (let i = 1; i < n; i++) {
  const k = (i * 7919) % lines.length;
  lines[k] = `${lines[k].slice(0, 40)} edit ${i}`;
  const next = codec.fromString(lines.join("\n"));
  // As a store would deliver them (JSON): a generated diff of a whole text
  // is made of slices of it, which would keep every version alive.
  patches.push(
    JSON.parse(
      JSON.stringify({
        time: encodePatchId(T0 + i * MINUTE, `u${i % 7}`),
        parents: [patches[i - 1].time],
        userId: i % 7,
        patch: codec.makePatch(prev, next),
        ...(every > 0 && i % every === 0 ? { isSnapshot: true, snapshot: next.toString() } : {}),
      }),
    ),
  );
  prev = next;
}
const input = patches;
console.log(`built ${n} patches on ${kb} KB (snapshot every ${every}) in ${Date.now() - t} ms`);

const now = T0 + n * MINUTE;
const policies: [string, CompactionPolicy][] = [
  ["latestOnly", { kind: "latestOnly" }],
  ["uniform 1 day", { kind: "uniform", interval: DAY }],
  [
    "tiered",
    {
      kind: "tiered",
      tiers: [
        { olderThan: 2 * DAY, interval: HOUR },
        { olderThan: 7 * DAY, interval: DAY },
        { olderThan: 30 * DAY, interval: 7 * DAY },
      ],
    },
  ],
  ["keepSince 1 day", { kind: "keepSince", since: now - DAY }],
];
for (const [name, policy] of policies) {
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  t = Date.now();
  const { stats, patches: out } = compactHistory({ patches: input, codec, policy, now });
  const sizes = out.map((p) => JSON.stringify(p).length).sort((a, b) => b - a);
  global.gc?.();
  const ms = Date.now() - t;
  const heap = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6); // retained
  console.log(
    `${name.padEnd(16)} ${String(ms).padStart(7)} ms  heap +${heap} MB  ` +
      `versions ${stats.versionsBefore} -> ${stats.versionsAfter}  ` +
      `bytes ${stats.bytesBefore} -> ${stats.bytesAfter}  diffs ${stats.diffs}  ` +
      `largest ${sizes.slice(0, 3).join(",")}  over 100k ${sizes.filter((x) => x > 100_000).length}`,
  );
}
