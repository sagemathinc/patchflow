import { EventEmitter } from "events";
import { PatchGraph } from "./patch-graph";
import type { DocCodec, Document, Patch } from "./types";

export interface PatchEnvelope extends Patch {
  // Optional metadata describing where the patch came from (e.g., transport id).
  source?: string;
}

export interface PatchStore {
  loadInitial(opts?: { sinceTime?: number }): Promise<{
    patches: PatchEnvelope[];
    hasMore?: boolean;
  }>;
  append(envelope: PatchEnvelope): Promise<void>;
  subscribe(onEnvelope: (env: PatchEnvelope) => void): () => void;
}

export type SessionOptions = {
  codec: DocCodec;
  patchStore: PatchStore;
  clock?: () => number;
  userId?: number;
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
  private doc?: Document;
  private lastDoc?: Document;
  private lastTime: number = 0;
  private userId: number;

  private localTimes: number[] = [];
  private undoPtr = 0;
  private unsubscribe?: () => void;

  constructor(opts: SessionOptions) {
    super();
    this.codec = opts.codec;
    this.patchStore = opts.patchStore;
    this.clock = opts.clock ?? (() => Date.now());
    this.userId = opts.userId ?? 0;
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
  }

  close(): void {
    this.unsubscribe?.();
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
  }

  redo(): void {
    if (this.undoPtr === this.localTimes.length) return;
    this.undoPtr += 1;
    this.syncDoc();
    this.emit("redo", this.doc);
  }

  private syncDoc(): void {
    const without = this.withoutTimes();
    this.doc = this.graph.value({ withoutTimes: without });
    this.lastDoc = this.doc;
    this.emit("change", this.doc);
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
}
