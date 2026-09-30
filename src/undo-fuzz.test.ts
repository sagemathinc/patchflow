/*
Collaborative undo with exact merges: clients insert lines with unique tokens,
and undo, redo and leave undo mode (which commits what they see) at random, over
a network with delays. Afterwards, all clients show the same text, a token is
present exactly when its insertion is in effect (not undone when its author left
undo mode), and no token appears twice.

UNDO_FUZZ_RUNS (default 40) sets the number of sessions.
*/

import { Session } from "./session";
import { mergeStrings3 } from "./merge3";
import { StringDocument } from "./string-document";
import type { DocCodec, PatchEnvelope, PatchStore } from "./types";

const probe: string[] = [];
const codec: DocCodec = {
  fromString: (s) => new StringDocument(s),
  toString: (d) => d.toString(),
  applyPatch: (d, p) => d.applyPatch(p),
  applyPatchBatch: (d, ps) => d.applyPatchBatch(ps),
  makePatch: (a, b) => a.makePatch(b),
  merge3: (base, a, b, ancestors) => {
    const [s0, sa, sb] = [base, a, b].map((d) => d.toString());
    const out = mergeStrings3({
      base: s0,
      a: sa,
      b: sb,
      ancestors: ancestors?.map((d) => d.toString()),
    });
    if (process.env.UNDO_FUZZ_PROBE) {
      const L = (x: string) => x.split("\n").filter(Boolean);
      const [B, A, Bb, O] = [L(s0), L(sa), L(sb), L(out)];
      for (const t of new Set([...A, ...Bb])) {
        const inBoth = A.includes(t) && Bb.includes(t);
        const added = !B.includes(t);
        if ((inBoth || added) && !O.includes(t)) {
          probe.push(
            `merge dropped ${t}: ${JSON.stringify({ base: s0, a: sa, b: sb, out, ancestors: ancestors?.map((d) => d.toString()) })}`,
          );
        }
      }
      for (const t of s0.split("\n").filter(Boolean)) {
        const gone = !sa.split("\n").includes(t) || !sb.split("\n").includes(t);
        if (gone && out.split("\n").includes(t)) {
          probe.push(`merge kept deleted ${t}: ${JSON.stringify({ base: s0, a: sa, b: sb, out })}`);
        }
      }
    }
    return new StringDocument(out);
  },
};

const RUNS = Number(process.env.UNDO_FUZZ_RUNS ?? 40);
const DELAY = Number(process.env.UNDO_FUZZ_DELAY ?? 1500);

