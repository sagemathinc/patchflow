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

// Every replica must compute the same merge from the same patches, so no
// result may depend on wall-clock time: diff-match-patch's deadline is
// disabled, and work is bounded deterministically by diffUnits instead.
const dmp = new DiffMatchPatch();
dmp.diffTimeout = 0;

// Above this many (base units x target units) in the part between the common
// prefix and suffix, the middle is treated as one replacement instead of
// being diffed (Myers diff is O((n + m) d) time).
const MAX_DIFF_PRODUCT = 4_000_000;

// Diff two strings of units (characters, or characters standing for lines or
// words) deterministically.
function diffUnits(a: string, b: string): Diff {
  let prefix = 0;
  const minLength = Math.min(a.length, b.length);
  while (prefix < minLength && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minLength - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }
  const middle = (a.length - prefix - suffix) * (b.length - prefix - suffix);
  if (middle <= MAX_DIFF_PRODUCT) {
    return dmp.diff_main(a, b, false) as Diff;
  }
  const diffs: Diff = [
    [0, a.slice(0, prefix)],
    [-1, a.slice(prefix, a.length - suffix)],
    [1, b.slice(prefix, b.length - suffix)],
    [0, a.slice(a.length - suffix)],
  ];
  dmp.diff_cleanupMerge(diffs as any);
  return diffs.filter(([, text]) => text !== "");
}

function lineDiff(base: string, target: string): Diff {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars(base, target);
  const diffs = diffUnits(chars1, chars2);
  dmp.diff_charsToLines(diffs, lineArray);
  return diffs as Diff;
}

// Diff by whole words (and single punctuation characters), aligned by the
// words alone: the text is split into units of a word and the whitespace
// before it, the sequence of words is diffed, and a matched word whose
// preceding whitespace changed becomes a small whitespace change before an
// unchanged word. So a changed word is always a chunk of its own, a diff
// never matches a space instead of a word, and a whitespace change does not
// hide a matching word.
function wordDiff(base: string, target: string): Diff {
  const units = (text: string) => {
    const out: { space: string; word: string }[] = [];
    const re = /(\s*)([\p{L}\p{N}_]+|[^\s\p{L}\p{N}_])/gu;
    let end = 0;
    for (let m = re.exec(text); m != null; m = re.exec(text)) {
      out.push({ space: m[1], word: m[2] });
      end = re.lastIndex;
    }
    if (end < text.length) out.push({ space: text.slice(end), word: "" });
    return out;
  };
  const a = units(base);
  const b = units(target);
  const ids = new Map<string, string>();
  const encode = (list: { word: string }[]) =>
    list
      .map(({ word }) => {
        let id = ids.get(word);
        if (id === undefined) {
          id = String.fromCharCode(ids.size);
          ids.set(word, id);
        }
        return id;
      })
      .join("");
  const x = encode(a);
  const y = encode(b);
  if (ids.size > 0xffff) return charDiff(base, target);
  const out: Diff = [];
  const push = (op: number, text: string) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last != null && last[0] === op) last[1] += text;
    else out.push([op, text]);
  };
  let i = 0;
  let j = 0;
  for (const [op, run] of diffUnits(x, y)) {
    for (let k = 0; k < run.length; k++) {
      if (op === 0) {
        const u = a[i++];
        const v = b[j++];
        if (u.space === v.space) {
          push(0, u.space + u.word);
        } else {
          push(-1, u.space);
          push(1, v.space);
          push(0, u.word);
        }
      } else if (op === -1) {
        const u = a[i++];
        push(-1, u.space + u.word);
      } else {
        const v = b[j++];
        push(1, v.space + v.word);
      }
    }
  }
  return out;
}

