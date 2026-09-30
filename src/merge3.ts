import { DiffMatchPatch } from "@cocalc/diff-match-patch";

// Deterministic three-way merge of strings in the style of diff3, used to merge
// concurrent heads of a patch graph from their common ancestor.
//
// Properties:
// - Identical net changes on both sides apply once, even when the two diffs
//   express them differently (chunk contents are compared, not edits).
// - Nothing is relocated by fuzzy matching, so a deletion never lands on
//   similar text elsewhere.
// - Changes are aligned by lines (blank lines are not used as anchors, since
//   the two diffs may match different ones). Where both sides changed the same
//   lines they are merged line by line: a line both edited is merged by whole
//   words; characters of different words or lines are never spliced together.
// - Nothing either side typed is dropped: concurrent insertions are both kept,
//   a modification beats a concurrent deletion, a whitespace-only change never
//   overrides content, and where both sides replaced the same words or line
//   differently both versions are kept.
// - Symmetric: where both sides' text is kept at one place, it is ordered by
//   content rather than by side, so merging a into b and b into a agree.

type Diff = [number, string][];

const dmp = new DiffMatchPatch();
dmp.diffTimeout = 0.2;

function lineDiff(base: string, target: string): Diff {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars(base, target);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines(diffs, lineArray);
  return diffs as Diff;
}

// Diff by whole words, runs of whitespace and single punctuation characters,
// so a changed word is always a chunk of its own.
function wordDiff(base: string, target: string): Diff {
  const tokenize = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const ids = new Map<string, string>();
  const tokens: string[] = [];
  const encode = (text: string) =>
    tokenize(text)
      .map((token) => {
        let id = ids.get(token);
        if (id === undefined) {
          id = String.fromCharCode(tokens.length);
          ids.set(token, id);
          tokens.push(token);
        }
        return id;
      })
      .join("");
  const a = encode(base);
  const b = encode(target);
  if (tokens.length > 0xffff) return charDiff(base, target);
  const diffs = dmp.diff_main(a, b, false) as Diff;
  return diffs.map(([op, ids]) => [op, Array.from(ids, (id) => tokens[id.charCodeAt(0)]).join("")]);
}

function charDiff(base: string, target: string): Diff {
  return dmp.diff_main(base, target) as Diff;
}

interface Run {
  from: number;
  to: number;
  target: number;
}

// Unchanged spans of base in a diff, with their offsets in the target.
function equalRuns(diffs: Diff): Run[] {
  const runs: Run[] = [];
  let b = 0;
  let t = 0;
  for (const [op, text] of diffs) {
    if (op === 0) {
      runs.push({ from: b, to: b + text.length, target: t });
      b += text.length;
      t += text.length;
    } else if (op === -1) {
      b += text.length;
    } else {
      t += text.length;
    }
  }
  return runs;
}

// Map a base offset to the target. Changes exactly at a run boundary belong to
// the chunk before the next stable span: a chunk start maps through the run
// ending at the offset, a chunk end through the run starting there.
function mapOffset(runs: Run[], offset: number, side: "start" | "end"): number {
  const preferred = runs.find((run) =>
    side === "start" ? run.to === offset : run.from === offset,
  );
  const run = preferred ?? runs.find((r) => r.from <= offset && offset <= r.to);
  if (run == null) throw new Error("merge3: offset outside unchanged runs");
  return run.target + (offset - run.from);
}

interface Chunk {
  base: string;
  a: string;
  b: string;
}

function diff3(
  base: string,
  a: string,
  b: string,
  diff: (x: string, y: string) => Diff,
  conflict: (chunk: Chunk) => string,
  isAnchor: (text: string) => boolean = () => true,
): string {
  const aRuns = equalRuns(diff(base, a));
  const bRuns = equalRuns(diff(base, b));
  const stable: { from: number; to: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < aRuns.length && j < bRuns.length) {
    const from = Math.max(aRuns[i].from, bRuns[j].from);
    const to = Math.min(aRuns[i].to, bRuns[j].to);
    if (from < to && isAnchor(base.slice(from, to))) stable.push({ from, to });
    if (aRuns[i].to < bRuns[j].to) i++;
    else j++;
  }
  let out = "";
  let startBase = 0;
  let startA = 0;
  let startB = 0;
  const emit = (endBase: number, endA: number, endB: number) => {
    const chunk = {
      base: base.slice(startBase, endBase),
      a: a.slice(startA, endA),
      b: b.slice(startB, endB),
    };
    if (chunk.a === chunk.b) out += chunk.a;
    else if (chunk.a === chunk.base) out += chunk.b;
    else if (chunk.b === chunk.base) out += chunk.a;
    else out += conflict(chunk);
  };
  for (const span of stable) {
    emit(span.from, mapOffset(aRuns, span.from, "end"), mapOffset(bRuns, span.from, "end"));
    out += base.slice(span.from, span.to);
    startBase = span.to;
    startA = mapOffset(aRuns, span.to, "start");
    startB = mapOffset(bRuns, span.to, "start");
  }
  emit(base.length, a.length, b.length);
  return out;
}

