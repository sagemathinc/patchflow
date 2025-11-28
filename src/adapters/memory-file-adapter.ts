import type { FileAdapter } from "../types";

type Listener = (delta?: { seq?: number }) => void;

export class MemoryFileAdapter implements FileAdapter {
  private content: string;
  private listeners: Listener[] = [];
  private seq = 0;

  constructor(initial = "") {
    this.content = initial;
  }

  async read(): Promise<string> {
    return this.content;
  }

  async write(content: string): Promise<void> {
    this.content = content;
    const seq = this.seq++;
    for (const fn of this.listeners) {
      fn({ seq });
    }
  }

  watch(onChange: Listener): () => void {
    this.listeners.push(onChange);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== onChange);
    };
  }
}
