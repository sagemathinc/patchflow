# Patchflow Plans

## Optimize patch application for the immer based document type

Currently the implementation of src/db-document-immer.ts is not optimal.  Our goal is to make it much more efficient in terms of speed and memory.

- [ ] Build a synthetic benchmark that applies N patches (e.g. 1k) against a document with deletes/sets + string columns; run for `db-document-immer`, `db-document-immutable`, and `string` codecs so we can compare.
- [ ] Extend the patchflow core to apply patches in batches instead of one-by-one when computing a value; expose a batch API from session/graph.
- [ ] Add `applyPatchBatch` to all codecs (string/immutable/immer). Start with a trivial implementation that loops and calls `applyPatch`.
- [ ] Implement a fast `applyPatchBatch` for the immer codec:
  - apply all patch operations inside a single `produce` call
  - track dirty keys and update indexes once at the end (no per-op rebuilds)
  - avoid allocating a new DbDocumentImmer per op
- [ ] Improve immutable + string implementations:
  - keep incremental index updates for immutable
  - fast-path no-ops for string (or precompute diff application where possible)
- [ ] Re-run the benchmark and record before/after numbers in this section.


## (done) Fundamentally fix Collisions Problem

Patchflow currently assumes that `Patch.time` is globally unique within a document’s patch graph. In practice this is false when the _same_ `userId` can commit concurrently from multiple clients/processes (e.g. browser + backend service in CoCalc-lite, or multiple browser tabs). When two patches share the same logical `time`, one can overwrite the other in stores that key patches by time, causing silent data loss/corruption.

The fix is to make patch identity be a **pair** `(time, clientId)` rather than the scalar `time`. The `clientId` is an opaque, per-client random identifier (configurable generator; default crypto-random). Ordering becomes lexicographic by `(time, clientId)`, and collisions become vanishingly unlikely (only possible if two clients pick the same random `clientId`).

### PatchId encoding recommendation

To keep patch ids opaque but still debuggable, represent the `(time, clientId)` pair as a single string:

- `PatchId = "<time36>_<client>"`
- `time36`: logical time in milliseconds since epoch, encoded in base36 and **left-padded** to a fixed width so lexicographic ordering matches numeric ordering.
- `client`: base64url (or base32/base36) encoding of a crypto-random byte string (96–128 bits typical).

Example:

```
0kqv9gq3a_2VbCq9qWZ7yqfQ
```

Notes:

- Use monotone logical time per client: `t = max(lastT + 1, Date.now())` to avoid backwards clock jumps.
- Provide small `encodePatchId/decodePatchId` helpers for debugging and tests. Most of patchflow should treat `PatchId` as opaque and only compare by string order.

### Plan: switch patch identity from `time` to `(time, clientId)`

1. **Introduce a first\-class patch id**
   - Add `PatchId` \(either `{ time: number; clientId: string }` or a canonical encoded string key\).
     - simplest would be `${time in ms since epoch}-${base64 clientId}` since it already would sort properly and we can just treat it as a singe atomic value for parents, etc. So type PatchId = string;
   - Update `Patch`/`PatchEnvelope` to always carry `clientId`.
   - Treat missing `clientId` on ingest as legacy: `clientId = "legacy"` \(or similar\) for backward compatibility.

2. **Update core types and APIs**
   - Change `parents?: number[]` to `parents?: PatchId[]` \(or `PatchKey[]`\).
   - Update `PatchGraph` public methods that currently accept/return times:
     - `getHeads(): PatchId[]`
     - `getPatch(id: PatchId): PatchEnvelope`
     - `versions()` should return patch ids \(unique\), not just times.
   - If needed for convenience/debugging, provide explicit helpers like `headTimes()` that are clearly _not_ unique ids.

3. **Update PatchGraph internals**
   - Replace internal maps keyed by `number` time with maps keyed by `PatchId` \(or encoded key\).
   - Rework head computation, ancestor traversal, and merge caching to use patch ids.
   - Update deterministic ordering to sort by `(time asc, clientId lex asc)` only.

4. **Update Session**
   - Add `clientId?: string` / `clientIdFactory?: () => string` to `SessionOptions`.
   - Generate a stable `clientId` once per `Session` instance by default \(crypto\-random\).
   - Include `clientId` in every local patch envelope and in parent references.
   - Remove the “mod 1024 time\-slot guarantees uniqueness” framing; uniqueness is now provided by `(time, clientId)` \(userId range limits can remain for other reasons, but not for uniqueness\).

5. **Update PatchStore adapter contract**
   - Ensure `append()` and `loadInitial()` transport the `clientId` and parent PatchIds.
   - Consider extending pagination options beyond `sinceTime` \(which is now ambiguous\) to `since?: PatchId` or `sinceKey?: string` for robust incremental loads.

