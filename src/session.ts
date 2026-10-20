import { EventEmitter } from "events";
import { PatchGraph } from "./patch-graph";
import { rebaseDraft } from "./working-copy";
import { decodePatchId, encodePatchId } from "./patch-id";
import { makeClientId } from "./client-id";
import type {
  DocCodec,
  Document,
  PatchEnvelope,
  PatchStore,
  FileAdapter,
  PresenceAdapter,
  PatchGraphValueOptions,
  CursorSnapshot,
  CursorPresence,
} from "./types";

export type SessionOptions = {
  // Codec used to convert between strings and document instances and to make/apply patches.
  codec: DocCodec;
  // Persistence/transport adapter for loading initial history and appending patches.
  patchStore: PatchStore;
  // Optional clock override (defaults to Date.now) for deterministic testing.
  clock?: () => number;
  // Optional local user id, propagated on emitted patches/presence.
  userId?: number;
  // Optional per-client identifier for PatchId generation. Must be stable for the life
  // of the Session instance. When omitted, a default is generated.
  clientId?: string;
  // Optional override for clientId generation (useful for tests).
  clientIdFactory?: () => string;
  // Optional document identifier for presence scoping (e.g., path or id).
  docId?: string;
  // Optional file adapter to mirror the current doc to disk and watch for external edits.
  fileAdapter?: FileAdapter;
  // Optional presence adapter to publish/receive lightweight presence state.
  presenceAdapter?: PresenceAdapter;
};

// Parents considered as the one a merge commit records its merged value from
// (see Session.recordMerge): each costs a diff.
const MAX_MERGE_PARENT_CANDIDATES = 8;

// Rough size of a patch, to compare patches of the same codec.
function patchSize(patch: unknown): number {
  if (patch instanceof Uint8Array) return patch.byteLength;
  return JSON.stringify(patch)?.length ?? 0;
}

/**
 * Session orchestrates a local Document against a PatchGraph and a PatchStore.
 * It handles local commits, remote patches, and basic undo/redo of local changes.
 */
export class Session extends EventEmitter {
  private readonly codec: DocCodec;
  private readonly patchStore: PatchStore;
  private readonly clock: () => number;
  // For each preview handed out by previewCommit: the session's own copy of
  // the envelope (what commit appends) and what it was computed from.
  private readonly previews = new WeakMap<PatchEnvelope, Preview>();
  private readonly graph: PatchGraph;
  private readonly fileAdapter?: FileAdapter;
  private readonly presenceAdapter?: PresenceAdapter;
  private readonly docId?: string;
  private doc?: Document; // live doc (committed + staged)
  private committedDoc?: Document; // graph-derived doc without staged edits
  private lastTimeMs: number = 0;
  private userId: number;
  private maxVersion: number = 0;
  private readonly clientId: string;

  private localTimes: string[] = [];
  private undoPtr = 0;
  private unsubscribe?: () => void;
  private fileUnsubscribe?: () => void;
  // Whether flushFileQueue is running. Set and cleared by the flush itself:
  // it can finish synchronously (when nothing needs writing), and a flag set
  // by the caller after it returned would then never be cleared.
  private flushingFile = false;
  private dirtyDoc?: Document;
  private writingDoc?: Document;
  private persistedContent?: string;
  private suppressFileChanges = 0;
  // While the value is unavailable (see isValueAvailable) nothing is written
  // to the file, which then holds `heldFileContent` (undefined if unknown).
  private fileWritesHeld = false;
  private heldFileContent?: string;
  private resumingFileSync?: Promise<void>;
  private resumeRetryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private hasMoreHistory = false;
  private cursorTtlMs = 60_000;
  private cursorStates: Map<string, CursorSnapshot> = new Map();
  private cursorPruneTimer?: NodeJS.Timeout;
  private workingCopy?: { base: Document; draft: Document };

  private ensureInitialized(): void {
    if (!this.doc) {
      throw new Error("session not initialized");
    }
  }

  // Build session state and wire adapters.
  constructor(opts: SessionOptions) {
    super();
    this.codec = opts.codec;
    this.patchStore = opts.patchStore;
    this.clock = opts.clock ?? (() => Date.now());
    this.userId = opts.userId ?? 0;
    this.docId = opts.docId;
    this.fileAdapter = opts.fileAdapter;
    this.presenceAdapter = opts.presenceAdapter;
    this.graph = new PatchGraph({
      codec: this.codec,
      onInconsistency: (inconsistency) => this.emit("inconsistency", inconsistency),
    });
    const factory = opts.clientIdFactory ?? makeClientId;
    this.clientId = opts.clientId ?? factory();
  }

