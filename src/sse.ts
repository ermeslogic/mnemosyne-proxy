import { once } from 'node:events';
import { object } from './json.ts';
import type { ServerResponse } from 'node:http';
import type { RequestVault } from './firewall.ts';
import type { JsonObject } from './json.ts';

interface Event { data: string[]; envelope: string[]; error: boolean }
const maxEvent = 1024 * 1024;

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: Event = { data: [], envelope: [], error: false };
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === buffer.length - 1 && !done) break;
        const line = buffer.slice(start, index);
        if (character === '\r' && buffer[index + 1] === '\n') index++;
        start = index + 1;
        if (!line) {
          if (event.data.length || event.envelope.length) yield event;
          event = { data: [], envelope: [], error: false };
          size = 0;
          continue;
        }
        size += line.length;
        if (size > maxEvent) throw new Error('Evento SSE troppo grande');
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const data = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') event.data.push(data);
        else {
          if (field === 'event' && data === 'error') event.error = true;
          event.envelope.push(line);
        }
      }
      buffer = buffer.slice(start);
      if (size + buffer.length > maxEvent) throw new Error('Evento SSE troppo grande');
      if (!done) continue;
      if (buffer === 'data' || buffer.startsWith('data:')) event.data.push(buffer.slice(5).replace(/^ /, ''));
      if (event.data.length || event.envelope.length) yield event;
      break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type Channel = { scope: number; field: string; tool?: number; jsonString: boolean };
const textFields = ['content', 'refusal', 'reasoning', 'reasoning_content'];

function fieldTarget(delta: JsonObject, channel: Channel): JsonObject {
  if (channel.tool !== undefined) {
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : (delta.tool_calls = []);
    let call = calls.map(object).find(entry => entry?.index === channel.tool);
    if (!call) { call = { index: channel.tool }; calls.push(call); }
    return object(call.function) ?? (call.function = {});
  }
  if (channel.field === 'arguments') return object(delta.function_call) ?? (delta.function_call = {});
  return delta;
}

class StreamVault {
  private readonly partials = new Map<string, { channel: Channel; rest: string }>();
  private readonly vault: RequestVault;
  private readonly jsonContent: boolean;

  constructor(vault: RequestVault, jsonContent: boolean) {
    this.vault = vault;
    this.jsonContent = jsonContent;
  }

  private transform(parent: JsonObject, channel: Channel): void {
    const text = parent[channel.field];
    if (typeof text !== 'string') return;
    const key = [channel.scope, channel.tool ?? '-', channel.field].join(':');
    const joined = (this.partials.get(key)?.rest ?? '') + text;
    const suffix = this.vault.suffixLength(joined);
    if (suffix) this.partials.set(key, { channel, rest: joined.slice(-suffix) });
    else this.partials.delete(key);
    parent[channel.field] = this.vault.restore(suffix ? joined.slice(0, -suffix) : joined, channel.jsonString);
  }

  patch(delta: JsonObject, scope: number): void {
    for (const field of textFields) {
      this.transform(delta, { scope, field, jsonString: field === 'content' && this.jsonContent });
    }
    const legacy = object(delta.function_call);
    if (legacy) this.transform(legacy, { scope, field: 'arguments', jsonString: true });
    if (!Array.isArray(delta.tool_calls)) return;
    for (const [position, entry] of delta.tool_calls.entries()) {
      const call = object(entry);
      const fn = object(call?.function);
      if (!fn) continue;
      if (typeof call!.index !== 'number') call!.index = position;
      this.transform(fn, { scope, tool: call!.index as number, field: 'arguments', jsonString: true });
    }
  }

  flush(scope: number, delta: JsonObject): void {
    for (const [key, { channel, rest }] of this.partials) {
      if (channel.scope !== scope) continue;
      const field = fieldTarget(delta, channel);
      field[channel.field] = (typeof field[channel.field] === 'string' ? field[channel.field] : '') + rest;
      this.partials.delete(key);
    }
  }

  flushAll(): JsonObject[] {
    const choices: JsonObject[] = [];
    for (const index of new Set([...this.partials.values()].map(entry => entry.channel.scope))) {
      const delta = {};
      this.flush(index, delta);
      choices.push({ index, delta, finish_reason: null });
    }
    return choices;
  }
}

export async function writeSse(res: ServerResponse, data: string, signal: AbortSignal, envelope: string[] = []): Promise<void> {
  signal.throwIfAborted();
  const lines = data ? data.split('\n').map(line => 'data: ' + line) : [];
  if (!res.write([...envelope, ...lines, '', ''].join('\n'))) await once(res, 'drain', { signal });
}

export async function forwardSse(
  body: ReadableStream<Uint8Array>, res: ServerResponse, vault: RequestVault, signal: AbortSignal, jsonContent: boolean,
): Promise<void> {
  const state = new StreamVault(vault, jsonContent);
  let metadata: JsonObject = {};
  let finished = false;
  async function flush(): Promise<void> {
    const choices = state.flushAll();
    if (choices.length) await writeSse(res, JSON.stringify({ ...metadata, choices }), signal);
  }
  for await (const event of readEvents(body)) {
    if (event.error) throw new Error('Errore nello stream del provider');
    if (event.data.length === 0) { await writeSse(res, '', signal, event.envelope); continue; }
    const data = event.data.join('\n');
    if (data.trim() === '[DONE]') {
      await flush();
      await writeSse(res, '[DONE]', signal, event.envelope);
      return;
    }
    const payload = object(JSON.parse(data));
    if (!payload || payload.error) throw new Error('Errore nello stream del provider');
    if (Array.isArray(payload.choices)) {
      const { choices, usage: _usage, ...rest } = payload;
      metadata = rest;
      for (const [position, item] of choices.entries()) {
        const choice = object(item);
        if (!choice) continue;
        const index = typeof choice.index === 'number' ? choice.index : position;
        const delta = object(choice.delta);
        if (delta) state.patch(delta, index);
        if (typeof choice.finish_reason === 'string') {
          finished = true;
          if (!delta) choice.delta = {};
          state.flush(index, object(choice.delta)!);
        }
      }
    }
    await writeSse(res, JSON.stringify(payload), signal, event.envelope);
  }
  if (!finished) throw new Error('Stream del provider interrotto');
  await flush();
  await writeSse(res, '[DONE]', signal);
}

export function restoreCompletion(payload: JsonObject, vault: RequestVault, jsonContent: boolean): JsonObject {
  function restore(parent: JsonObject | undefined, key: string, jsonString = false): void {
    if (parent && typeof parent[key] === 'string') parent[key] = vault.restore(parent[key], jsonString);
  }
  if (!Array.isArray(payload.choices)) return payload;
  for (const choice of payload.choices) {
    const message = object(object(choice)?.message);
    if (!message) continue;
    for (const key of textFields) restore(message, key, key === 'content' && jsonContent);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        restore(object(part), 'text', jsonContent);
        restore(object(part), 'refusal');
      }
    }
    restore(object(message.function_call), 'arguments', true);
    if (Array.isArray(message.tool_calls)) {
      for (const tool of message.tool_calls) restore(object(object(tool)?.function), 'arguments', true);
    }
  }
  return payload;
}