const sameIgnoringWhitespace = (x: string, y: string) =>
  x.replace(/\s+/g, "") === y.replace(/\s+/g, "");

interface Edit {
  from: number;
  to: number;
  insert: string;
}

function diffToEdits(diffs: Diff): Edit[] {
  const edits: Edit[] = [];
  let cursor = 0;
  let current: Edit | undefined;
  for (const [op, text] of diffs) {
    if (op === 0) {
      if (current) edits.push(current);
      current = undefined;
      cursor += text.length;
      continue;
    }
    current ??= { from: cursor, to: cursor, insert: "" };
    if (op === -1) {
      current.to += text.length;
      cursor += text.length;
    } else {
      current.insert += text;
    }
  }
  if (current) edits.push(current);
  return edits;
}

const isInsertion = (e: Edit) => e.from === e.to;

// Edits conflict if they overlap or an insertion touches the other edit (so
// that text both sides added there, e.g. the same line moved, is unioned);
// two pure insertions never conflict, as both are kept.
function conflicts(x: Edit, y: Edit): boolean {
  if (isInsertion(x) && isInsertion(y)) return false;
  if (isInsertion(x)) return x.from >= y.from && x.from <= y.to;
  if (isInsertion(y)) return y.from >= x.from && y.from <= x.to;
  return x.from < y.to && y.from < x.to;
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += text.slice(cursor, e.from) + e.insert;
    cursor = e.to;
  }
  return out + text.slice(cursor);
}

// Merge a conflicting chunk edit by edit: identical edits apply once,
// non-conflicting edits from both sides apply (so new text from either side is
// kept), and only clusters of truly overlapping edits go to `resolve`.
function editUnion(
  chunk: Chunk,
  diff: (x: string, y: string) => Diff,
  resolve: (chunk: Chunk) => string,
): string {
  const { base } = chunk;
  const applyOne = (e: Edit) => base.slice(0, e.from) + e.insert + base.slice(e.to);
  const aEdits = diffToEdits(diff(base, chunk.a));
  const aResults = aEdits.map(applyOne);
  const bEdits: Edit[] = [];
  for (const e of diffToEdits(diff(base, chunk.b))) {
    if (!aResults.includes(applyOne(e))) bEdits.push(e);
  }
  // Insertions by both sides at the same place: add their union once.
  for (let i = bEdits.length - 1; i >= 0; i--) {
    const e = bEdits[i];
    const same = isInsertion(e)
      ? aEdits.find((x) => isInsertion(x) && x.from === e.from)
      : undefined;
    if (!same) continue;
    same.insert = unionLines(same.insert, e.insert);
    bEdits.splice(i, 1);
  }
  const all = [
    ...aEdits.map((edit) => ({ edit, side: "a" as const })),
    ...bEdits.map((edit) => ({ edit, side: "b" as const })),
  ].sort(
    (x, y) =>
      x.edit.from - y.edit.from ||
      Number(isInsertion(y.edit)) - Number(isInsertion(x.edit)) ||
      (x.side === y.side ? 0 : x.side === "a" ? -1 : 1) ||
      x.edit.to - y.edit.to,
  );
  const clusters: { from: number; to: number; items: typeof all }[] = [];
  for (const item of all) {
    const last = clusters[clusters.length - 1];
    if (last && last.items.some((other) => conflicts(other.edit, item.edit))) {
      last.items.push(item);
      last.to = Math.max(last.to, item.edit.to);
    } else {
      clusters.push({ from: item.edit.from, to: item.edit.to, items: [item] });
    }
  }
  let out = "";
  let cursor = 0;
  for (const cluster of clusters) {
    out += base.slice(cursor, cluster.from);
    const region = base.slice(cluster.from, cluster.to);
    const shifted = (side: "a" | "b") =>
      cluster.items
        .filter((i) => i.side === side)
        .map((i) => ({
          from: i.edit.from - cluster.from,
          to: i.edit.to - cluster.from,
          insert: i.edit.insert,
        }));
    const aIn = shifted("a");
    const bIn = shifted("b");
    if (bIn.length === 0) out += applyEdits(region, aIn);
    else if (aIn.length === 0) out += applyEdits(region, bIn);
    else out += resolve({ base: region, a: applyEdits(region, aIn), b: applyEdits(region, bIn) });
    cursor = cluster.to;
  }
  return out + base.slice(cursor);
}

