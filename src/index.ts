import { readConfig } from './config.ts';
import { createProxy } from './proxy.ts';

async function main(): Promise<void> {
  const config = readConfig();
  const app = createProxy(config);
  try {
    const port = await app.start();
    console.log('Mnemosyne Proxy in ascolto su http://127.0.0.1:' + port + '/v1');
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void app.close();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch(() => {
  console.error('Avvio non riuscito. Verificare configurazione, accesso a SQLite e disponibilità della porta.');
  process.exitCode = 1;
});
