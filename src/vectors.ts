const dimension = 512;
const concepts: Record<string, string> = {
  database: 'database', db: 'database', datastore: 'database', archivio: 'database',
  postgresql: 'postgresql', postgres: 'postgresql', psql: 'postgresql',
  javascript: 'javascript', js: 'javascript', typescript: 'typescript', ts: 'typescript',
  preferisco: 'preferenza', prefer: 'preferenza', preference: 'preferenza',
  programmazione: 'coding', programming: 'coding', codice: 'coding', code: 'coding',
  progetto: 'project', progetti: 'project', projects: 'project', sviluppo: 'development',
  deployment: 'deployment', distribuzione: 'deployment',
  server: 'server', hosting: 'server', infrastruttura: 'server',
  prendiamo: 'use', usiamo: 'use', utilizziamo: 'use', utilizzo: 'use', uso: 'use', using: 'use',
};
const stop = new Set(('il lo la i le gli un una uno da di a al allo del della mio mia con su come che è e per in non ho hai quale quali qual where what which is are the a an to for our my on do of be or and i we you it as use').split(' '));

export function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}

function accumulate(vector: Float32Array, feature: string, weight: number): void {
  let hash = 2166136261;
  for (let i = 0; i < feature.length; i++) hash = Math.imul(hash ^ feature.charCodeAt(i), 16777619);
  vector[hash >>> 0 & (dimension - 1)] += (hash >>> 31 ? -1 : 1) * weight;
}

export function embedding(text: string): Buffer {
  const terms = normalize(text.replace(/\[(?:PERSON|EMAIL|API_KEY|IP|IBAN|PATH|SECRET|PHONE|PII)\]/g, ' '))
    .split(' ').filter(term => term.length > 1 && !stop.has(term))
    .map(term => Object.hasOwn(concepts, term) ? concepts[term] : term);
  const vector = new Float32Array(dimension);
  for (const term of new Set(terms)) {
    accumulate(vector, 'w:' + term, 1);
    const wrapped = '^' + term + '$';
    const weight = 0.5 / Math.sqrt(wrapped.length - 2);
    for (let i = 0; i < wrapped.length - 2; i++) accumulate(vector, 'c:' + wrapped.slice(i, i + 3), weight);
  }
  for (let i = 1; i < terms.length; i++) accumulate(vector, 'b:' + terms[i - 1] + ':' + terms[i], 0.25);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  const bytes = Buffer.alloc(dimension * 4);
  for (let i = 0; i < dimension; i++) bytes.writeFloatLE(vector[i] / norm, i * 4);
  return bytes;
}

export function cosine(a: Uint8Array, b: Uint8Array): number {
  const x = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const y = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let dot = 0;
  for (let i = 0; i < dimension * 4; i += 4) dot += x.getFloat32(i, true) * y.getFloat32(i, true);
  return Math.max(-1, Math.min(1, dot));
}
