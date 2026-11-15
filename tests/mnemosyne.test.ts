import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { readConfig } from '../src/config.ts';
import { Vaults, regexScrub } from '../src/firewall.ts';
import { MemoryStore } from '../src/memory_store.ts';
import { createProxy } from '../src/proxy.ts';
import type { Server } from 'node:http';
import type { JsonObject } from '../src/json.ts';

const fixtures = mkdtempSync(join(tmpdir(), 'mnemosyne-test-'));
const database = join(fixtures, 'memory.sqlite');
const requests: { headers: Record<string, unknown>; body: JsonObject }[] = [];
const sample = 'Mi chiamo Mario Rossi. Ada Lovelace usa ada@example.test e 192.0.2.21. ' +
  'IBAN IT60X0542811101000000123456, chiave sk-proj-abcdefghijklmnop e file "C:\\Users\\Ada Lovelace\\draft.txt".';
const rawSecrets = ['Mario Rossi', 'Ada Lovelace', 'ada@example.test', '192.0.2.21',
  'IT60X0542811101000000123456', 'sk-proj-abcdefghijklmnop', 'C:\\Users\\Ada Lovelace\\draft.txt'];
let denyNer = false;
let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let endpoint: string;
let proxy: ReturnType<typeof createProxy>;

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}

function sendData(data: unknown): string { return 'data: ' + JSON.stringify(data) + '\r\n\r\n'; }
function sendJson(res: import('node:http').ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

const mock = createServer(async (req, res) => {
  if (req.url === '/v1/models') { sendJson(res, { object: 'list', data: [{ id: 'mock' }] }); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
  const messages = body.messages as JsonObject[];
  if (req.url === '/api/chat') {
    const input = JSON.parse(String(messages[1].content));
    if (Array.isArray(input)) {
      if (denyNer) { sendJson(res, { error: 'indisponibile' }, 503); return; }
      const entities = input.flatMap(({ index, text }: { index: number; text: string }) =>
        ['Ada Lovelace', 'Ada "Esempio"', 'I met Ibrahim Okafor yesterday.', 'Usiamo MySQL come database.']
          .filter(value => text.includes(value)).map(value => ({ index, value, kind: 'PERSON' })));
      sendJson(res, { message: { content: JSON.stringify({ entities }) } });
    } else {
      let facts: unknown[] = [];
      for (const color of ['verde', 'blu']) {
        const evidence = 'La tinta del pannello è ' + color + '.';
        if (input.user_text.includes(evidence)) {
          facts = [{ slot: 'panel.color', content: evidence, evidence, importance: 7,
            supersedes: input.existing.filter((entry: JsonObject) => String(entry.content).includes('tinta del pannello')).map((entry: JsonObject) => entry.id) }];
        }
      }
      sendJson(res, { message: { content: JSON.stringify({ facts }) } });
    }
    return;
  }
  requests.push({ headers: req.headers, body });
  const input = messages.at(-1)?.content;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  if (text === 'Upstream error') { sendJson(res, { error: { message: 'provider-private-detail' } }, 429); return; }
  if (!body.stream) {
    sendJson(res, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  function chunk(choices: unknown[], other = {}): string {
    return sendData({ id: 'stream', object: 'chat.completion.chunk', choices, ...other });
  }
  res.write(': heartbeat\r\n\r\n' + chunk([{ index: 0, delta: { role: 'assistant', content: 'L’inizio ' } }]));
  if (gate) await gate.promise;
  const token = text.match(/\[PERSON_[a-f0-9]{20}\]/)?.[0] ?? '';
  const split = 12;
  const frames = Buffer.from(chunk([
    { index: 0, delta: { content: token.slice(0, split), tool_calls: [{ index: 0, id: 'tool_1', type: 'function', function: { name: 'run', arguments: '{"name":"' + token.slice(0, split) } }] } },
    { index: 1, delta: { content: 'altra scelta' } },
  ]) + chunk([
    { index: 0, delta: { content: token.slice(split) + '!' }, finish_reason: null },
    { index: 1, delta: {}, finish_reason: 'stop' },
  ]) + chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: token.slice(split) + '"}' } }] }, finish_reason: 'tool_calls' }]) +
    chunk([], { usage: { completion_tokens: 3 } }) + 'data: [DONE]\r\n\r\n');
  for (let i = 0; i < frames.length; i += 19) res.write(frames.subarray(i, i + 19));
  res.end();
});

