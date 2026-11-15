import { appendPath } from './config.ts';
import { object, str } from './json.ts';
import type { Config } from './config.ts';
import type { Json } from './json.ts';

export async function ollamaJson(
  config: Pick<Config, 'ollama' | 'model'>,
  system: string,
  data: Json,
  schema: Json,
  timeout: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(appendPath(config.ollama, '/api/chat'), {
    method: 'POST',
    redirect: 'error',
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, num_predict: 2048 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(data) },
      ],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Inferenza locale non disponibile');
  }
  const raw = str(object(object(await response.json())?.message)?.content);
  if (!raw) throw new Error('Inferenza locale senza risultato');
  return JSON.parse(raw) as unknown;
}