  // Load initial history, seed state, and subscribe to adapters.
  async init(): Promise<void> {
    const { patches, hasMore } = await this.patchStore.loadInitial();
    this.hasMoreHistory = !!hasMore;
    // Starting from an empty history, every later patch arrives on the stream,
    // so a patch whose parent is missing is waiting for it.
    if (patches.length === 0 && !hasMore) this.graph.markCompleteFromStart();
    this.graph.add(patches);
    this.lastTimeMs = this.computeLastTimeMs();
    this.maxVersion = this.computeMaxVersion();
    this.committedDoc = this.graph.value();
    this.doc = this.committedDoc;
    if (this.fileAdapter && this.doc) {
      if (this.graph.valueUnavailable()) {
        // The best-effort value is not what the file holds.
        this.fileWritesHeld = true;
        try {
          this.heldFileContent = await this.fileAdapter.read();
        } catch {
          this.heldFileContent = undefined;
        }
      } else {
        // Track current doc string so we can skip redundant writes.
        this.persistedContent = this.codec.toString(this.doc);
      }
    }
    this.emit("change", this.doc);
    this.unsubscribe = this.patchStore.subscribe((env) => {
      this.applyRemote(env);
    });
    if (this.presenceAdapter) {
      this.presenceAdapter.subscribe((state, clientId) => {
        if (this.isCursorPresence(state)) {
          this.ingestCursorState({ ...state, clientId });
          this.emit("cursors", this.cursors());
        } else {
          this.emit("presence", state, clientId);
        }
      });
    }
    if (this.fileAdapter?.watch) {
      this.fileUnsubscribe = this.fileAdapter.watch(async () => {
        await this.handleFileChange();
      });
    }
  }

  // Tear down subscriptions and presence when done.
  close(): void {
    this.closed = true;
    if (this.resumeRetryTimer != null) {
      clearTimeout(this.resumeRetryTimer);
      this.resumeRetryTimer = undefined;
    }
    this.unsubscribe?.();
    this.fileUnsubscribe?.();
    this.presenceAdapter?.publish(undefined);
    if (this.cursorPruneTimer) {
      clearTimeout(this.cursorPruneTimer);
    }
    this.cursorStates.clear();
    this.removeAllListeners();
  }

  // True if initial load included all history.
  hasFullHistory(): boolean {
    this.ensureInitialized();
    return !this.hasMoreHistory;
  }

  // Mark that full history is now present (e.g., after incremental backfill).
  markFullHistory(): void {
    this.ensureInitialized();
    this.hasMoreHistory = false;
  }

  // Whether the loaded history is not enough for the exact value (see
  // PatchGraph.needsMoreHistory); load more history, if there is more, while
  // this is true.
  needsMoreHistory(): boolean {
    this.ensureInitialized();
    return this.graph.needsMoreHistory();
  }

  // Whether every other loaded patch is an ancestor or a descendant of `time`,
  // so a snapshot there is a clean cut (see PatchGraph.isCut).
  isCut(time: string): boolean {
    this.ensureInitialized();
    return this.graph.isCut(time);
  }

  // Whether this client's exact value of a patch matches the hash its author
  // recorded (see PatchGraph.verifyValue); e.g. check before writing a
  // snapshot of it.
  verifyValue(time: string): "ok" | "mismatch" | "unknown" {
    this.ensureInitialized();
    return this.graph.verifyValue(time);
  }

  // False while the document depends on a snapshot that differs from its
  // patch's value and that patch is not loaded (see
  // PatchGraph.valueUnavailable): getDocument() is then a best-effort view
  // without that snapshot, commit() refuses to record anything on top of it,
  // and needsMoreHistory() is true; loading more history makes it available.
  isValueAvailable(): boolean {
    this.ensureInitialized();
    return !this.graph.valueUnavailable();
  }

  private assertValueAvailable(): void {
    if (this.graph.valueUnavailable()) {
      throw new Error(
        "patchflow: the document's value is not known (a snapshot differs from its patch's value); load more history before committing",
      );
    }
  }

  // Hash of a value, as stored in Patch.hash.
  hashOf(doc: Document): string {
    return this.graph.hashOf(doc);
  }