function charDiff(base: string, target: string): Diff {
  return diffUnits(base, target);
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

// Edits of a line diff. Changes separated only by unchanged blank lines form
// one edit (the blank lines are replaced by themselves), since blank lines are
// not reliable anchors: otherwise one change could be split around a blank
// line that the other side's diff matched differently.
function diffToEdits(diffs: Diff): Edit[] {
  const edits: Edit[] = [];
  let cursor = 0;
  let current: Edit | undefined;
  let blank = ""; // unchanged blank lines after `current`, not yet decided
  for (const [op, text] of diffs) {
    if (op === 0) {
      if (current && text.trim() === "") {
        blank += text;
        cursor += text.length;
        continue;
      }
      if (current) edits.push(current);
      current = undefined;
      blank = "";
      cursor += text.length;
      continue;
    }
    if (current && blank) {
      current.to += blank.length;
      current.insert += blank;
    }
    blank = "";
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
  return lineDiff(x, y).reduce((out, [, text]) => joinAdded(out, text, "\n"), "");
}

// Join two pieces of text added at one place, keeping a line (or word)
// boundary between them, so the last line of one and the first of the other
// (e.g. added at the end of a document without a final newline) never fuse.
function joinAdded(x: string, y: string, separator: "\n" | " "): string {
  if (x === "" || y === "") return x + y;
  const boundary = separator === "\n" ? x.endsWith("\n") : /\s$/.test(x) || /^\s/.test(y);
  return boundary ? x + y : x + separator + y;
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type LineState = { kind: "kept" } | { kind: "deleted" } | { kind: "modified"; text: string };

// How one side changed each base line of a region: kept, deleted or modified
// (an inserted line that is an edit of a deleted base line, paired by the best
// in-order alignment), plus the lines it added before each base line (and at
// the end). Blank lines are not anchors here either: an unchanged blank line
// between changes joins them, so an edit is not split around it.
function lineChanges(baseLines: string[], base: string, text: string) {
  const state: LineState[] = baseLines.map(() => ({ kind: "kept" }));
  const before: string[][] = [...baseLines.map(() => []), []];
  let i = 0;
  let deleted: number[] = [];
  let inserted: string[] = [];
  const flush = () => {
    if (deleted.length === 0 && inserted.length === 0) return;
    const pairs = alignLines(
      inserted,
      deleted.map((k) => baseLines[k]),
    );
    let next = 0; // next deleted line not yet decided
    let p = 0;
    for (let n = 0; n < inserted.length; n++) {
      if (p < pairs.length && pairs[p][0] === n) {
        const k = pairs[p][1];
        for (let m = next; m < k; m++) state[deleted[m]] = { kind: "deleted" };
        state[deleted[k]] = { kind: "modified", text: inserted[n] };
        next = k + 1;
        p++;
      } else {
        before[next < deleted.length ? deleted[next] : i].push(inserted[n]);
      }
    }
    for (let m = next; m < deleted.length; m++) state[deleted[m]] = { kind: "deleted" };
    deleted = [];
    inserted = [];
  };
  for (const [op, run] of lineDiff(base, text)) {
    const lines = splitLines(run);
    if (op === 0) {
      if (run.trim() === "" && (deleted.length > 0 || inserted.length > 0)) {
        for (const line of lines) {
          deleted.push(i++);
          inserted.push(line);
        }
        continue;
      }
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

// Best in-order pairing of inserted lines with deleted lines, where a pair is
// the same line or an edit of it, weighted by how much text the deleted line
// has (so a real line wins over a blank one). Returns [inserted, deleted]
// index pairs in order. Large blocks use exact matches only.
function alignLines(inserted: string[], deleted: string[]): [number, number][] {
  const n = inserted.length;
  const m = deleted.length;
  if (n === 0 || m === 0) return [];
  if (n * m > MAX_ALIGN_PAIRS) return alignLinesGreedy(inserted, deleted);
  const ins = inserted.map(wordProfile);
  const del = deleted.map(wordProfile);
  // Scoring every pair costs about m * (words inserted) + n * (words deleted);
  // above a fixed bound use the bounded greedy pairing instead.
  const words = (profiles: WordProfile[]) => profiles.reduce((sum, p) => sum + p.counts.size, 0);
  if (m * words(ins) + n * words(del) > MAX_ALIGN_WORD_WORK) {
    return alignLinesGreedy(inserted, deleted);
  }
  // An edit is weighted by how much of the line it keeps, so among several
  // edits of one line the closest wins; the same line outweighs any edit.
  const weight = (x: number, y: number): number => {
    if (inserted[x] === deleted[y]) return 2 + del[y].total;
    const kept = editScore(del[y], ins[x]) || charEditScore(deleted[y], inserted[x], budget);
    return kept > 0 ? 1 + kept : 0;
  };
  const budget = { left: MAX_CHAR_ALIGN_WORK };
  const w: number[][] = [];
  for (let x = 0; x < n; x++) {
    w.push([]);
    for (let y = 0; y < m; y++) w[x].push(weight(x, y));
  }
  const best: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      const pair = w[x][y] > 0 ? w[x][y] + best[x + 1][y + 1] : 0;
      best[x][y] = Math.max(pair, best[x + 1][y], best[x][y + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    if (w[x][y] > 0 && best[x][y] === w[x][y] + best[x + 1][y + 1]) {
      pairs.push([x, y]);
      x++;
      y++;
    } else if (best[x][y] === best[x + 1][y]) {
      x++;
    } else {
      y++;
    }
  }
  return pairs;
}

// A region both sides changed, merged word by word if their changes touch
// different words (for example, one side split a line and the other edited
// words elsewhere in it), otherwise undefined. Line by line, the split line
// and the edited line would both be kept, duplicating its text.
function cleanWordMerge(chunk: Chunk): string | undefined {
  let clean = true;
  const merged = diff3(chunk.base, chunk.a, chunk.b, wordDiff, (words) => {
    const disjoint = disjointWordEdits(words);
    if (disjoint == null) clean = false;
    return disjoint ?? words.a;
  });
  return clean ? merged : undefined;
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

// Above this many (inserted x deleted) line pairs, alignLines does not build
// its quadratic tables but pairs greedily with a bounded look-ahead.
const MAX_ALIGN_PAIRS = 40_000;
const MAX_ALIGN_WORD_WORK = 4_000_000;
const ALIGN_LOOKAHEAD = 16;

// Linear-time in-order pairing for large blocks: each inserted line pairs
// with the first of the next few unpaired deleted lines that it equals or
// edits.
function alignLinesGreedy(inserted: string[], deleted: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  const del: (WordProfile | undefined)[] = [];
  const profile = (k: number) => (del[k] ??= wordProfile(deleted[k]));
  const budget = { left: MAX_CHAR_ALIGN_WORK };
  let y = 0;
  for (let x = 0; x < inserted.length && y < deleted.length; x++) {
    const end = Math.min(deleted.length, y + ALIGN_LOOKAHEAD);
    const ins = wordProfile(inserted[x]);
    for (let k = y; k < end; k++) {
      if (
        inserted[x] === deleted[k] ||
        editScore(profile(k), ins) > 0 ||
        charEditScore(deleted[k], inserted[x], budget) > 0
      ) {
        pairs.push([x, k]);
        y = k + 1;
        break;
      }
    }
  }
  return pairs;
}

// How much of the line `base` the line `text` keeps if `text` is an edit of it
// rather than a different line (it keeps at least a third of base's
// non-whitespace text), otherwise 0.
function editScore(base: WordProfile, text: WordProfile): number {
  if (base.total === 0) return 0;
  const kept = keptOf(base, text);
  return kept * 3 >= base.total ? kept : 0;
}

// The length of the line `base` if `text` is `base` with text typed into it
// (it keeps all of `base`, at its start and end), otherwise 0. Typing into a
// word changes that word, so editScore no longer sees the line as an edit of
// its base. Short lines are left to editScore: there a line containing
// another ("t11" and "t1") is as likely a different line.
const MIN_TYPED_LINE = 6;
// Characters charEditScore may compare in one alignment, so its cost stays
// bounded (deterministically) however many long lines are aligned.
const MAX_CHAR_ALIGN_WORK = 1_000_000;
function charEditScore(base: string, text: string, budget: { left: number }): number {
  const n = base.length;
  if (base.trim().length < MIN_TYPED_LINE || text.length <= n) return 0;
  if (budget.left < n) return 0;
  budget.left -= n;
  let prefix = 0;
  while (prefix < n && base[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && base[n - 1 - suffix] === text[text.length - 1 - suffix]) {
    suffix++;
  }
  return prefix + suffix === n ? n : 0;
}

// The words (and punctuation) of a line, counted, with their total length.
interface WordProfile {
  counts: Map<string, number>;
  total: number;
}

function wordProfile(line: string): WordProfile {
  const counts = new Map<string, number>();
  let total = 0;
  for (const word of line.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    total += word.length;
  }
  return { counts, total };
}

// How much (non-whitespace) text of the line `base` the line `text` keeps:
// the length of the words they share (as a multiset, ignoring order and
// whitespace). Linear in the lines' lengths; a similarity score for pairing a
// changed line with the line it edits, not an alignment.
function keptOf(base: WordProfile, text: WordProfile): number {
  let kept = 0;
  const [small, large] = base.counts.size <= text.counts.size ? [base, text] : [text, base];
  for (const [word, count] of small.counts) {
    const other = large.counts.get(word);
    if (other != null) kept += Math.min(count, other) * word.length;
  }
  return kept;
}

// A conflicting chunk where one side only added text before or after the base
// (for example, a new line next to a line the other side deleted or changed):
// apply the other side's change and keep the added text.
function combineAdjacent(chunk: Chunk, words = false): string | undefined {
  const { base, a, b } = chunk;
  if (base === "") return undefined;
  // Only text added at a boundary counts as added next to the base: for
  // words a word boundary ("hello" -> "hello there", not "hello" -> "helloy"),
  // for lines a line break ("x" -> "new\nx", not "x" -> "  x", an indent).
  const wordChar = /[\p{L}\p{N}_]/u;
  const joins = (left: string, right: string) =>
    words
      ? !wordChar.test(left.slice(-1)) || !wordChar.test(right.slice(0, 1))
      : left === "" || right === "" || left.endsWith("\n");
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
  // Text added by both sides at one place is joined with a boundary: a line
  // break where the additions are whole lines, otherwise a space.
  const both = (x: string, y: string, lines: boolean) => {
    const separator = lines ? "\n" : " ";
    return x <= y ? joinAdded(x, y, separator) : joinAdded(y, x, separator);
  };
  if (aPre != null && bPre != null) {
    return base + both(aPre, bPre, !words && base.endsWith("\n"));
  }
  if (aPost != null && bPost != null) {
    return both(aPost, bPost, !words && aPost.endsWith("\n") && bPost.endsWith("\n")) + base;
  }
  // One side added text the other side's change also added there (with the
  // same text both sides added, for example): keep it once.
  // Only whole lines (or words) count: "og" added after "cat" is not part of
  // "dog", which the other side changed "cat" to.
  const boundary = (x: string) => (words ? /\s/.test(x) : x === "\n");
  const endsWithAdded = (x: string, added: string) =>
    x.endsWith(added) && (x.length === added.length || boundary(x[x.length - added.length - 1]));
  const startsWithAdded = (x: string, added: string) =>
    x.startsWith(added) && (x.length === added.length || boundary(added[added.length - 1]));
  if (bPre != null && endsWithAdded(a, bPre)) return a;
  if (bPost != null && startsWithAdded(a, bPost)) return a;
  if (aPre != null && endsWithAdded(b, aPre)) return b;
  if (aPost != null && startsWithAdded(b, aPost)) return b;
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
  return (
    combineAdjacent(words, true) ??
    resolveTrivial(words) ??
    disjointWordEdits(words) ??
    disjointCharEdits(words) ??
    keepBoth(words)
  );
}

// Above this many characters, a conflicting chunk is not merged character by
// character.
const MAX_CHAR_MERGE = 10_000;

// The edits of a character diff, one per run of changes.
function charEdits(base: string, text: string): Edit[] {
  const edits: Edit[] = [];
  let cursor = 0;
  let current: Edit | undefined;
  for (const [op, run] of diffUnits(base, text)) {
    if (op === 0) {
      if (current) edits.push(current);
      current = undefined;
      cursor += run.length;
      continue;
    }
    current ??= { from: cursor, to: cursor, insert: "" };
    if (op === -1) {
      current.to += run.length;
      cursor += run.length;
    } else {
      current.insert += run;
    }
  }
  if (current) edits.push(current);
  return edits;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

// Whether an edit splits a character outside the BMP (a surrogate pair):
// its boundaries fall between the two halves, or its inserted text starts or
// ends with half a pair. Merging such edits could combine one user's high
// half with the other's low half, a character neither typed.
function splitsSurrogate(base: string, e: Edit): boolean {
  const inside = (i: number) =>
    i > 0 &&
    i < base.length &&
    isLowSurrogate(base.charCodeAt(i)) &&
    isHighSurrogate(base.charCodeAt(i - 1));
  if (inside(e.from) || inside(e.to)) return true;
  const n = e.insert.length;
  return (
    n > 0 && (isLowSurrogate(e.insert.charCodeAt(0)) || isHighSurrogate(e.insert.charCodeAt(n - 1)))
  );
}

// Both sides typed into the same word or line, for example two people
// adding characters at the end of one word: if their character edits do not
// overlap, apply both. (Keeping both versions would repeat the whole word or
// line for every keystroke typed concurrently.) Text both sides inserted at
// one place is kept in a canonical order, so the merge stays symmetric; an
// insertion inside text the other side replaced or deleted is a real
// conflict and returns undefined.
function disjointCharEdits(chunk: Chunk): string | undefined {
  const { base } = chunk;
  if (base === "" || base.length + chunk.a.length + chunk.b.length > MAX_CHAR_MERGE) {
    return undefined;
  }
  const merged = charEdits(base, chunk.a);
  const bEdits = charEdits(base, chunk.b);
  if ([...merged, ...bEdits].some((e) => splitsSurrogate(base, e))) return undefined;
  for (const e of bEdits) {
    const same = (x: Edit) => x.from === e.from && x.to === e.to && x.insert === e.insert;
    if (merged.some(same)) continue;
    const at = isInsertion(e) ? merged.findIndex((x) => isInsertion(x) && x.from === e.from) : -1;
    if (at !== -1) {
      const x = merged[at].insert;
      merged[at] = { ...e, insert: x <= e.insert ? x + e.insert : e.insert + x };
      continue;
    }
    const clash = (x: Edit) => {
      if (isInsertion(x)) return e.from < x.from && x.from < e.to;
      if (isInsertion(e)) return x.from < e.from && e.from < x.to;
      return x.from < e.to && e.from < x.to;
    };
    if (merged.some(clash)) return undefined;
    merged.push(e);
  }
  merged.sort((x, y) => x.from - y.from || x.to - y.to);
  return applyEdits(base, merged);
}

// Both sides changed words of a chunk, but different ones (for example,
// neighboring words, with no unchanged word between them to split the chunk):
// apply both sides' edits. Undefined if edits of the two sides overlap
// (except the same edit made on both sides), or insert text with words in
// common at one place. Different text both sides inserted at one place is kept
// in a canonical order, and an insertion just before or after the other
// side's edit is placed there.
function disjointWordEdits(chunk: Chunk): string | undefined {
  const { base } = chunk;
  const edits = (text: string) => diffToEdits(wordDiff(base, text)).map((e) => trimEdit(base, e));
  const aEdits = edits(chunk.a);
  const bEdits: Edit[] = [];
  for (const e of edits(chunk.b)) {
    const same = (x: Edit) => x.from === e.from && x.to === e.to && x.insert === e.insert;
    if (aEdits.some(same)) continue;
    const both = isInsertion(e) ? aEdits.findIndex((x) => isInsertion(x) && x.from === e.from) : -1;
    if (both !== -1) {
      const x = aEdits[both].insert;
      // Insertions sharing words may be the same text reached by different
      // paths; the line merge unions those without repeating common lines.
      if (sharesWord(x, e.insert)) return undefined;
      const insert = x <= e.insert ? joinAdded(x, e.insert, " ") : joinAdded(e.insert, x, " ");
      aEdits[both] = { ...e, insert };
      continue;
    }
    const clash = (x: Edit) => {
      if (isInsertion(x)) return e.from < x.from && x.from < e.to;
      if (isInsertion(e)) return x.from < e.from && e.from < x.to;
      return x.from < e.to && e.from < x.to;
    };
    if (aEdits.some(clash)) return undefined;
    bEdits.push(e);
  }
  const all = [...aEdits, ...bEdits].sort((x, y) => x.from - y.from || x.to - y.to);
  return applyEdits(base, all);
}

function sharesWord(x: string, y: string): boolean {
  const words = new Set(x.match(/[\p{L}\p{N}_]+/gu) ?? []);
  return (y.match(/[\p{L}\p{N}_]+/gu) ?? []).some((w) => words.has(w));
}

// An edit without the whitespace it keeps at its start and end (a replaced
// word includes the space before it), so it does not overlap a whitespace
// change next to it, such as a line break the other side typed there.
function trimEdit(base: string, e: Edit): Edit {
  let { from, to, insert } = e;
  while (from < to && insert !== "" && base[from] === insert[0] && /\s/.test(insert[0])) {
    from++;
    insert = insert.slice(1);
  }
  while (
    from < to &&
    insert !== "" &&
    base[to - 1] === insert[insert.length - 1] &&
    /\s/.test(base[to - 1])
  ) {
    to--;
    insert = insert.slice(0, -1);
  }
  return { from, to, insert };
}

function resolveTrivial(chunk: Chunk): string | undefined {
  if (chunk.base === "") {
    return chunk.a <= chunk.b ? joinAdded(chunk.a, chunk.b, " ") : joinAdded(chunk.b, chunk.a, " ");
  }
  const aSpace = sameIgnoringWhitespace(chunk.base, chunk.a);
  const bSpace = sameIgnoringWhitespace(chunk.base, chunk.b);
  // Both sides changed only whitespace: apply both if they do not overlap,
  // otherwise pick one by content, so the merge is symmetric.
  if (aSpace && bSpace) {
    return disjointCharEdits(chunk) ?? (chunk.a <= chunk.b ? chunk.a : chunk.b);
  }
  if (aSpace) return chunk.b;
  if (bSpace) return chunk.a;
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
  // Merge with every text ending in a newline, so a last line without one is
  // aligned like any other line (otherwise lines added after it by one side
  // could be joined to it), then restore the final newline: kept or removed
  // as the side that changed it did.
  const terminated = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);
  const merged = mergeTerminated({
    base: terminated(base),
    a: terminated(a),
    b: terminated(b),
    ancestors: ancestors?.map(terminated),
  });
  const [f0, fa, fb] = [base, a, b].map((text) => text.endsWith("\n"));
  const finalNewline = fa === fb ? fa : fa !== f0 ? fa : fb;
  return !finalNewline && merged.endsWith("\n") ? merged.slice(0, -1) : merged;
}

function mergeTerminated(opts: {
  base: string;
  a: string;
  b: string;
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
    withAdjacent((lines) =>
      editUnion(lines, lineDiff, (region) => cleanWordMerge(region) ?? lineUnion(region)),
    ),
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
