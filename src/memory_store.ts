import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cosine, embedding } from './vectors.ts';
import type { Config } from './config.ts';

const day = 86_400_000;
export type StoreConfig = Pick<Config, 'database' | 'decayPerDay' | 'archiveBelow' | 'retrievalBelow'>;
export interface Fact {
  slot: string;
  content: string;
  importance: number;
  supersedes: number[];
}
export interface Candidate { id: number; fact_key: string; content: string }
type Existing = Candidate & { status: string; observed_at: number; normalized_content: string };

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly config: StoreConfig;

  constructor(config: StoreConfig) {
    this.config = config;
    mkdirSync(dirname(config.database), { recursive: true });
    this.db = new DatabaseSync(config.database);
    this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    this.db.function('vec_cosine', { deterministic: true }, (left, right) => {
      return left instanceof Uint8Array && right instanceof Uint8Array ? cosine(left, right) : 0;
    });
    this.db.function('forgetting', { deterministic: true }, (rate, age) => {
      return Math.exp(-Number(rate) * Math.max(0, Number(age)) / day);
    });
  }

  archive(now = Date.now(), namespace?: string): void {
    const filter = namespace === undefined ? '' : ' AND namespace = ?';
    const parameters = namespace === undefined ? [] : [namespace];
    this.db.prepare("UPDATE memory_nodes SET status = 'archived' WHERE status = 'active' " +
      'AND importance_score * forgetting(decay_rate, ? - last_accessed_at) < ?' + filter)
      .run(now, this.config.archiveBelow, ...parameters);
  }

  retrieve(namespace: string, query: string, now = Date.now()): string[] {
    if (!query.trim()) return [];
    return this.transaction(() => {
      this.archive(now, namespace);
      const rows = this.db.prepare(
        'WITH matches AS MATERIALIZED (' +
        ' SELECT id, content, vec_cosine(embedding, ?) AS similarity,' +
        ' importance_score * forgetting(decay_rate, ? - last_accessed_at) AS strength' +
        " FROM memory_nodes WHERE namespace = ? AND status = 'active'" +
        ') SELECT id, content FROM matches WHERE similarity >= 0.14 AND similarity * strength >= ?' +
        ' ORDER BY similarity * strength DESC, id DESC LIMIT 5',
      ).all(embedding(query), now, namespace, this.config.retrievalBelow) as unknown as { id: number; content: string }[];
      const touch = this.db.prepare('UPDATE memory_nodes SET last_accessed_at = MAX(last_accessed_at, ?) WHERE id = ? AND namespace = ?');
      for (const row of rows) touch.run(now, row.id, namespace);
      return rows.map(row => row.content);
    });
  }

  candidates(namespace: string, text: string): Candidate[] {
    return this.db.prepare(
      'WITH matches AS MATERIALIZED (' +
      ' SELECT id, fact_key, content, vec_cosine(embedding, ?) AS similarity FROM memory_nodes' +
      " WHERE namespace = ? AND status = 'active'" +
      ') SELECT id, fact_key, content FROM matches ORDER BY similarity DESC, id DESC LIMIT 12',
    ).all(embedding(text), namespace) as unknown as Candidate[];
  }

  save(namespace: string, facts: Fact[], observed: number, now = Date.now()): void {
    this.transaction(() => {
      this.archive(now, namespace);
      for (const fact of facts) this.saveFact(namespace, fact, observed, now);
    });
  }

  private saveFact(namespace: string, fact: Fact, observed: number, now: number): void {
    const identity = fact.content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
    const latest = this.db.prepare(
      'SELECT observed_at FROM memory_nodes WHERE namespace = ? AND fact_key = ? ORDER BY observed_at DESC LIMIT 1',
    ).get(namespace, fact.slot);
    if (Number(latest?.observed_at ?? 0) > observed) return;

    const matches = this.db.prepare("SELECT * FROM memory_nodes WHERE namespace = ? AND status = 'active' " +
      'AND (fact_key = ? OR normalized_content = ?)').all(namespace, fact.slot, identity) as unknown as Existing[];
    const linked = this.db.prepare('SELECT * FROM memory_nodes WHERE namespace = ? AND id = ?');
    for (const id of new Set(fact.supersedes)) {
      const candidate = linked.get(namespace, id) as unknown as Existing | undefined;
      if (!candidate) continue;
      if (candidate.status === 'superseded') return;
      if (candidate.status === 'active' && !matches.some(match => match.id === id)) matches.push(candidate);
    }
    if (matches.some(match => match.observed_at > observed)) return;

    const equivalent = matches.find(match => match.normalized_content === identity);
    const deferUniqueKeys = this.db.prepare("UPDATE memory_nodes SET status = 'archived' WHERE namespace = ? AND id = ?");
    for (const match of matches) {
      if (match.id !== equivalent?.id) deferUniqueKeys.run(namespace, match.id);
    }
    let successor: number | bigint;
    if (equivalent) {
      successor = equivalent.id;
      this.db.prepare('UPDATE memory_nodes SET last_accessed_at = MAX(last_accessed_at, ?), ' +
        'observed_at = ?, importance_score = MAX(importance_score, ?), fact_key = ? WHERE id = ? AND namespace = ?')
        .run(now, observed, fact.importance, fact.slot, successor, namespace);
    } else {
      successor = this.db.prepare(
        'INSERT INTO memory_nodes (namespace, fact_key, content, normalized_content, embedding, importance_score,' +
        ' created_at, last_accessed_at, observed_at, decay_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(namespace, fact.slot, fact.content, identity, embedding(fact.content), fact.importance,
        now, now, observed, this.config.decayPerDay).lastInsertRowid;
    }
    const invalidate = this.db.prepare("UPDATE memory_nodes SET status = 'superseded', superseded_by_id = ? WHERE namespace = ? AND id = ?");
    for (const match of matches) {
      if (match.id !== successor) invalidate.run(successor, namespace, match.id);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