  // Return patch ids (versions) in ascending order.
  versions(opts: { start?: string; end?: string } = {}): string[] {
    this.ensureInitialized();
    return this.graph.versions(opts);
  }

  // Return the current head logical times.
  getHeads(): string[] {
    this.ensureInitialized();
    return this.graph.getHeads();
  }

  // Compute the document at a specific version or with exclusions.
  value(opts: PatchGraphValueOptions = {}): Document {
    this.ensureInitialized();
    return this.graph.value(opts);
  }

  // Return a sorted list of patches in the session, optionally filtered.
  history(
    opts: { start?: string; end?: string; includeSnapshots?: boolean } = {},
  ): PatchEnvelope[] {
    this.ensureInitialized();
    return this.graph.history(opts).map((p) => ({ ...p }));
  }

  // Fetch a specific patch by logical time.
  getPatch(time: string): PatchEnvelope {
    this.ensureInitialized();
    return { ...this.graph.getPatch(time) };
  }

  // Render a readable history summary for debugging/REPL use.
  summarizeHistory(
    opts: {
      includeSnapshots?: boolean;
      trunc?: number | null;
      milliseconds?: boolean;
      log?: (text: string) => void;
      formatDoc?: (doc: Document) => string;
    } = {},
  ): string {
    this.ensureInitialized();
    const { includeSnapshots = true, trunc = 80, milliseconds = false, log, formatDoc } = opts;

    const truncMiddle = (s: string, n: number | null): string => {
      if (n == null || n <= 0 || s.length <= n) return s;
      if (n <= 3) return s.slice(0, n);
      const half = Math.floor((n - 3) / 2);
      return `${s.slice(0, half)}...${s.slice(s.length - half)}`;
    };

    const patches = this.history({ includeSnapshots });
    const lines: string[] = [];
    const emit = (text: string) => {
      lines.push(text);
      log?.(text);
    };

    patches.forEach((p, idx) => {
      const wall = milliseconds
        ? String(p.wall ?? decodePatchId(p.time).timeMs)
        : new Date(p.wall ?? decodePatchId(p.time).timeMs).toISOString();
      const parents = p.parents && p.parents.length > 0 ? ` parents=[${p.parents.join(",")}]` : "";
      const patchStr = p.isSnapshot
        ? `(snapshot len=${p.snapshot?.length ?? 0})`
        : `(patch ${truncMiddle(JSON.stringify(p.patch), trunc)})`;
      emit(
        `${(idx + 1).toString().padStart(3, "0")} t=${p.time} v=${p.version ?? "-"} user=${p.userId ?? "-"} wall=${wall}${parents} ${patchStr}`,
      );
      const doc = this.graph.value({ time: p.time });
      const docStr = formatDoc
        ? formatDoc(doc)
        : truncMiddle(this.codec.toString(doc).trim(), trunc);
      const label = p.isSnapshot
        ? "(SNAPSHOT)"
        : (p.parents?.length ?? 0) > 1
          ? "(MERGE)   "
          : "          ";
      emit(`${label} ${JSON.stringify(docStr)}`);
    });

    const currentDoc = this.codec.toString(this.getDocument()).trim();
    emit(`\nCurrent: ${JSON.stringify(truncMiddle(currentDoc, trunc))}`);
    return lines.join("\n");
  }

  // Return the current document or throw if not initialized.
  getDocument(): Document {
    this.ensureInitialized();
    return this.doc!;
  }

  // Return the committed document (graph value without staged edits).
  getCommittedDocument(): Document {
    this.ensureInitialized();
    return this.committedDoc ?? this.doc!;
  }

