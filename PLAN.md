# Patchflow Plan

Goals: extract the generic patch-DAG realtime sync core from CoCalc into a standalone, MIT-licensed package with clear adapters and comprehensive tests. Keep the core transport-agnostic and file-system-agnostic.

## Proposed Module Boundaries

- core/types: `Document`, `Patch`, `PatchId`/logical time, `Snapshot`, `Version`, error types.
- core/diff: pluggable diff/patch codec; include a default string codec (wraps DiffMatchPatch) plus hooks for custom codecs.
- core/patch-graph: deterministic DAG manager (similar to `SortedPatchList`), handles add/merge, known-heads tracking, snapshots, caching, dedup (file-load dedup), and value computation `value({time?, without?})`.
- core/session: orchestrates local doc state + patch graph + adapters; provides commit, undo/redo, snapshot scheduling, load-more-history, and exposes events (change, user-change, has-unsaved-changes).
- adapters/patch-store (transport): interface for loading initial history, appending local patches/snapshots, and subscribing to remote patches.
- adapters/file (optional): read/write doc strings, optional delta-write support, optional FS watch feed → patches.
- adapters/presence (optional): cursor/presence feed with throttling; kept out of the core session unless injected.
- adapters/clock/log (optional): injectable clock and logger to avoid global dependencies.
- testing harness: in-memory implementations of patch-store/file/presence to exercise the core without any I/O.

## Minimal Adapter Interfaces (sketch)

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

## Refactor Steps

1. \(done\) Lift `Document`/`Patch`/`SortedPatchList`\-equivalent into core modules with zero CoCalc deps.
2. \(done\) Write in\-memory `PatchStore` \+ `DocCodec` \(string\) and port existing SortedPatchList tests; add coverage for merges, snapshots, undo/redo, value\(without\).
3. Rebuild a slim `Session` around adapters; keep file/presence optional. Replace `reuseInFlight`\-style saves with a small dirty/queue state machine.
4. Add file adapter \+ tests: overlapping saves, init/close races, remote patches arriving during disk write.
5. Add presence adapter \(optional\) and keep it out of the core unless supplied.
6. Integrate back into CoCalc via adapters \(conat\-backed PatchStore, FS/watch wrapper\), without reintroducing CoCalc\-specific code into the core.