before(async () => {
  const upstream = await listen(mock);
  proxy = createProxy(readConfig({
    MN_PORT: '0', MN_DB_PATH: database, MN_UPSTREAM_BASE_URL: upstream + '/v1',
    MN_OLLAMA_URL: upstream, MN_UPSTREAM_API_KEY: 'fixture-upstream-key', MN_CLIENT_KEY: 'fixture-client-key',
  }));
  endpoint = 'http://127.0.0.1:' + await proxy.start();
});

after(async () => {
  gate?.resolve();
  if (proxy) await proxy.close();
  if (mock.listening) await new Promise<void>(resolve => { mock.close(() => resolve()); mock.closeAllConnections(); });
  for (const name of ['memory.sqlite', 'decay.sqlite', 'memory.sqlite-shm', 'memory.sqlite-wal', 'decay.sqlite-shm', 'decay.sqlite-wal']) {
    rmSync(join(fixtures, name), { force: true });
  }
  rmdirSync(fixtures);
});

function post(text: string, namespace = 'project-a', overrides: JsonObject = {}, moreHeaders: Record<string, string> = {}) {
  return fetch(endpoint + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: 'Bearer fixture-client-key',
      ...(namespace ? { 'X-Context-Namespace': namespace } : {}), ...moreHeaders,
    },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: text }], ...overrides }),
    signal: AbortSignal.timeout(5000),
  });
}

function rows(sql: string, ...values: (string | number)[]) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare(sql).all(...values); } finally { db.close(); }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read();
    if (value !== undefined) return value;
    await delay(30);
  }
  throw new Error('Aggiornamento SQLite non osservato');
}