  // Apply local change as a patch, persist, and publish presence.
  //
  // opts.preview: a preview previewCommit returned for this same nextDoc and
  // opts, with nothing committed or merged since. The commit then
  // appends the envelope that was previewed, as it was when previewed,
  // without computing it again (a host that measured the preview commits
  // exactly what it measured). Throws, committing nothing, if anything
  // changed since the preview, including the preview or opts.meta. A
  // preview can be passed to commit once.
  commit(
    nextDoc: Document,
    opts: {
      file?: boolean;
      source?: string;
      meta?: PatchEnvelope["meta"];
      preview?: PatchEnvelope;
    } = {},
  ): PatchEnvelope {
    if (!this.committedDoc) {
      throw new Error("session not initialized");
    }
    this.assertValueAvailable();
    let envelope: PatchEnvelope;
    if (opts.preview != null) {
      envelope = this.takePreview(nextDoc, opts, opts.preview);
      this.lastTimeMs = decodePatchId(envelope.time).timeMs;
    } else {
      const timeMs = this.nextTimeMs();
      envelope = this.buildEnvelope(nextDoc, opts, timeMs, this.clock());
    }
    const { time, version: nextVersion } = envelope;
    this.graph.add([envelope]);
    this.maxVersion = Math.max(this.maxVersion, nextVersion!);
    this.committedDoc = nextDoc;
    this.doc = nextDoc;
    this.workingCopy = undefined;
    // Reset undo future and record this local change.
    this.localTimes = this.localTimes.slice(0, this.undoPtr);
    this.localTimes.push(time);
    this.undoPtr = this.localTimes.length;
    this.syncDoc();
    this.patchStore.append(envelope);
    // Optionally publish presence after commit
    this.presenceAdapter?.publish({ userId: this.userId, time });
    return envelope;
  }

  // The envelope commit(nextDoc, opts) would append now. Pass the result to
  // commit as opts.preview to append exactly that envelope.
  //
  // The result is a frozen copy for the caller to inspect or measure; the
  // session keeps its own copy, made when previewing, and that is what
  // commit appends. Previewing changes nothing in the session (graph,
  // document, logical time, versions, undo), appends nothing and emits no
  // events. It reads the clock once, as any commit must, and commit with
  // the preview doesn't read it again: an injected clock that advances on
  // every read (e.g. a test clock) sees one read per preview. It can fill
  // the graph's caches as a commit would: the sorted list of patch ids (one
  // entry per patch, dropped when a patch is added) and exact values (LRU
  // caches with entry and size limits), so a preview never grows memory
  // beyond what one commit could.
  //
  // It is the object handed to PatchStore.append, field for field. How the
  // store encodes and frames it is up to the store: a caller limiting the
  // size of what is stored must measure the preview with the store's own
  // encoding.
  previewCommit(
    nextDoc: Document,
    opts: { file?: boolean; source?: string; meta?: PatchEnvelope["meta"] } = {},
  ): PatchEnvelope {
    if (!this.committedDoc) {
      throw new Error("session not initialized");
    }
    this.assertValueAvailable();
    const wall = this.clock();
    const timeMs = Math.max(wall, this.lastTimeMs + 1);
    // Owned copies: nothing the caller holds (opts.meta, the result) can
    // change what is committed.
    const envelope = ownedCopy(this.buildEnvelope(nextDoc, opts, timeMs, wall));
    const shown = deepFreeze(ownedCopy(envelope));
    this.previews.set(shown, {
      envelope,
      nextDoc,
      file: opts.file,
      source: opts.source,
      at: this.previewState(),
    });
    return shown;
  }

  // What the envelope of a commit depends on besides nextDoc, opts and the
  // clock. (The base document matters only without exact values, and a new
  // committed document or working copy is a new object.)
  private previewState(): PreviewState {
    return {
      revision: this.graph.revision(),
      lastTimeMs: this.lastTimeMs,
      maxVersion: this.maxVersion,
      userId: this.userId,
      base: this.workingCopy?.base ?? this.committedDoc!,
    };
  }

  // The envelope to commit for a preview, or throw. A preview is used once.
  private takePreview(
    nextDoc: Document,
    opts: { file?: boolean; source?: string; meta?: PatchEnvelope["meta"] },
    shown: PatchEnvelope,
  ): PatchEnvelope {
    const preview = this.previews.get(shown);
    this.previews.delete(shown);
    if (preview == null) {
      throw new Error("the previewed commit is out of date");
    }
    const now = this.previewState();
    const at = preview.at;
    if (
      at.revision !== now.revision ||
      at.lastTimeMs !== now.lastTimeMs ||
      at.maxVersion !== now.maxVersion ||
      at.userId !== now.userId ||
      at.base !== now.base
    ) {
      throw new Error("the previewed commit is out of date");
    }
    if (
      (nextDoc !== preview.nextDoc && !nextDoc.isEqual(preview.nextDoc)) ||
      opts.file !== preview.file ||
      opts.source !== preview.source ||
      !sameValue(opts.meta, preview.envelope.meta)
    ) {
      throw new Error("the commit differs from its preview");
    }
    // The caller's copy is frozen, but a binary patch can't be.
    if (!sameValue(shown, preview.envelope)) {
      throw new Error("the preview was modified");
    }
    return preview.envelope;
  }

