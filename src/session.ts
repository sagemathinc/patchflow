import { EventEmitter } from "events";
import { PatchGraph } from "./patch-graph";
import type {
  DocCodec,
  Document,
  PatchEnvelope,
  PatchStore,
  FileAdapter,
  PresenceAdapter,
} from "./types";

export type SessionOptions = {
  codec: DocCodec;
  patchStore: PatchStore;
  clock?: () => number;
  userId?: number;
  fileAdapter?: FileAdapter;
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
  private doc?: Document;
  private lastDoc?: Document;
  private lastTime: number = 0;
  private userId: number;

  private localTimes: number[] = [];
  private undoPtr = 0;
  private unsubscribe?: () => void;
  private fileUnsubscribe?: () => void;

  constructor(opts: SessionOptions) {
    super();
    this.codec = opts.codec;
    this.patchStore = opts.patchStore;
    this.clock = opts.clock ?? (() => Date.now());
    this.userId = opts.userId ?? 0;
    this.fileAdapter = opts.fileAdapter;
    this.presenceAdapter = opts.presenceAdapter;
    this.graph = new PatchGraph({ codec: this.codec });
  }

  /**
   * Load initial history and start listening for remote patches.
   */
  async init(): Promise<void> {
    const { patches } = await this.patchStore.loadInitial();
    this.graph.add(patches);
    this.lastTime = this.computeLastTime();
    this.doc = this.graph.value();
    this.lastDoc = this.doc;
    this.emit("change", this.doc);
    this.unsubscribe = this.patchStore.subscribe((env) => {
      this.applyRemote(env);
    });
    if (this.fileAdapter?.watch) {
      this.fileUnsubscribe = this.fileAdapter.watch(async () => {
        await this.handleFileChange();
      });
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.fileUnsubscribe?.();
    this.presenceAdapter?.publish(undefined);
    this.removeAllListeners();
  }

  getDocument(): Document {
    if (!this.doc) {
      throw new Error("session not initialized");
    }
    return this.doc;
  }

  /**
   * Commit a new document state as a patch and append to the store.
   */
  async commit(nextDoc: Document): Promise<PatchEnvelope> {
    if (!this.doc) {
      throw new Error("session not initialized");
    }
    const patch = this.doc.makePatch(nextDoc);
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
    this.doc = nextDoc;
    this.lastDoc = nextDoc;
    // Reset undo future and record this local change.
    this.localTimes = this.localTimes.slice(0, this.undoPtr);
    this.localTimes.push(time);
    this.undoPtr = this.localTimes.length;
    await this.patchStore.append(envelope);
    // Optionally persist to a file adapter
    if (this.fileAdapter) {
      await this.fileAdapter.write(this.codec.toString(nextDoc), {
        base: this.lastDoc ? this.codec.toString(this.lastDoc) : undefined,
      });
    }
    // Optionally publish presence after commit
    this.presenceAdapter?.publish({ userId: this.userId, time });
    this.syncDoc();
    return envelope;
  }

  /**
   * Apply a remote patch envelope.
   */
  applyRemote(env: PatchEnvelope): void {
    this.graph.add([env]);
    this.lastTime = Math.max(this.lastTime, env.time);
    this.syncDoc();
  }

  undo(): void {
    if (this.undoPtr === 0) return;
    this.undoPtr -= 1;
    this.syncDoc();
    this.emit("undo", this.doc);
    this.presenceAdapter?.publish({ userId: this.userId, undoPtr: this.undoPtr });
  }

  redo(): void {
    if (this.undoPtr === this.localTimes.length) return;
    this.undoPtr += 1;
    this.syncDoc();
    this.emit("redo", this.doc);
    this.presenceAdapter?.publish({ userId: this.userId, undoPtr: this.undoPtr });
  }

  private syncDoc(): void {
    const without = this.withoutTimes();
    this.doc = this.graph.value({ withoutTimes: without });
    this.lastDoc = this.doc;
    this.emit("change", this.doc);

    // If a file adapter is present, keep it in sync
    if (this.fileAdapter && this.doc) {
      this.fileAdapter.write(this.codec.toString(this.doc)).catch(() => {
        /* ignore file adapter errors in sync */
      });
    }
  }

  private withoutTimes(): number[] {
    if (this.undoPtr >= this.localTimes.length) return [];
    return this.localTimes.slice(this.undoPtr);
  }

  private computeLastTime(): number {
    const versions = this.graph.versions();
    if (versions.length === 0) return 0;
    return Math.max(...versions);
  }

  private nextTime(): number {
    const t = this.clock();
    if (t > this.lastTime) {
      this.lastTime = t;
    } else {
      this.lastTime += 1;
    }
    return this.lastTime;
  }

  private async handleFileChange(): Promise<void> {
    if (!this.doc || !this.fileAdapter) return;
    try {
      const text = await this.fileAdapter.read();
      const newDoc = this.codec.fromString(text);
      if (this.doc.isEqual(newDoc)) return;
      await this.applyExternalDoc(newDoc);
    } catch {
      // ignore file read errors
    }
  }

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
    this.lastDoc = newDoc;
    this.localTimes = this.localTimes.slice(0, this.undoPtr);
    this.localTimes.push(time);
    this.undoPtr = this.localTimes.length;
    await this.patchStore.append(envelope);
    this.syncDoc();
  }
}