test('redige NER e regex, ripristina JSON e usa credenziali upstream separate', async () => {
  assert.equal((await fetch(endpoint + '/health')).status, 401);
  const auth = { authorization: 'Bearer fixture-client-key' };
  assert.equal((await fetch(endpoint + '/health', { headers: auth })).status, 200);
  assert.equal((await (await fetch(endpoint + '/v1/models', { headers: auth })).json()).data[0].id, 'mock');
  const response = await post(sample, 'project-a', {}, { 'X-Context-Session': 'session-a' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, sample);
  const first = requests.at(-1)!;
  const data = JSON.stringify(first.body);
  for (const raw of rawSecrets) assert.ok(!data.includes(raw), raw);
  for (const kind of ['PERSON', 'EMAIL', 'IP', 'IBAN', 'API_KEY', 'PATH']) assert.match(data, new RegExp('\\[' + kind + '_'));
  assert.equal(first.headers.authorization, 'Bearer fixture-upstream-key');
  assert.equal(first.headers['x-context-namespace'], undefined);
  await (await post(sample, 'project-a', {}, { 'X-Context-Session': 'session-a' })).json();
  assert.deepEqual(requests.at(-1)?.body, first.body);
  await (await post(sample, 'project-a', {}, { 'X-Context-Session': 'session-b' })).json();
  assert.notDeepEqual(requests.at(-1)?.body, first.body);
});

test('ritrasmette SSE progressivi, scelte, usage e argomenti tool con token spezzati', async () => {
  gate = Promise.withResolvers<void>();
  const response = await post('Ada "Esempio"', 'stream-test', { stream: true, n: 2 });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('L’inizio')) {
      const { value, done } = await reader.read();
      assert.ok(!done);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    gate.resolve();
    gate = undefined;
  }
  for (;;) {
    const { value, done } = await reader.read();
    text += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  assert.match(text, /: heartbeat/);
  assert.match(text, /data: \[DONE\]/);
  const events = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  const choices = events.flatMap(event => event.choices);
  assert.equal(choices.filter(choice => choice.index === 0).map(choice => choice.delta.content ?? '').join(''), 'L’inizio Ada "Esempio"!');
  assert.equal(choices.filter(choice => choice.index === 1).map(choice => choice.delta.content ?? '').join(''), 'altra scelta');
  assert.deepEqual(JSON.parse(choices.flatMap(choice => choice.delta.tool_calls ?? []).map(call => call.function.arguments).join('')), { name: 'Ada "Esempio"' });
  assert.equal(choices.at(-1).finish_reason, 'tool_calls');
  assert.deepEqual(events.at(-1).usage, { completion_tokens: 3 });
});

test('tratta i dati degli argomenti tool e blocca la richiesta se NER non risponde', async () => {
  const response = await post('Hai visto il tool?', 'tools', {
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'run', arguments: '{"name":"Ada Lovelace","email":"ada@example\\u002etest","password":"fixture secret"}' } }] },
      { role: 'user', content: 'Hai visto il tool?' },
    ],
  });
  assert.equal(response.status, 200);
  await response.json();
  const body = JSON.stringify(requests.at(-1)?.body);
  for (const secret of ['Ada Lovelace', 'ada@example.test', 'fixture secret']) assert.ok(!body.includes(secret));
  assert.match(body, /\[PERSON_/);
  assert.match(body, /\[SECRET_/);
  await (await post('I met Ibrahim Okafor yesterday.', 'tools')).json();
  assert.match(JSON.stringify(requests.at(-1)?.body), /I met \[PERSON_[a-f0-9]{20}\] yesterday/);
  const before = requests.length;
  denyNer = true;
  try {
    const failed = await post('Test Ada Lovelace');
    assert.equal(failed.status, 503);
    assert.equal(requests.length, before);
  } finally { denyNer = false; }
});