  // The envelope of a commit of nextDoc at this time.
  private buildEnvelope(
    nextDoc: Document,
    opts: { file?: boolean; source?: string; meta?: PatchEnvelope["meta"] },
    timeMs: number,
    wall: number,
  ): PatchEnvelope {
    const parents = this.graph.getValueHeads();
    // With exact values, make the patch against the exact value of its
    // parents, which is what every client applies it to; then the history
    // records exactly nextDoc. (The committed document can differ from it,
    // e.g. after undo, which hides patches that are still parents.)
    const parentsValue = this.graph.exactValueOf(parents);
    const base = parentsValue ?? this.workingCopy?.base ?? this.committedDoc!;
    const patch = this.codec.makePatch(base, nextDoc);
    const time = encodePatchId(timeMs, this.clientId);
    const nextVersion = Math.max(this.maxVersion + 1, this.graph.versions().length + 1);
    return {
      time,
      wall,
      patch,
      parents,
      userId: this.userId,
      version: nextVersion,
      file: opts.file,
      source: opts.source,
      meta: opts.meta,
      hash: parentsValue == null ? undefined : this.graph.hashOf(nextDoc),
      ...this.inexactMarker(parentsValue),
      ...this.recordMerge(parents, parentsValue),
    };
  }

  // For a patch with several parents, the merged value of its parents as a
  // diff from one of them (see Patch.mergeParent), so its value never depends
  // on how a later version merges. From the parent with the smallest diff,
  // usually the one with the most of the merged changes.
  private recordMerge(
    parents: string[],
    merged: Document | undefined,
  ): Pick<PatchEnvelope, "mergeParent" | "mergePatch"> {
    if (parents.length < 2 || merged == null) return {};
    let best: { parent: string; patch: unknown; size: number } | undefined;
    for (const parent of parents.slice(0, MAX_MERGE_PARENT_CANDIDATES)) {
      const value = this.graph.exactValueOf([parent]);
      if (value == null) return {};
      const patch = this.codec.makePatch(value, merged);
      const size = patchSize(patch);
      if (best == null || size < best.size) best = { parent, patch, size };
    }
    return best == null ? {} : { mergeParent: best.parent, mergePatch: best.patch };
  }

  // A patch committed without the exact value of its parents by a session
  // that computes exact values (e.g. before the history needed for it is
  // loaded) is marked inexact (see Patch.inexact). A session that never
  // computes exact values (no merge3, or apply-all) writes history the way
  // patchflow 0.8 did, and its patches are read that way: no marker.
  private inexactMarker(parentsValue: Document | undefined): Pick<PatchEnvelope, "inexact"> {
    return parentsValue == null && this.graph.computesExactValues() ? { inexact: true } : {};
  }

  // Merge a remote patch and refresh the current document.
  applyRemote(env: PatchEnvelope): void {
    this.applyRemoteBatch([env]);
  }

  // Merge a batch of remote patches and refresh the current document once.
  // Returns the patches that were new to this session; duplicate replay is a
  // no-op and does not emit change/patch events.
  applyRemoteBatch(envs: PatchEnvelope[]): PatchEnvelope[] {
    const revision = this.graph.revision();
    const added = this.graph.add(envs);
    if (added.length === 0) {
      // No new patch, but e.g. a snapshot record was upgraded with its patch,
      // which can change the value: refresh it.
      if (this.graph.revision() !== revision) this.syncDoc();
      return [];
    }
    for (const env of added) {
      this.lastTimeMs = Math.max(this.lastTimeMs, decodePatchId(env.time).timeMs);
      if (env.version != null) {
        this.maxVersion = Math.max(this.maxVersion, env.version);
      } else {
        this.maxVersion = Math.max(this.maxVersion, this.graph.versions().length);
      }
    }
    this.syncDoc();
    for (const env of added) {
      this.emit("patch", env);
    }
    return added;
  }

  // Step the undo pointer backward and recompute the doc.
  undo(): Document {
    if (this.undoPtr > 0) {
      this.undoPtr -= 1;
      this.syncDoc();
      this.emit("undo", this.doc);
      this.presenceAdapter?.publish({ userId: this.userId, undoPtr: this.undoPtr });
    }
    return this.getDocument();
  }

