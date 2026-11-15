import { resolve } from 'node:path';

export interface Config {
  port: number;
  database: string;
  upstream: URL;
  upstreamKey: string;
  upstreamWorkspace: string;
  clientKey: string;
  ollama: URL;
  model: string;
  ner: 'required' | 'heuristic';
  privacyTimeout: number;
  memoryTimeout: number;
  upstreamTimeout: number;
  archiveBelow: number;
  retrievalBelow: number;
  decayPerDay: number;
}

export function loopback(host: string): boolean {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(host);
}

function endpoint(value: string, localOnly: boolean): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.hash || url.search || (!loopback(url.hostname) && (localOnly || url.protocol !== 'https:'))) {
    throw new Error('Endpoint non ammesso');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function appendPath(url: URL, suffix: string): URL {
  const result = new URL(url);
  result.pathname = url.pathname.replace(/\/+$/, '') + suffix;
  return result;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function number(name: string, defaultValue: number, min: number, max: number): number {
    const value = env[name] === undefined ? defaultValue : Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('Valore non valido: ' + name);
    return value;
  }
  const upstream = endpoint(env.MN_UPSTREAM_BASE_URL ?? 'http://127.0.0.1:11434/v1', false);
  const ner = env.MN_NER_MODE ?? 'required';
  if (ner !== 'required' && (ner !== 'heuristic' || !loopback(upstream.hostname))) {
    throw new Error('MN_NER_MODE=heuristic richiede un provider su loopback');
  }
  const model = env.MN_LOCAL_MODEL ?? 'qwen2.5-coder:1.5b';
  if (!/^[\w.:-]{1,100}$/.test(model) || /cloud/i.test(model)) {
    throw new Error('MN_LOCAL_MODEL deve indicare un modello Ollama locale');
  }
  const port = number('MN_PORT', 8787, 0, 65535);
  if (!Number.isInteger(port)) throw new Error('MN_PORT deve essere un intero');
  return {
    port,
    database: resolve(env.MN_DB_PATH ?? 'data/mnemosyne.sqlite'),
    upstream,
    upstreamKey: env.MN_UPSTREAM_API_KEY ?? '',
    upstreamWorkspace: env.MN_ANTHROPIC_WORKSPACE ?? '',
    clientKey: env.MN_CLIENT_KEY ?? '',
    ollama: endpoint(env.MN_OLLAMA_URL ?? 'http://127.0.0.1:11434', true),
    model,
    ner,
    privacyTimeout: number('MN_PRIVACY_TIMEOUT_MS', 90000, 100, 300000),
    memoryTimeout: number('MN_MEMORY_TIMEOUT_MS', 90000, 100, 300000),
    upstreamTimeout: number('MN_UPSTREAM_TIMEOUT_MS', 180000, 100, 600000),
    archiveBelow: number('MN_ARCHIVE_BELOW', 0.25, 0.001, 1),
    retrievalBelow: number('MN_RETRIEVAL_BELOW', 0.55, 0.01, 10),
    decayPerDay: number('MN_DECAY_PER_DAY', 0.035, 0.0001, 10),
  };
}