// Union of two sequences of added lines at the same place: lines common to both
// appear once, the others in a canonical order (so the merge is symmetric).
function unionLines(x: string, y: string): string {
  if (x === y) return x;
  // Canonical order, so merging a into b and b into a agree.
  if (y < x) [x, y] = [y, x];
  return lineDiff(x, y)
    .map(([, text]) => text)
    .join("");
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type LineState = { kind: "kept" } | { kind: "deleted" } | { kind: "modified"; text: string };

// How one side changed each base line of a region: kept, deleted or modified
// (an inserted line that keeps enough of a deleted base line, paired in
// order), plus the lines it added before each base line (and at the end).
function lineChanges(baseLines: string[], base: string, text: string) {
  const state: LineState[] = baseLines.map(() => ({ kind: "kept" }));
  const before: string[][] = [...baseLines.map(() => []), []];
  let i = 0;
  let deleted: number[] = [];
  let inserted: string[] = [];
  const flush = () => {
    let next = 0;
    for (const line of inserted) {
      let k = next;
      while (k < deleted.length && !isEditOf(baseLines[deleted[k]], line)) k++;
      if (k < deleted.length) {
        for (let m = next; m < k; m++) state[deleted[m]] = { kind: "deleted" };
        state[deleted[k]] = { kind: "modified", text: line };
        next = k + 1;
      } else {
        before[next < deleted.length ? deleted[next] : i].push(line);
      }
    }
    for (let m = next; m < deleted.length; m++) state[deleted[m]] = { kind: "deleted" };
    deleted = [];
    inserted = [];
  };
  for (const [op, run] of lineDiff(base, text)) {
    const lines = splitLines(run);
    if (op === 0) {
      flush();
      i += lines.length;
    } else if (op === -1) {
      for (let k = 0; k < lines.length; k++) deleted.push(i++);
    } else {
      inserted.push(...lines);
    }
  }
  flush();
  return { state, before };
}

// Line-level three-way merge of a region both sides changed. Per base line:
// kept by both stays; changed by one side takes that change; modified by both
// is merged word by word; a modification beats a concurrent deletion. Lines
// either side added are kept at their place (identical additions once). So
// nothing typed is lost, and no text of different lines is fused together.
function lineUnion(chunk: Chunk): string {
  const baseLines = splitLines(chunk.base);
  const a = lineChanges(baseLines, chunk.base, chunk.a);
  const b = lineChanges(baseLines, chunk.base, chunk.b);
  // A line one side moved (deleted and added unchanged elsewhere) and the other
  // modified in place ends up once, modified, where it was moved to.
  for (const [x, y] of [
    [a, b],
    [b, a],
  ]) {
    for (const added of x.before) {
      for (let k = 0; k < added.length; k++) {
        const j = baseLines.findIndex(
          (line, j) =>
            line === added[k] && x.state[j].kind === "deleted" && y.state[j].kind === "modified",
        );
        if (j === -1) continue;
        added[k] = (y.state[j] as { text: string }).text;
        y.state[j] = { kind: "deleted" };
      }
    }
  }
  let out = "";
  for (let i = 0; i <= baseLines.length; i++) {
    out += unionLines(a.before[i].join(""), b.before[i].join(""));
    if (i < baseLines.length) out += mergeLineStates(baseLines[i], a.state[i], b.state[i]);
  }
  return out;
}

function mergeLineStates(base: string, x: LineState, y: LineState): string {
  if (x.kind === "kept") return y.kind === "kept" ? base : y.kind === "deleted" ? "" : y.text;
  if (y.kind === "kept") return x.kind === "deleted" ? "" : x.text;
  if (x.kind === "deleted") return y.kind === "deleted" ? "" : y.text;
  if (y.kind === "deleted") return x.text;
  if (x.text === y.text) return x.text;
  return diff3(base, x.text, y.text, wordDiff, mergeWords);
}

// Whether `text` is an edit of the line `base` rather than a different line: it
// keeps at least a third of base's (non-whitespace) text.
function isEditOf(base: string, text: string): boolean {
  const size = (s: string) => s.replace(/\s/g, "").length;
  const total = size(base);
  if (total === 0) return false;
  let kept = 0;
  for (const [op, run] of wordDiff(base, text)) if (op === 0) kept += size(run);
  return kept * 3 >= total;
}

// A conflicting chunk where one side only added text before or after the base
// (for example, a new line next to a line the other side deleted or changed):
// apply the other side's change and keep the added text.
function combineAdjacent(chunk: Chunk, words = false): string | undefined {
  const { base, a, b } = chunk;
  if (base === "") return undefined;
  // For words, only text added at a word boundary counts as added next to the
  // base ("hello" -> "hello there", not "hello" -> "helloy").
  const wordChar = /[\p{L}\p{N}_]/u;
  const joins = (left: string, right: string) =>
    !words || !wordChar.test(left.slice(-1)) || !wordChar.test(right.slice(0, 1));
  const pre = (x: string) =>
    x.startsWith(base) && joins(base, x.slice(base.length)) ? x.slice(base.length) : undefined; // x = base + y
  const post = (x: string) =>
    x.endsWith(base) && joins(x.slice(0, x.length - base.length), base)
      ? x.slice(0, x.length - base.length)
      : undefined; // x = y + base
  const aPre = pre(a);
  const aPost = post(a);
  const bPre = pre(b);
  const bPost = post(b);
  const both = (x: string, y: string) => (x <= y ? x + y : y + x);
  if (aPre != null && bPre != null) return base + both(aPre, bPre);
  if (aPost != null && bPost != null) return both(aPost, bPost) + base;
  if (bPre != null) return a + bPre;
  if (bPost != null) return bPost + a;
  if (aPre != null) return b + aPre;
  if (aPost != null) return aPost + b;
  return undefined;
}

const withAdjacent =
  (next: (chunk: Chunk) => string) =>
  (chunk: Chunk): string =>
    combineAdjacent(chunk) ?? next(chunk);

// Delete versus modify: keep the modification, so text a user just typed is
// never silently discarded by a concurrent deletion of the surrounding text.
function preferEdit(chunk: Chunk): string | undefined {
  const aGone = chunk.a.trim() === "";
  const bGone = chunk.b.trim() === "";
  if (aGone && !bGone) return chunk.b;
  if (bGone && !aGone) return chunk.a;
  return undefined;
}

// Both sides replaced the same text differently. Keep both versions (in a
// canonical order, so the merge is symmetric):
// a visible duplicate is easy to fix, while silently dropping what someone
// typed is not.
function keepBoth(chunk: Chunk): string {
  const [a, b] = chunk.a <= chunk.b ? [chunk.a, chunk.b] : [chunk.b, chunk.a];
  const joined = /\s$/.test(a) || /^\s/.test(b) || a === "" || b === "";
  return joined ? a + b : `${a} ${b}`;
}

// Both sides changed the same words: keep both versions rather than splicing
// characters of two different edits into a word neither of them typed.
function mergeWords(words: Chunk): string {
  return combineAdjacent(words, true) ?? resolveTrivial(words) ?? keepBoth(words);
}

function resolveTrivial(chunk: Chunk): string | undefined {
  if (chunk.base === "") return chunk.a <= chunk.b ? chunk.a + chunk.b : chunk.b + chunk.a;
  if (sameIgnoringWhitespace(chunk.base, chunk.a)) return chunk.b;
  if (sameIgnoringWhitespace(chunk.base, chunk.b)) return chunk.a;
  return preferEdit(chunk);
}

export function mergeStrings3(opts: {
  base: string;
  a: string;
  b: string;
  // Values of the common ancestors when `base` is itself a merge of several
  // (criss-cross history); see DocCodec.merge3.
  ancestors?: string[];
}): string {
  const { base, a, b, ancestors } = opts;
  if (a === b) return a;
  if (base === a) return b;
  if (base === b) return a;
  const merged = diff3(
    base,
    a,
    b,
    lineDiff,
    withAdjacent((lines) => editUnion(lines, lineDiff, (region) => lineUnion(region))),
    (text) => text.trim() !== "",
  );
  return ancestors?.length ? dropReappearedLines(merged, [base, ...ancestors], a, b) : merged;
}

function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.trim() !== "") counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

// A criss-cross merge base is itself a merge and can order or omit lines that
// the common ancestors, and so both sides, already had; the merge then sees one
// line added by both sides and may keep it twice. Each line may appear at most
// as often as a + b - (copies already in some common ancestor); later copies
// beyond that are dropped. Lines both sides added independently are kept.
function dropReappearedLines(merged: string, bases: string[], a: string, b: string): string {
  const inA = countLines(a);
  const inB = countLines(b);
  const baseCounts = bases.map(countLines);
  const excess = new Map<string, number>();
  for (const [line, n] of countLines(merged)) {
    const known = Math.max(...baseCounts.map((c) => c.get(line) ?? 0));
    if (known === 0) continue;
    const allowed = Math.max(
      inA.get(line) ?? 0,
      inB.get(line) ?? 0,
      (inA.get(line) ?? 0) + (inB.get(line) ?? 0) - known,
    );
    if (n > allowed) excess.set(line, n - allowed);
  }
  if (excess.size === 0) return merged;
  const lines = merged.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const extra = excess.get(lines[i]);
    if (!extra) continue;
    excess.set(lines[i], extra - 1);
    lines.splice(i, 1);
  }
  return lines.join("\n");
}