  // Step the undo pointer forward and recompute the doc.
  redo(): Document {
    if (this.undoPtr < this.localTimes.length) {
      this.undoPtr += 1;
      this.syncDoc();
      this.emit("redo", this.doc);
      this.presenceAdapter?.publish({ userId: this.userId, undoPtr: this.undoPtr });
    }
    return this.getDocument();
  }

  // Return undo pointer and local history for callers that need to mirror undo UI.
  undoState(): { undoPtr: number; localTimes: string[] } {
    return {
      undoPtr: this.undoPtr,
      localTimes: [...this.localTimes],
    };
  }

  // Reset undo pointer to the top (exit undo mode). If we are in an undone
  // state, commit a new patch that preserves the current view so redo history
  // is cleared without losing the undone changes.
  resetUndo(): void {
    this.ensureInitialized();
    const targetDoc = this.getDocument();
    const fullDoc = this.graph.value(); // state with all local patches applied

    if (!targetDoc.isEqual(fullDoc)) {
      // Temporarily treat the full graph value as the base for the commit so
      // we create a patch from fullDoc -> targetDoc.
      const prevCommitted = this.committedDoc;
      this.committedDoc = fullDoc;
      try {
        this.commit(targetDoc, { source: "undo-reset" });
        // commit() already updated committedDoc/doc/undoPtr and published presence.
      } catch (err) {
        this.committedDoc = prevCommitted ?? this.committedDoc;
        throw err;
      }
    } else {
      // Nothing to preserve; just exit undo mode.
      this.undoPtr = this.localTimes.length;
      this.syncDoc();
      this.presenceAdapter?.publish({ userId: this.userId, undoPtr: this.undoPtr });
    }
  }

  // Record a staged working copy of the document. Does not append to history.
  setWorkingCopy(draft: Document): void {
    this.ensureInitialized();
    const base = this.committedDoc ?? this.doc!;
    this.workingCopy = { base, draft };
    this.doc = draft;
    this.emit("change", this.doc);
  }

  // Clear any staged working copy and return to the committed version.
  clearWorkingCopy(): void {
    this.ensureInitialized();
    this.workingCopy = undefined;
    this.doc = this.committedDoc;
    this.emit("change", this.doc!);
  }

  // Publish a cursor update for this session/user.
  updateCursors(locs: unknown): void {
    this.ensureInitialized();
    if (!this.presenceAdapter) return;
    const time = this.clock();
    const payload: CursorPresence = {
      type: "cursor",
      time,
      locs,
      userId: this.userId,
      docId: this.docId,
    };
    this.ingestCursorState({ ...payload, clientId: this.localCursorId() });
    this.emit("cursors", this.cursors());
    this.presenceAdapter.publish(payload);
  }

  // Return recent cursor states, filtered by TTL.
  cursors(opts: { ttlMs?: number } = {}): CursorSnapshot[] {
    this.ensureInitialized();
    this.pruneCursors(opts.ttlMs ?? this.cursorTtlMs);
    return Array.from(this.cursorStates.values());
  }

  // Recompute the current document (respecting undo/redo), rebase any staged working copy,
  // emit change, and enqueue a file write if needed.
  private syncDoc(): void {
    const without = this.withoutTimes();
    const baseDoc = this.graph.value({ withoutTimes: without });
    this.committedDoc = baseDoc;
    let liveDoc = baseDoc;
    if (this.workingCopy) {
      liveDoc = rebaseDraft({
        base: this.workingCopy.base as Document,
        draft: this.workingCopy.draft as Document,
        updatedBase: baseDoc,
      }) as Document;
      this.workingCopy = { base: baseDoc, draft: liveDoc };
    }
    this.doc = liveDoc;
    this.emit("change", this.doc);

    // If a file adapter is present, keep it in sync
    if (this.fileAdapter && this.doc) {
      if (this.graph.valueUnavailable()) {
        // Never persist a best-effort value: the file keeps what it has.
        if (!this.fileWritesHeld) {
          this.fileWritesHeld = true;
          this.heldFileContent = this.persistedContent;
        }
        return;
      }
      if (this.fileWritesHeld) {
        this.resumingFileSync ??= this.resumeFileSync().finally(() => {
          this.resumingFileSync = undefined;
        });
        return;
      }
      this.queueFileWriteDoc(liveDoc);
    }
  }

