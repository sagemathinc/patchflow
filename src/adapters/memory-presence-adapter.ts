import type { PresenceAdapter } from "../types";

export class MemoryPresenceAdapter implements PresenceAdapter {
  private listeners: ((state: unknown, clientId: string) => void)[] = [];

  publish(state: unknown): void {
    for (const fn of this.listeners) {
      fn(state, "memory");
    }
  }

  subscribe(onState: (state: unknown, clientId: string) => void): () => void {
    this.listeners.push(onState);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== onState);
    };
  }
}
