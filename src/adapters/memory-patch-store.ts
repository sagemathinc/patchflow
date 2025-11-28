import type { PatchEnvelope, PatchStore } from "../types";

export class MemoryPatchStore implements PatchStore {
  private listeners: ((env: PatchEnvelope) => void)[] = [];
  private patches: PatchEnvelope[] = [];

  constructor(initial?: PatchEnvelope[]) {
    if (initial) {
      this.patches = initial.slice();
    }
  }

  async loadInitial(): Promise<{ patches: PatchEnvelope[]; hasMore?: boolean }> {
    return { patches: this.patches.slice() };
  }

  async append(envelope: PatchEnvelope): Promise<void> {
    this.patches.push(envelope);
    for (const fn of this.listeners) {
      fn(envelope);
    }
  }

  subscribe(onEnvelope: (env: PatchEnvelope) => void): () => void {
    this.listeners.push(onEnvelope);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== onEnvelope);
    };
  }
}