  // The value became available again: the file still holds what it held
  // when writes were held, unless someone edited it meanwhile. Such an edit
  // is ingested like any external edit; otherwise the value is written.
  private async resumeFileSync(): Promise<void> {
    let text: string | undefined;
    try {
      text = await this.fileAdapter!.read();
    } catch {
      text = undefined;
    }
    if (!this.fileWritesHeld || this.graph.valueUnavailable()) return;
    if (text === undefined) {
      // Without knowing what the file holds now, writing could destroy an
      // edit made meanwhile: keep holding and try again.
      this.scheduleResumeRetry();
      return;
    }
    this.fileWritesHeld = false;
    const held = this.heldFileContent;
    this.heldFileContent = undefined;
    this.persistedContent = text;
    // If the file changed while held, or what it held is unknown (its first
    // read failed), its content may be an external edit: ingest it, which
    // keeps both versions in the history, rather than overwrite it.
    if ((held === undefined || text !== held) && this.doc) {
      const fileDoc = this.codec.fromString(text);
      if (!this.doc.isEqual(fileDoc)) {
        await this.applyExternalDoc(fileDoc);
        return;
      }
    }
    if (this.doc) this.queueFileWriteDoc(this.doc);
  }

  private scheduleResumeRetry(): void {
    if (this.resumeRetryTimer != null) return;
    this.resumeRetryTimer = setTimeout(() => {
      this.resumeRetryTimer = undefined;
      if (!this.fileWritesHeld || this.closed) return;
      this.resumingFileSync ??= this.resumeFileSync().finally(() => {
        this.resumingFileSync = undefined;
      });
    }, 1000);
    this.resumeRetryTimer.unref?.();
  }

  // List local patch times that should be excluded (undo region).
  private withoutTimes(): string[] {
    if (this.undoPtr >= this.localTimes.length) return [];
    return this.localTimes.slice(this.undoPtr);
  }

  // Detect and store cursor presence payloads.
  private ingestCursorState(state: CursorPresence & { clientId?: string }): void {
    if (this.docId && state.docId && state.docId !== this.docId) {
      return;
    }
    const clientId = this.cursorKey(state);
    this.cursorStates.set(clientId, { ...state, clientId });
    this.pruneCursors();
    this.emit("cursors", this.cursors());
  }

  private isCursorPresence(state: unknown): state is CursorPresence {
    if (!state || typeof state !== "object") return false;
    const obj = state as Record<string, unknown>;
    return obj.type === "cursor" && typeof obj.time === "number" && "locs" in obj;
  }

  private localCursorId(): string {
    return `local-${this.userId ?? "anon"}`;
  }

  private cursorKey(state: CursorPresence & { clientId?: string }): string {
    if (state.userId != null) {
      return `user-${state.userId}`;
    }
    return state.clientId ?? this.localCursorId();
  }

  private pruneCursors(ttlMs: number = this.cursorTtlMs): void {
    const now = this.clock();
    for (const [id, c] of Array.from(this.cursorStates.entries())) {
      if (ttlMs && now - c.time > ttlMs) {
        this.cursorStates.delete(id);
      }
    }
    if (this.cursorPruneTimer) {
      clearTimeout(this.cursorPruneTimer);
    }
    if (ttlMs) {
      this.cursorPruneTimer = setTimeout(() => this.pruneCursors(ttlMs), ttlMs);
      this.cursorPruneTimer.unref?.();
    }
  }

  // Compute the latest logical time from the graph.
  private computeLastTimeMs(): number {
    const versions = this.graph.versions();
    if (versions.length === 0) return 0;
    let best = 0;
    for (const id of versions) {
      best = Math.max(best, decodePatchId(id).timeMs);
    }
    return best;
  }

  // Produce the next monotonic logical time (milliseconds since epoch, but monotone per client).
  private nextTimeMs(): number {
    const base = Math.max(this.clock(), this.lastTimeMs + 1);
    this.lastTimeMs = base;
    return base;
  }

  // Compute the maximum version seen in the current graph.
  private computeMaxVersion(): number {
    let max = 0;
    this.graph.history().forEach((p) => {
      if (p.version != null) {
        max = Math.max(max, p.version);
      }
    });
    if (max === 0) {
      max = this.graph.versions().length;
    }
    return max;
  }

