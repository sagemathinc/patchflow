import { EventEmitter } from "events";
import { PatchGraph } from "./patch-graph";
import { rebaseDraft } from "./working-copy";
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
  // Optional document identifier for presence scoping (e.g., path or id).
  docId?: string;
  // Optional file adapter to mirror the current doc to disk and watch for external edits.
  fileAdapter?: FileAdapter;
  // Optional presence adapter to publish/receive lightweight presence state.
  presenceAdapter?: PresenceAdapter;
};

/**
 * Session orchestrates a local Document against a PatchGraph and a PatchStore.
 * It handles local commits, remote patches, and basic undo/redo of local changes.
 */
export class Session extends EventEmitter {
  private readonly codec: DocCodec;
  private readonly patchStore: PatchStore;
  private readonly clock: () => number;
  private readonly graph: PatchGraph;
  private readonly fileAdapter?: FileAdapter;
  private readonly presenceAdapter?: PresenceAdapter;
  private readonly docId?: string;
  private doc?: Document; // live doc (committed + staged)
  private committedDoc?: Document; // graph-derived doc without staged edits
  private lastTime: number = 0;
  private userId: number;

  private localTimes: number[] = [];
  private undoPtr = 0;
  private unsubscribe?: () => void;
  private fileUnsubscribe?: () => void;
  private pendingWrite?: Promise<void>;
  private dirtyContent?: string;
  private persistedContent?: string;
  private suppressFileChanges = 0;
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
    this.graph = new PatchGraph({ codec: this.codec });
  }

  // Load initial history, seed state, and subscribe to adapters.
  async init(): Promise<void> {
    const { patches, hasMore } = await this.patchStore.loadInitial();
    this.hasMoreHistory = !!hasMore;
    this.graph.add(patches);
    this.lastTime = this.computeLastTime();
    this.committedDoc = this.graph.value();
    this.doc = this.committedDoc;
    if (this.fileAdapter && this.doc) {
      // Track current doc string so we can skip redundant writes.
      this.persistedContent = this.codec.toString(this.doc);
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

  // Return logical times (versions) in ascending order.
  versions(opts: { start?: number; end?: number } = {}): number[] {
    this.ensureInitialized();
    return this.graph.versions(opts);
  }

  // Compute the document at a specific version or with exclusions.
  value(opts: PatchGraphValueOptions = {}): Document {
    this.ensureInitialized();
    return this.graph.value(opts);
  }

  // Return a sorted list of patches in the session, optionally filtered.
  history(
    opts: { start?: number; end?: number; includeSnapshots?: boolean } = {},
  ): PatchEnvelope[] {
    this.ensureInitialized();
    return this.graph.history(opts).map((p) => ({ ...p }));
  }

  // Fetch a specific patch by logical time.
  getPatch(time: number): PatchEnvelope {
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
        ? String(p.wall ?? p.time)
        : new Date(p.wall ?? p.time).toISOString();
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
  commit(nextDoc: Document, opts: { file?: boolean; source?: string } = {}): PatchEnvelope {
    if (!this.committedDoc) {
      throw new Error("session not initialized");
    }
    const base = this.workingCopy?.base ?? this.committedDoc;
    const patch = this.codec.makePatch(base, nextDoc);
    const time = this.nextTime();
    const envelope: PatchEnvelope = {
      time,
      wall: this.clock(),
      patch,
      parents: this.graph.getHeads(),
      userId: this.userId,
      version: this.graph.versions().length + 1,
      file: opts.file,
      source: opts.source,
    };
    this.graph.add([envelope]);
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

  // Merge a remote patch and refresh the current document.
  applyRemote(env: PatchEnvelope): void {
    this.graph.add([env]);
    this.lastTime = Math.max(this.lastTime, env.time);
    this.syncDoc();
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
  undoState(): { undoPtr: number; localTimes: number[] } {
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
    const text = this.codec.toString(liveDoc);
    this.emit("change", this.doc);

    // If a file adapter is present, keep it in sync
    if (this.fileAdapter && this.doc) {
      this.queueFileWrite(text);
    }
  }

  // List local patch times that should be excluded (undo region).
  private withoutTimes(): number[] {
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
  private computeLastTime(): number {
    const versions = this.graph.versions();
    if (versions.length === 0) return 0;
    return Math.max(...versions);
  }

  // Produce the next monotonic logical time.
  private nextTime(): number {
    const t = this.clock();
    if (t > this.lastTime) {
      this.lastTime = t;
    } else {
      this.lastTime += 1;
    }
    return this.lastTime;
  }

  // React to filesystem changes by ingesting external content.
  private async handleFileChange(): Promise<void> {
    if (!this.doc || !this.fileAdapter) return;
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
    const patch = this.doc.makePatch(newDoc);
    const time = this.nextTime();
    const envelope: PatchEnvelope = {
      time,
      wall: this.clock(),
      patch,
      parents: this.graph.getHeads(),
      userId: this.userId,
      version: this.graph.versions().length + 1,
    };
    this.graph.add([envelope]);
    this.doc = newDoc;
    this.localTimes = this.localTimes.slice(0, this.undoPtr);
    this.localTimes.push(time);
    this.undoPtr = this.localTimes.length;
    this.patchStore.append(envelope);
    this.syncDoc();
  }

  // Record desired content and start a write flush if idle.
  private queueFileWrite(content: string): void {
    if (!this.fileAdapter) return;
    if (this.persistedContent === content && !this.dirtyContent) return;
    this.dirtyContent = content;
    if (this.pendingWrite) return;
    this.pendingWrite = this.flushFileQueue();
  }

  // Sequentially write queued content to the file adapter with base hints.
  private async flushFileQueue(): Promise<void> {
    while (this.dirtyContent !== undefined) {
      const content = this.dirtyContent;
      this.dirtyContent = undefined;
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
      }
    }
    this.pendingWrite = undefined;
  }
}
