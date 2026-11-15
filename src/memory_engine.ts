import { Worker } from 'node:worker_threads';
import type { Config } from './config.ts';

export type MemoryConfig = Pick<Config, 'database' | 'decayPerDay' | 'archiveBelow' | 'retrievalBelow' |
  'ollama' | 'model' | 'ner' | 'privacyTimeout' | 'memoryTimeout'>;
export type Exchange = { namespace: string; text: string; observed: number };
export type Command =
  | { kind: 'retrieve'; id: number; namespace: string; text: string }
  | { kind: 'learn'; id: number; exchange: Exchange }
  | { kind: 'stop' };
export type Reply =
  | { kind: 'ready' | 'stopped' }
  | { kind: 'result'; id: number; facts: string[] }
  | { kind: 'learned'; id: number };

export class MemoryEngine {
  private readonly worker: Worker;
  private readonly reads = new Map<number, (value: string[]) => void>();
  private readonly writes = new Set<number>();
  private nextId = 0;
  private state: 'starting' | 'ready' | 'closed' = 'starting';
  private readonly ready: Promise<void>;
  private readonly stopped: Promise<void>;

  constructor(config: MemoryConfig) {
    const { database, decayPerDay, archiveBelow, retrievalBelow, ollama, model, ner, privacyTimeout, memoryTimeout } = config;
    this.worker = new Worker(new URL('./memory_worker.ts', import.meta.url), {
      workerData: { database, decayPerDay, archiveBelow, retrievalBelow, ollama: ollama.href, model, ner, privacyTimeout, memoryTimeout },
    });
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    const stopped = Promise.withResolvers<void>();
    this.stopped = stopped.promise;
    const cleanup = () => {
      if (this.state === 'starting') ready.reject(new Error('SQLite worker non disponibile'));
      this.state = 'closed';
      for (const resolve of this.reads.values()) resolve([]);
      this.reads.clear();
      this.writes.clear();
      stopped.resolve();
    };
    this.worker.on('message', (reply: Reply) => {
      if (reply.kind === 'ready') { this.state = 'ready'; ready.resolve(); }
      if (reply.kind === 'stopped') cleanup();
      if (reply.kind === 'result') { this.reads.get(reply.id)?.(reply.facts); this.reads.delete(reply.id); }
      if (reply.kind === 'learned') this.writes.delete(reply.id);
    });
    this.worker.on('error', cleanup);
    this.worker.on('exit', cleanup);
  }

  get healthy(): boolean { return this.state === 'ready'; }
  async started(): Promise<void> { await this.ready; }

  async retrieve(namespace: string, text: string, signal: AbortSignal): Promise<string[]> {
    if (!this.healthy || !text.trim() || signal.aborted) return [];
    const id = ++this.nextId;
    const pending = Promise.withResolvers<string[]>();
    const fallback = () => pending.resolve([]);
    const timer = setTimeout(fallback, 300);
    signal.addEventListener('abort', fallback, { once: true });
    this.reads.set(id, pending.resolve);
    try {
      this.send({ kind: 'retrieve', id, namespace, text: text.slice(-6000) });
      return await pending.promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', fallback);
      this.reads.delete(id);
    }
  }

  learn(exchange: Exchange): void {
    if (!this.healthy || !exchange.text.trim() || this.writes.size >= 32) return;
    const id = ++this.nextId;
    this.writes.add(id);
    this.send({ kind: 'learn', id, exchange: { ...exchange, text: exchange.text.slice(-6000) } });
  }

  async close(): Promise<void> {
    if (this.state !== 'closed') {
      const expired = Promise.withResolvers<void>();
      const timer = setTimeout(expired.resolve, 2000);
      this.send({ kind: 'stop' });
      await Promise.race([this.stopped, expired.promise]);
      clearTimeout(timer);
    }
    await this.worker.terminate();
  }

  private send(command: Command): void { this.worker.postMessage(command); }
}