  // React to filesystem changes by ingesting external content.
  private async handleFileChange(): Promise<void> {
    if (!this.doc || !this.fileAdapter) return;
    // Compared with the held content when writes resume.
    if (this.fileWritesHeld) return;
    if (this.suppressFileChanges > 0) {
      this.suppressFileChanges -= 1;
      return;
    }
    try {
      const text = await this.fileAdapter.read();
      const newDoc = this.codec.fromString(text);
      if (this.doc.isEqual(newDoc)) return;
      this.persistedContent = text;
      await this.applyExternalDoc(newDoc);
    } catch {
      // ignore file read errors
    }
  }

  // Convert external doc changes into a patch and append it.
  private async applyExternalDoc(newDoc: Document): Promise<void> {
    if (!this.doc) return;
    // Not on top of a value that is known to be wrong (see isValueAvailable).
    if (!this.isValueAvailable()) return;
    const parents = this.graph.getValueHeads();
    // Against the exact value of the parents, as in commit().
    const parentsValue = this.graph.exactValueOf(parents);
    const patch = (parentsValue ?? this.doc).makePatch(newDoc);
    const timeMs = this.nextTimeMs();
    const time = encodePatchId(timeMs, this.clientId);
    const nextVersion = Math.max(this.maxVersion + 1, this.graph.versions().length + 1);
    const envelope: PatchEnvelope = {
      time,
      wall: this.clock(),
      patch,
      parents,
      userId: this.userId,
      version: nextVersion,
      file: true,
      hash: parentsValue == null ? undefined : this.graph.hashOf(newDoc),
      ...this.inexactMarker(parentsValue),
      ...this.recordMerge(parents, parentsValue),
    };
    this.graph.add([envelope]);
    this.maxVersion = Math.max(this.maxVersion, nextVersion);
    this.doc = newDoc;
    this.localTimes = this.localTimes.slice(0, this.undoPtr);
    this.localTimes.push(time);
    this.undoPtr = this.localTimes.length;
    this.patchStore.append(envelope);
    this.syncDoc();
  }

  // Record desired content and start a write flush if idle.
  private queueFileWriteDoc(doc: Document): void {
    if (!this.fileAdapter) return;
    if (this.writingDoc && this.writingDoc.isEqual(doc)) return;
    if (this.dirtyDoc && this.dirtyDoc.isEqual(doc)) return;
    this.dirtyDoc = doc;
    if (this.flushingFile) return;
    void this.flushFileQueue();
  }

  // Sequentially write queued content to the file adapter with base hints.
  private async flushFileQueue(): Promise<void> {
    this.flushingFile = true;
    while (this.dirtyDoc !== undefined) {
      const doc = this.dirtyDoc;
      this.dirtyDoc = undefined;
      this.writingDoc = doc;
      const content = this.codec.toString(doc);
      if (this.persistedContent === content) {
        this.writingDoc = undefined;
        continue;
      }
      this.suppressFileChanges += 1;
      try {
        const hasBase = this.persistedContent !== undefined;
        await this.fileAdapter!.write(
          content,
          hasBase ? { base: this.persistedContent } : undefined,
        );
        this.persistedContent = content;
      } catch (err) {
        this.emit("file-error", err);
      } finally {
        this.suppressFileChanges = Math.max(0, this.suppressFileChanges - 1);
        this.writingDoc = undefined;
      }
    }
    this.flushingFile = false;
  }
}

interface PreviewState {
  revision: number;
  lastTimeMs: number;
  maxVersion: number;
  userId: number;
  base: Document;
}

interface Preview {
  envelope: PatchEnvelope;
  nextDoc: Document;
  file?: boolean;
  source?: string;
  at: PreviewState;
}

// A copy sharing nothing with value, which holds JSON values and binary
// patches (Uint8Array) only.
function ownedCopy<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map(ownedCopy) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("a patch envelope holds only JSON values and Uint8Array patches");
  }
  const copy: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) copy[key] = ownedCopy(v);
  return copy as T;
}

// Freeze value and everything in it (a Uint8Array can't be frozen).
function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object" || value instanceof Uint8Array) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

// Equal as stored: the same JSON values and bytes, where an undefined field
// is the same as a missing one (JSON drops it). Allocates nothing.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array)) return false;
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bs = b as unknown[];
    if (a.length !== bs.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], bs[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  let defined = 0;
  for (const key in ao) {
    if (ao[key] === undefined) continue;
    defined += 1;
    if (!Object.prototype.hasOwnProperty.call(bo, key) || !sameValue(ao[key], bo[key])) {
      return false;
    }
  }
  for (const key in bo) if (bo[key] !== undefined) defined -= 1;
  return defined === 0;
}
