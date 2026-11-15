import { parentPort, workerData } from 'node:worker_threads';
import { extractFacts } from './facts.ts';
import { MemoryStore } from './memory_store.ts';
import type { Command, MemoryConfig, Reply } from './memory_engine.ts';

const port = parentPort!;
const serialized = workerData as Omit<MemoryConfig, 'ollama'> & { ollama: string };
const config = { ...serialized, ollama: new URL(serialized.ollama) };
const store = new MemoryStore(config);
store.archive();

const jobs: Extract<Command, { kind: 'learn' }>[] = [];
let processing = false;
let closing = false;
const archiveTimer = setInterval(() => {
  try { store.archive(); } catch { console.warn('Archiviazione dei ricordi rinviata.'); }
}, 60_000);
archiveTimer.unref();

function send(reply: Reply): void { port.postMessage(reply); }

async function processJobs(): Promise<void> {
  if (processing) return;
  processing = true;
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    try {
      const { namespace, text, observed } = job.exchange;
      const candidates = store.candidates(namespace, text);
      const facts = await extractFacts(config, text, candidates);
      if (facts.length) store.save(namespace, facts, observed);
    } catch {
      console.warn('Aggiornamento della memoria non riuscito.');
    } finally {
      send({ kind: 'learned', id: job.id });
    }
  }
  processing = false;
  if (closing) {
    clearInterval(archiveTimer);
    store.close();
    send({ kind: 'stopped' });
    port.close();
  }
}

port.on('message', (command: Command) => {
  if (command.kind === 'stop') { closing = true; void processJobs(); return; }
  if (closing) return;
  if (command.kind === 'learn') { jobs.push(command); void processJobs(); return; }
  let facts: string[] = [];
  try { facts = store.retrieve(command.namespace, command.text); } catch { console.warn('Ricerca dei ricordi non riuscita.'); }
  send({ kind: 'result', id: command.id, facts });
});
send({ kind: 'ready' });
