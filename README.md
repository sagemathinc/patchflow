# Patchflow

Patchflow is a lightweight patch-DAG sync core. It manages concurrent edits to a document by recording patches with ancestry, merging heads deterministically, and keeping an optional on-disk or transport adapter out of core. The goal is a small, well-tested engine that prioritizes correctness and “small revision history” over heavyweight state replication.

**STATUS:** NOT YET READY FOR PRODUCTION \(Nov 2025\).

## What’s inside

- Core patch DAG: [src/patch-graph.ts](./src/patch-graph.ts) handles patch ancestry, head detection, three-way merges, snapshots, and file-load dedup.
- Document types: strings via [src/string-document.ts](./src/string-document.ts); JSONL/“syncdb” docs via [src/db-document-immutable.ts](./src/db-document-immutable.ts) (immutable.js) and [src/db-document-immer.ts](./src/db-document-immer.ts) (immer).
- Session orchestrator: [src/session.ts](./src/session.ts) wraps a PatchGraph + codec + adapters, exposing commit/applyRemote/undo/redo and file/presence hooks.
- Adapters: in-memory patch store, file adapter, presence adapter, plus an interactive TCP/file demo in [examples/tcp-session.ts](./examples/tcp-session.ts).
- Tests: Jest coverage for patch graph, session, string docs, db docs (both backends), file queueing, and presence.

## How it differs from CRDTs like Yjs/Automerge

- Simpler model: Patchflow stores a DAG of patches and replays/merges with three-way merge for divergent heads. It doesn’t maintain per-character CRDT metadata; patches are diffs (DMP for strings; structured patches for db-doc).
- Small history focus: Patchflow is built to mirror “revision control” with a compact patch log and explicit snapshots, rather than a grow-only CRDT state that needs periodic GC.
- Transport/storage agnostic: Core doesn’t bake in a wire format or network layer; you provide a PatchStore and optional File/Presence adapters.
- Merge semantics: For string columns, Patchflow uses diff-match-patch to create/apply patches; map fields use shallow merge with delete markers. CRDTs often aim for highly concurrent character-level edits with strong causality metadata; Patchflow favors deterministic replay with simple merges and a small log.
- Performance/ergonomics trade-off: Yjs/Automerge are tuned for very fast real-time collaboration with rich sharing semantics. Patchflow is much smaller in scope and code size, easier to reason about, and aims for correctness with modest datasets (hundreds–thousands of records, typical file-sized docs) and explicit history.

When to prefer Patchflow:

- You want a minimal, testable core to embed in an app-specific transport.
- You care about patch log size and replay determinism.
- You need string diff/patch semantics and shallow object merges, not per-character CRDT metadata.
- You’re fine with a patch-DAG merge model instead of a full CRDT lattice.

When to reach for Yjs/Automerge:

- You need large-scale, high-frequency character-level collaboration with built-in awareness, awareness messages, and rich CRDT types.
- You want mature ecosystem integrations (rich text editors, awareness protocols) and are willing to manage CRDT GC/compaction separately.

## Getting started

- Install deps: `pnpm install`
- Run tests: `pnpm test`
- Lint/format: `pnpm lint`, `pnpm format`
- Build: `pnpm build` (ESM + CJS)
- Try the TCP demo (ts-node):
  - Server: `node --loader ts-node/esm --experimental-specifier-resolution=node examples/tcp-session.ts --role=server --file=/tmp/patchflow-a.txt --port=8123`
  - Client: same with `--role=client --file=/tmp/patchflow-b.txt --host=127.0.0.1 --port=8123`
  - Use `set("text")`, `commit()`, `get()` in the REPL to stage/send changes.

## Status and roadmap

- Core patch graph, session, string and db documents (immutable + immer) are implemented with tests.
- Examples cover in-memory and TCP/file flows.
- Future: adapters for other transports, more document types, optional SQLite-backed doc, and stronger history/snapshot tooling.
