import type { PresenceAdapter } from "../types";

export class MemoryPresenceAdapter implements PresenceAdapter {
  private listeners: { fn: (state: unknown, clientId: string) => void; id: string }[] = [];
  private counter = 0;

  publish(state: unknown): void {
    for (const { fn, id } of this.listeners) {
      fn(state, id);
    }
  }

  subscribe(onState: (state: unknown, clientId: string) => void): () => void {
    const id = `memory-${++this.counter}`;
    this.listeners.push({ fn: onState, id });
    return () => {
      this.listeners = this.listeners.filter((entry) => entry.fn !== onState);
    };
  }
}