6. **Update adapters \+ tests**
   - Update the in\-memory patch store adapter and all tests to use patch ids.
   - Add a regression test reproducing the real failure mode:
     - Two sessions with the same `userId` and identical clock time but different `clientId` must produce two distinct patches in the graph/store.
   - Add a compatibility test: patches without `clientId` ingest as legacy and remain addressable.

7. **CoCalc\-side migration notes \(outside patchflow core\)**
   - Any concrete PatchStore backed by a DB table keyed by time must be updated to key by `(time, clientId)` \(e.g. add `client_id` column or encode a composite key\).
   - Existing historical patches can be treated as `clientId="legacy"` without rewriting history; parents referencing old patches use the legacy id.

## Overview

Goals: extract the generic patch-DAG realtime sync core from CoCalc into a standalone, MIT-licensed package with clear adapters and comprehensive tests. Keep the core transport-agnostic and file-system-agnostic.

## (done) Proposed Module Boundaries

- core/types: `Document`, `Patch`, `PatchId`/logical time, `Snapshot`, `Version`, error types.
- core/diff: pluggable diff/patch codec; include a default string codec (wraps DiffMatchPatch) plus hooks for custom codecs.
- core/patch-graph: deterministic DAG manager (similar to `SortedPatchList`), handles add/merge, known-heads tracking, snapshots, caching, dedup (file-load dedup), and value computation `value({time?, without?})`.
- core/session: orchestrates local doc state + patch graph + adapters; provides commit, undo/redo, snapshot scheduling, load-more-history, and exposes events (change, user-change, has-unsaved-changes).
- adapters/patch-store (transport): interface for loading initial history, appending local patches/snapshots, and subscribing to remote patches.
- adapters/file (optional): read/write doc strings, optional delta-write support, optional FS watch feed → patches.
- adapters/presence (optional): cursor/presence feed with throttling; kept out of the core session unless injected.
- adapters/clock/log (optional): injectable clock and logger to avoid global dependencies.
- testing harness: in-memory implementations of patch-store/file/presence to exercise the core without any I/O.

## (done) Minimal Adapter Interfaces (sketch)

Types used below:

- `PatchEnvelope = { patch: Patch; source?: string; seq?: number; isSnapshot?: boolean; snapshotValue?: string }`
- `SnapshotEnvelope = { time: number; value: string; version: number; seq?: number }`
- `DocCodec = { fromString(s: string): Document; toString(doc: Document): string; makePatch(a: Document, b: Document): CompressedPatch; applyPatch(doc: Document, patch: CompressedPatch): Document }`

Patch store / transport (required):

```ts
interface PatchStore {
  // load initial state (optionally paged); returns patches + known snapshot if any
  loadInitial(opts?: {
    sinceTime?: number;
  }): Promise<{ patches: PatchEnvelope[]; hasMore?: boolean }>;
  // append a local patch/snapshot to the shared log
  append(envelope: PatchEnvelope): Promise<void>;
  // subscribe to remote envelopes; returns unsubscribe
  subscribe(onEnvelope: (env: PatchEnvelope) => void): () => void;
}
```

File adapter (optional):

```ts
interface FileAdapter {
  read(): Promise<string>; // throws ENOENT-style error if missing
  write(content: string, opts?: { base?: string }): Promise<void>; // base enables delta writes
  watch?(onChange: (delta?: { patch?: CompressedPatch; seq?: number }) => void): () => void;
}
```

Presence adapter (optional):

```ts
interface PresenceAdapter {
  publish(state: any): void;
  subscribe(onState: (state: any, clientId: string) => void): () => void;
}
```

Session construction sketch:

```ts
type SessionDeps = {
  codec: DocCodec;
  patchStore: PatchStore;
  clock?: () => number;
  file?: FileAdapter;
  presence?: PresenceAdapter;
  log?: (msg: string, data?: any) => void;
};
```

## (done) Refactor Steps

1. \(done\) Lift `Document`/`Patch`/`SortedPatchList`\-equivalent into core modules with zero CoCalc deps.
2. \(done\) Write in\-memory `PatchStore` \+ `DocCodec` \(string\) and port existing SortedPatchList tests; add coverage for merges, snapshots, undo/redo, value\(without\).
3. \(done\) Rebuild a slim `Session` around adapters; keep file/presence optional. Replace `reuseInFlight`\-style saves with a small dirty/queue state machine.
4. \(done\) Add file adapter \+ tests: overlapping saves, init/close races, remote patches arriving during disk write.
5. \(done\) Add presence adapter \(optional\) and keep it out of the core unless supplied.
6. Integrate back into CoCalc via adapters \(conat\-backed PatchStore, FS/watch wrapper\), without reintroducing CoCalc\-specific code into the core.