test('blocca media, origini browser, host non locali e configura HTTPS per upstream cloud', async () => {
  const media = { model: 'mock', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/picture' } }] }] };
  assert.equal((await post('', 'media', media)).status, 400);
  assert.equal((await post('hello', 'media', {}, { origin: 'https://example.test' })).status, 403);
  assert.throws(() => readConfig({ MN_UPSTREAM_BASE_URL: 'http://example.test/v1' }));
  assert.throws(() => readConfig({ MN_UPSTREAM_BASE_URL: 'https://example.test/v1', MN_NER_MODE: 'heuristic' }));
  assert.throws(() => readConfig({ MN_OLLAMA_URL: 'https://example.test/ollama' }));
  assert.equal((await post('malformed', 'a / b')).status, 400);
  const error = await post('Upstream error');
  assert.equal(error.status, 429);
  assert.doesNotMatch(await error.text(), /provider-private-detail/);
});

test('archivia un fatto solo quando decade e protegge il grafo da aggiornamenti fuori ordine', () => {
  const day = 86_400_000;
  const store = new MemoryStore(readConfig({ MN_DB_PATH: join(fixtures, 'decay.sqlite'), MN_DECAY_PER_DAY: '0.1' }));
  try {
    store.save('A', [{ slot: 'project.database', content: 'Vuoto SQLite', importance: 8, supersedes: [] }], 100, 100);
    assert.deepEqual(store.retrieve('A', 'asteroidi nello spazio', 150), []);
    assert.deepEqual(store.retrieve('A', 'Vuoto SQLite', 160), ['Vuoto SQLite']);
    store.save('A', [{ slot: 'project.database', content: 'PostgreSQL', importance: 8, supersedes: [] }], 180, 180);
    store.save('A', [{ slot: 'project.database', content: 'MySQL', importance: 8, supersedes: [] }], 170, 190);
    assert.deepEqual(store.retrieve('A', 'PostgreSQL', 200), ['PostgreSQL']);
    assert.deepEqual(store.retrieve('A', 'PostgreSQL', 40 * day), []);
    assert.deepEqual(store.candidates('A', 'PostgreSQL'), []);
  } finally { store.close(); }
});

test('aggiorna MySQL a PostgreSQL dopo la risposta, senza contaminare altre sandbox', async () => {
  const ns = 'explicit/db-alpha';
  assert.equal((await post('Il database del progetto è MySQL.', 'db-alpha')).status, 200);
  const first = await waitFor(() => rows("SELECT id, content FROM memory_nodes WHERE namespace = ? AND status = 'active'", ns)[0]);
  assert.match(String(first.content), /MySQL/);
  await (await post('Abbiamo cambiato database da MySQL a PostgreSQL.', 'db-alpha')).json();
  const latest = await waitFor(() => rows("SELECT id, content FROM memory_nodes WHERE namespace = ? AND status = 'active' AND content LIKE '%PostgreSQL%'", ns)[0]);
  const [old] = rows('SELECT status, superseded_by_id FROM memory_nodes WHERE id = ?', Number(first.id));
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by_id, latest.id);

  async function prompt(namespace: string) {
    const response = await post('Qual è il database del progetto?', namespace);
    assert.equal(response.status, 200);
    await response.json();
    return JSON.stringify(requests.at(-1)?.body);
  }
  assert.match(await prompt('db-alpha'), /PostgreSQL/);
  assert.doesNotMatch(await prompt('db-beta'), /PostgreSQL|MySQL/);
  assert.doesNotMatch(await prompt('coding'), /PostgreSQL|MySQL/);
  await (await post('Traduci: Il database del progetto è SQLite.', 'db-alpha')).json();
  await (await post('Usiamo SQLite come database.', 'queue-marker')).json();
  await waitFor(() => rows("SELECT id FROM memory_nodes WHERE namespace = 'explicit/queue-marker'")[0]);
  assert.deepEqual(rows("SELECT id FROM memory_nodes WHERE namespace = ? AND status = 'active'", ns).map(row => row.id), [latest.id]);
});

test('estrae con il modello locale, salda i link e conserva il namespace automatico', async () => {
  await (await post('La tinta del pannello è verde. Il progetto usa software.', '')).json();
  const first = await waitFor(() => rows("SELECT id FROM memory_nodes WHERE namespace = 'auto/coding' AND content LIKE '%verde%'")[0]);
  await (await post('La tinta del pannello è blu. Aggiorno il software.', '')).json();
  const last = await waitFor(() => rows("SELECT id FROM memory_nodes WHERE namespace = 'auto/coding' AND status = 'active' AND content LIKE '%blu%'")[0]);
  const old = rows('SELECT status, superseded_by_id FROM memory_nodes WHERE id = ?', Number(first.id))[0];
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by_id, last.id);
  const response = await post('Qual è la tinta del pannello del software?', '');
  await response.json();
  assert.match(JSON.stringify(requests.at(-1)?.body), /blu/);
  await (await post('Qual è la tinta del pannello? Parlo con il cliente.', '')).json();
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.body), /blu|verde/);
});

test('non reidrata token ricevuti in una richiesta precedente senza il valore originale', () => {
  const vaults = new Vaults();
  const first = vaults.open('scope');
  const token = first.redact('EMAIL', 'nobody@example.test');
  assert.equal(first.restore(token), 'nobody@example.test');
  const later = vaults.open('scope');
  assert.equal(later.restore(token), token);
  assert.equal(later.redact('EMAIL', 'nobody@example.test'), token);
  assert.notEqual(vaults.open('different').redact('EMAIL', 'nobody@example.test'), token);
  assert.equal(regexScrub('Host 192.0.2.3. IPv6 2001:db8::12. Percorso /home/utente/config.'), 'Host [IP]. IPv6 [IP]. Percorso [PATH]');
});
