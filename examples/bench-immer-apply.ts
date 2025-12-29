import { performance } from "node:perf_hooks";
import { DbDocumentImmer } from "../src/db-document-immer";
import { DbDocument, fromString as fromStringImmutable } from "../src/db-document-immutable";

type RecordRow = {
  id: number;
  text: string;
  count: number;
};

type BenchOptions = {
  records: number;
  patches: number;
  textLen: number;
  seed: number;
};

const DEFAULTS: BenchOptions = {
  records: 500,
  patches: 1000,
  textLen: 40,
  seed: 1,
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getOptions = (): BenchOptions => ({
  records: parseNumber(process.env.RECORDS, DEFAULTS.records),
  patches: parseNumber(process.env.PATCHES, DEFAULTS.patches),
  textLen: parseNumber(process.env.TEXT_LEN, DEFAULTS.textLen),
  seed: parseNumber(process.env.SEED, DEFAULTS.seed),
});

const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randInt = (rng: () => number, maxExclusive: number) =>
  Math.floor(rng() * maxExclusive);

const randText = (rng: () => number, len: number) => {
  const chars = "abcdefghijklmnopqrstuvwxyz ";
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += chars.charAt(randInt(rng, chars.length));
  }
  return out.trim() || "x";
};

const buildBaseRecords = (
  count: number,
  textLen: number,
  rng: () => number,
): RecordRow[] => {
  const rows: RecordRow[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: i,
      text: randText(rng, textLen),
      count: randInt(rng, 1000),
    });
  }
  return rows;
};

const mutateRecords = (
  records: RecordRow[],
  rng: () => number,
  textLen: number,
  nextId: number,
) => {
  const r = rng();
  const updated = records.slice();
  if (updated.length === 0 || r < 0.15) {
    updated.push({
      id: nextId,
      text: randText(rng, textLen),
      count: randInt(rng, 1000),
    });
    return { records: updated, nextId: nextId + 1 };
  }
  if (r < 0.25) {
    const idx = randInt(rng, updated.length);
    updated.splice(idx, 1);
    return { records: updated, nextId };
  }
  const idx = randInt(rng, updated.length);
  const row = updated[idx];
  updated[idx] = {
    ...row,
    text: `${row.text} ${randText(rng, Math.max(5, Math.floor(textLen / 4)))}`,
    count: row.count + 1,
  };
  return { records: updated, nextId };
};

const generatePatches = (
  baseRecords: RecordRow[],
  opts: BenchOptions,
  rng: () => number,
) => {
  const primaryKeys = new Set<string>(["id"]);
  const stringCols = new Set<string>(["text"]);
  let currentRecords = baseRecords.slice();
  let nextId = baseRecords.length;
  let doc = new DbDocumentImmer(primaryKeys, stringCols, currentRecords);
  const patches: unknown[] = [];
  for (let i = 0; i < opts.patches; i += 1) {
    const mutated = mutateRecords(currentRecords, rng, opts.textLen, nextId);
    currentRecords = mutated.records;
    nextId = mutated.nextId;
    const nextDoc = new DbDocumentImmer(primaryKeys, stringCols, currentRecords);
    patches.push(doc.makePatch(nextDoc));
    doc = nextDoc;
  }
  return { patches, finalRecords: currentRecords };
};

const applyPatches = <T extends { applyPatch: (patch: unknown) => T }>(
  doc: T,
  patches: unknown[],
) => {
  let current = doc;
  for (const patch of patches) {
    current = current.applyPatch(patch);
  }
  return current;
};

const applyBatch = <T extends { applyPatch: (patch: unknown) => T }>(
  doc: T,
  patches: unknown[],
) => {
  const maybeBatch = doc as T & {
    applyPatchBatch?: (patches: unknown[]) => T;
  };
  if (typeof maybeBatch.applyPatchBatch === "function") {
    return maybeBatch.applyPatchBatch(patches);
  }
  return applyPatches(doc, patches);
};

const measure = (label: string, fn: () => void) => {
  const start = performance.now();
  fn();
  const end = performance.now();
  return { label, ms: end - start };
};

const main = () => {
  const opts = getOptions();
  const rng = mulberry32(opts.seed);
  const baseRecords = buildBaseRecords(opts.records, opts.textLen, rng);
  const primaryKeys = new Set<string>(["id"]);
  const stringCols = new Set<string>(["text"]);
  const jsonl = baseRecords.map((row) => JSON.stringify(row)).join("\n");

  const { patches, finalRecords } = generatePatches(baseRecords, opts, rng);

  const immerBase = new DbDocumentImmer(primaryKeys, stringCols, baseRecords);
  const immutableBase = fromStringImmutable(jsonl, primaryKeys, stringCols);
  const finalJsonl = finalRecords.map((row) => JSON.stringify(row)).join("\n");

  // Warmup
  applyPatches(immerBase, patches);
  applyPatches(immutableBase, patches);
  applyBatch(immerBase, patches);
  applyBatch(immutableBase, patches);

  const immerResult = measure("immer.applyPatch", () => {
    applyPatches(immerBase, patches);
  });
  const immutableResult = measure("immutable.applyPatch", () => {
    applyPatches(immutableBase, patches);
  });
  const immerBatchResult = measure("immer.applyPatchBatch", () => {
    applyBatch(immerBase, patches);
  });
  const immutableBatchResult = measure("immutable.applyPatchBatch", () => {
    applyBatch(immutableBase, patches);
  });

  const immerFinal = applyPatches(immerBase, patches).toString();
  const immutableFinal = applyPatches(immutableBase, patches).toString();
  const immerBatchFinal = applyBatch(immerBase, patches).toString();
  const immutableBatchFinal = applyBatch(immutableBase, patches).toString();
  const matches = immerFinal === immutableFinal && immutableFinal === finalJsonl;
  const matchesBatch =
    immerBatchFinal === immutableBatchFinal && immutableBatchFinal === finalJsonl;

  // eslint-disable-next-line no-console
  console.log(
    [
      `records=${opts.records}`,
      `patches=${opts.patches}`,
      `textLen=${opts.textLen}`,
      `seed=${opts.seed}`,
      `matches=${matches}`,
      `matchesBatch=${matchesBatch}`,
    ].join(" "),
  );
  // eslint-disable-next-line no-console
  console.log(`${immerResult.label}: ${immerResult.ms.toFixed(2)} ms`);
  // eslint-disable-next-line no-console
  console.log(`${immutableResult.label}: ${immutableResult.ms.toFixed(2)} ms`);
  // eslint-disable-next-line no-console
  console.log(`${immerBatchResult.label}: ${immerBatchResult.ms.toFixed(2)} ms`);
  // eslint-disable-next-line no-console
  console.log(
    `${immutableBatchResult.label}: ${immutableBatchResult.ms.toFixed(2)} ms`,
  );
};

main();
