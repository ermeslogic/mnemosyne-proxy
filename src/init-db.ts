import { readConfig } from './config.ts';
import { MemoryStore } from './memory_store.ts';

try {
  const config = readConfig();
  new MemoryStore(config).close();
  console.log('SQLite inizializzato: ' + config.database);
} catch {
  console.error('Impossibile inizializzare SQLite. Verificare configurazione e permessi.');
  process.exitCode = 1;
}