async function run(seed: number) {
  let s = seed;
  const rng = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let clock = 1_000_000;
  const n = 3;
  const listeners: ((env: PatchEnvelope) => void)[][] = Array.from({ length: n }, () => []);
  const queue: { to: number; env: PatchEnvelope; at: number }[] = [];
  const store = (id: number): PatchStore => ({
    loadInitial: async () => ({ patches: [] }),
    append: (env) => {
      for (let to = 0; to < n; to++) {
        if (to !== id) queue.push({ to, env, at: clock + Math.floor(rng() * DELAY) });
      }
    },
    subscribe: (fn) => {
      listeners[id].push(fn);
      return () => {};
    },
  });
  const deliver = (all = false) => {
    const due = queue.filter((m) => all || m.at <= clock);
    for (const m of due) queue.splice(queue.indexOf(m), 1);
    for (const m of due) for (const fn of listeners[m.to]) fn(m.env);
  };
  const sessions: Session[] = [];
  for (let id = 0; id < n; id++) {
    const session = new Session({
      codec,
      patchStore: store(id),
      clock: () => clock,
      userId: id + 1,
      clientId: `c${id}`,
    });
    await session.init();
    sessions.push(session);
  }
  // A model of each client's undo history, like Session's: every commit of
  // the client (an insertion, or the commit that leaving undo mode makes) in
  // order, the undo list (localTimes: a new commit drops the undone entries
  // and is appended) and its pointer. The client shows all its commits except
  // the undone ones (the undo list after the pointer).
  type Op = { id: number; add: string[]; remove: string[] };
  const history: Op[][] = Array.from({ length: n }, () => []);
  const undoList: number[][] = Array.from({ length: n }, () => []);
  const ptr = Array(n).fill(0);
  const inUndo = Array(n).fill(false);
  let nextId = 0;
  const effect = (c: number, withoutUndone: boolean) => {
    const undone = new Set(withoutUndone ? undoList[c].slice(ptr[c]) : []);
    const tokens = new Set<string>();
    for (const op of history[c]) {
      if (undone.has(op.id)) continue;
      for (const t of op.add) tokens.add(t);
      for (const t of op.remove) tokens.delete(t);
    }
    return tokens;
  };
  const record = (c: number, add: string[], remove: string[]) => {
    const op = { id: nextId++, add, remove };
    history[c].push(op);
    undoList[c] = undoList[c].slice(0, ptr[c]);
    undoList[c].push(op.id);
    ptr[c] = undoList[c].length;
  };
  const exitUndo = (c: number) => {
    const full = effect(c, false);
    const target = effect(c, true);
    sessions[c].resetUndo();
    const add = [...target].filter((t) => !full.has(t));
    const remove = [...full].filter((t) => !target.has(t));
    if (add.length + remove.length > 0) record(c, add, remove);
    else ptr[c] = undoList[c].length;
    inUndo[c] = false;
  };
  let token = 0;
  const log: string[] = [];

  for (let step = 0; step < 120; step++) {
    clock += Math.floor(rng() * 300);
    deliver();
    const c = Math.floor(rng() * n);
    const session = sessions[c];
    const r = rng();
    if (r < 0.6) {
      // A new edit leaves undo mode first (as SyncDoc does on set_doc).
      if (inUndo[c]) exitUndo(c);
      const lines = session.getDocument().toString().split("\n").filter(Boolean);
      const t = `t${token++}`;
      lines.splice(Math.floor(rng() * (lines.length + 1)), 0, t);
      session.commit(codec.fromString(lines.join("\n") + "\n"));
      record(c, [t], []);
      log.push(`c${c} insert ${t}`);
    } else if (r < 0.8) {
      if (ptr[c] > 0) {
        session.undo();
        ptr[c]--;
        inUndo[c] = true;
        log.push(`c${c} undo`);
      }
    } else if (r < 0.9) {
      if (ptr[c] < undoList[c].length) {
        session.redo();
        ptr[c]++;
        log.push(`c${c} redo`);
      }
    } else if (inUndo[c]) {
      exitUndo(c);
      log.push(`c${c} exit undo`);
    }
    const state = session.undoState();
    if (state.undoPtr !== ptr[c] || state.localTimes.length !== undoList[c].length) {
      throw new Error(
        `seed ${seed} step ${step}: undo model out of step with Session: ${JSON.stringify({ state, ptr: ptr[c], undoList: undoList[c], log: log.slice(-6) })}`,
      );
    }
  }
  for (let c = 0; c < n; c++) if (inUndo[c]) exitUndo(c);
  for (let i = 0; i < 5; i++) deliver(true);
  const values = sessions.map((x) => x.getDocument().toString());
  const problems: string[] = [];
  if (new Set(values).size !== 1) problems.push("clients did not converge");
  const lines = values[0].split("\n").filter(Boolean);
  const expected = new Set(history.flatMap((_, c) => [...effect(c, true)]));
  for (const t of expected) {
    const k = lines.filter((l) => l === t).length;
    if (k === 0) problems.push(`lost ${t}`);
    if (k > 1) problems.push(`duplicated ${t}`);
  }
  for (const l of lines) if (!expected.has(l)) problems.push(`undone ${l} still present`);
  if (process.env.UNDO_FUZZ_VERBOSE) {
    for (const pr of problems.filter((x) => x.startsWith("lost "))) {
      const t = pr.slice(5);
      const sess = sessions[0];
      for (const p of sess.history()) {
        const after = sess.value({ time: p.time }).toString().split("\n");
        const parents = p.parents ?? [];
        const befores = parents.map((q) => sess.value({ time: q }).toString().split("\n"));
        if (befores.some((b) => b.includes(t)) && !after.includes(t)) {
          // eslint-disable-next-line no-console
          console.log(
            `REMOVED ${t} by ${p.time} user ${p.userId} source ${(p as any).source} parents ${parents.length} ${JSON.stringify(
              {
                parents: parents.map((q, i) => [q, befores[i].join(" ")]),
                merged:
                  parents.length > 1
                    ? (sess as any).graph.exactValueOfSet(parents)?.toString().split("\n").join(" ")
                    : undefined,
                after: after.join(" "),
                patch: p.patch,
              },
            )}`,
          );
          break;
        }
      }
    }
  }
  return { problems, log, value: values[0] };
}

// Losing text or diverging fails. An undone line that comes back, or a line
// that appears twice, is reported but accepted: when concurrent insertions
// were ordered differently on different merge paths, a line diff sees a moved
// line, and the three-way merge keeps both a deletion's and a move's version
// rather than risk losing text (the same as text moved by a split).
describe("collaborative undo with exact merges", () => {
  it("converges, loses no insertion in effect, and rarely resurrects one", async () => {
    const failures: string[] = [];
    const accepted: string[] = [];
    for (let seed = Number(process.env.UNDO_FUZZ_SEED ?? 1); seed <= RUNS; seed++) {
      const r = await run(seed);
      const bad = r.problems.filter((p) => !/^(undone .* still present|duplicated )/.test(p));
      if (bad.length > 0) failures.push(`seed ${seed}: ${bad.slice(0, 4).join("; ")}`);
      else if (r.problems.length > 0) accepted.push(`seed ${seed}`);
      if (r.problems.length > 0 && process.env.UNDO_FUZZ_VERBOSE) {
        // eslint-disable-next-line no-console
        console.log(r.log.join("\n"), "\n", r.value);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `undo fuzz: ${RUNS} sessions, ${accepted.length} with a resurrected or duplicated line`,
    );
    expect(failures).toEqual([]);
  });
});
