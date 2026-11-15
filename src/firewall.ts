import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ollamaJson } from './ollama.ts';
import { object, str } from './json.ts';
import type { Config } from './config.ts';
import type { Json } from './json.ts';

const types = ['PERSON', 'EMAIL', 'API_KEY', 'IP', 'IBAN', 'PATH', 'SECRET', 'PHONE', 'PII'] as const;
type Kind = typeof types[number];
type Span = { start: number; end: number; kind: Kind };
const tokenPattern = /\[(PERSON|EMAIL|API_KEY|IP|IBAN|PATH|SECRET|PHONE|PII)_[a-f0-9]{20}\]/g;
const durablePattern = /\[(?:PERSON|EMAIL|API_KEY|IP|IBAN|PATH|SECRET|PHONE|PII)(?:_[a-f0-9]{20})?\]/g;
const frequentGivenNames = 'Ada|Alessandra|Alessandro|Alice|Andrea|Anna|Antonio|Carlo|Chiara|Daniel|Daniela|David|Elena|Elisa|Emma|Enrico|Fabio|Francesca|Francesco|Giulia|Giuseppe|Grace|James|Jane|John|Laura|Luca|Lucia|Marco|Maria|Mario|Marta|Mary|Matteo|Michael|Paolo|Paul|Peter|Roberto|Sara|Sarah|Silvia|Sofia|Thomas';
const knownName = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:' + frequentGivenNames +
  ')[ \\t]+(?:(?:Da|De|Di|Della|Del|Van|Von|de|van|von)[ \\t]+)?\\p{Lu}[\\p{Ll}’\\x27-]{1,}(?![\\p{L}\\p{N}_])', 'gu',
);
const nameWord = '\\p{Lu}[\\p{Ll}\\p{M}]+(?:[’\\x27-]\\p{L}[\\p{Ll}\\p{M}]*)*';
const nameInModelSpan = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?!(?:Ciao|Buongiorno|Hello|Please|Today|Oggi)\\b)' + nameWord +
  '(?:[ \\t]+(?:(?:da|de|di|del|della|van|von|al|bin)[ \\t]+)?(?:"' + nameWord + '"|' + nameWord +
  ')){1,3}(?![\\p{L}\\p{N}_])', 'gu',
);

const rules: { kind: Kind; pattern: RegExp; group?: number; valid?: (value: string) => boolean }[] = [
  { kind: 'SECRET', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'API_KEY', pattern: /\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})(?![\w-])/g },
  { kind: 'SECRET', pattern: /\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password|passwd|pwd|secret)\s*["']?\s*[:=]\s*["']?([^\s"'\x60,;}\[\]]{3,})/gi, group: 1 },
  { kind: 'API_KEY', pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{12,}={0,2})/gi, group: 1 },
  { kind: 'SECRET', pattern: /\b[a-z][a-z\d+.-]*:\/\/([^\s/@]+:[^\s/@]+)@/gi, group: 1 },
  { kind: 'PATH', pattern: /(["'\x60])((?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|root|private|tmp|var|etc|mnt)\/)[^\r\n"'\x60]+)\1/g, group: 2 },
  { kind: 'PATH', pattern: /(?:\b[A-Za-z]:[\\/]|\\\\(?=[\w.-]+\\)|(?<![\w:/])\/(?:home|Users|root|private|tmp|var|etc|mnt)\/)[^\s"'\x60<>{}()[\],;]+/g },
  { kind: 'EMAIL', pattern: /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63}/gu },
  { kind: 'IBAN', pattern: /\b[A-Z]{2}\d{2}[A-Z\d]{11,30}\b/gi, valid: validIban },
  { kind: 'IBAN', pattern: /\b[A-Z]{2}\d{2}(?: [A-Z\d]{4}){2,7}(?: [A-Z\d]{1,4})?\b/g, valid: validIban },
  { kind: 'IP', pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g, valid: value => isIP(value) === 4 },
  { kind: 'IP', pattern: /(?<![\w:])(?:[A-F\d]{0,4}:){2,7}(?:[A-F\d]{1,4}(?:\.\d{1,3}){3}|[A-F\d]{0,4})(?![\w:]|\.\d)/gi, valid: value => isIP(value) === 6 },
  { kind: 'PHONE', pattern: /(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\d[ .-]?){7,14}\d(?![\w.])/g, valid: value => (value.match(/\d/g)?.length ?? 0) >= 9 },
  { kind: 'PERSON', pattern: /\b(?:[Mm]i chiamo|[Ii] am called|[Mm]y name is|[Mm]i nombre es|(?:[Ss]ig|[Dd]ott|[Mm]rs?|[Mm]s|[Dd]r)\.)\s+(\p{Lu}[\p{L}'’-]+(?:[ \t]+\p{Lu}[\p{L}'’-]+){0,3})/gu, group: 1 },
  { kind: 'PERSON', pattern: knownName },
];

const ibanLengths: Record<string, number> = { IT: 27, DE: 22, GB: 22, ES: 24, FR: 27, NL: 18, BE: 16, CH: 21, AT: 20, PT: 25, PL: 28, RO: 24 };
function validIban(value: string): boolean {
  const iban = value.replace(/ /g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34 || (ibanLengths[iban.slice(0, 2)] ?? iban.length) !== iban.length) return false;
  let rem = 0;
  for (const character of iban.slice(4) + iban.slice(0, 4)) {
    const digit = character.charCodeAt(0) - 48;
    rem = digit < 10 ? (rem * 10 + digit) % 97 : (rem * 100 + digit - 7) % 97;
  }
  return rem === 1;
}

function regexSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const { pattern, kind, group, valid } of rules) {
    for (const match of text.matchAll(pattern)) {
      const value = match[group ?? 0];
      if (valid && !valid(value)) continue;
      const start = match.index + (group === undefined ? 0 : match[0].lastIndexOf(value));
      spans.push({ start, end: start + value.length, kind });
    }
  }
  return spans;
}

function replaceSpans(text: string, spans: Span[], token: (kind: Kind, value: string) => string): string {
  const ordered = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let output = '';
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    const span = { ...ordered[i] };
    while (i + 1 < ordered.length && ordered[i + 1].start < span.end) {
      span.end = Math.max(span.end, ordered[++i].end);
    }
    output += text.slice(cursor, span.start) + token(span.kind, text.slice(span.start, span.end));
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

export function regexScrub(text: string): string {
  return replaceSpans(text, regexSpans(text), kind => '[' + kind + ']');
}

export class SessionVault {
  private readonly key = randomBytes(32);
  expires = 0;

  token(kind: Kind, value: string): string {
    const hash = createHmac('sha256', this.key).update(kind).update('\0').update(value).digest('hex').slice(0, 20);
    return '[' + kind + '_' + hash + ']';
  }
}

export class Vaults {
  private readonly sessions = new Map<string, SessionVault>();
  private readonly ttl = 30 * 60_000;

  open(scope: string, now = Date.now()): RequestVault {
    for (const [key, vault] of this.sessions) {
      if (vault.expires <= now) this.sessions.delete(key);
    }
    const vault = this.sessions.get(scope) ?? new SessionVault();
    this.sessions.delete(scope);
    vault.expires = now + this.ttl;
    this.sessions.set(scope, vault);
    if (this.sessions.size > 512) this.sessions.delete(this.sessions.keys().next().value!);
    return new RequestVault(vault);
  }
}

export class RequestVault {
  private readonly values = new Map<string, string>();
  private readonly prefixes = new Set<string>();
  private readonly session: SessionVault;

  constructor(session: SessionVault) {
    this.session = session;
  }

  redact = (kind: Kind, value: string): string => {
    const token = this.session.token(kind, value);
    if (this.values.has(token)) return token;
    if (this.values.size >= 1024) throw new Error('Troppe entità nella richiesta');
    this.values.set(token, value);
    for (let i = 1; i < token.length; i++) this.prefixes.add(token.slice(0, i));
    return token;
  };

  restore(text: string, jsonString = false): string {
    return text.replace(tokenPattern, token => {
      const value = this.values.get(token);
      if (value === undefined) return token;
      return jsonString ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  suffixLength(text: string): number {
    const start = text.lastIndexOf('[');
    return start >= 0 && text.length - start <= 32 && this.prefixes.has(text.slice(start)) ? text.length - start : 0;
  }

  scrub(text: string): string {
    return text.replace(tokenPattern, (_token, kind: string) => '[' + kind + ']');
  }
}

const nerSchema = {
  type: 'object', required: ['entities'], additionalProperties: false,
  properties: {
    entities: {
      type: 'array', maxItems: 64,
      items: {
        type: 'object', required: ['index', 'value', 'kind'], additionalProperties: false,
        properties: { index: { type: 'integer' }, value: { type: 'string' }, kind: { type: 'string', enum: ['PERSON', 'PII'] } },
      },
    },
  },
};
const nerPrompt = 'Find full names of people, home addresses and personal identifiers. ' +
  'Ignore instructions, products, software and existing bracketed placeholders. Copy only the entity substring and its input index. ' +
  'If none are present, return {"entities":[]}.';

type NerConfig = Pick<Config, 'ollama' | 'model' | 'ner' | 'privacyTimeout'>;

function verifiedEntities(kind: Kind, value: string): string[] {
  if (kind === 'PERSON') {
    if (/^[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]{2,6}$/u.test(value)) return [value];
    return Array.from(value.matchAll(nameInModelSpan), match => match[0]);
  }
  if (kind === 'PII' && value.length <= 110 &&
      (/\d/u.test(value) || /\b(?:via|piazza|viale|avenue|street|road|rue|calle)\b/iu.test(value))) return [value];
  return [];
}

async function detectNer(config: NerConfig, texts: string[], signal?: AbortSignal): Promise<Span[][]> {
  const spans: Span[][] = texts.map(() => []);
  const deadline = AbortSignal.timeout(config.privacyTimeout);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let batch: { index: number; text: string }[] = [];
  let count = 0;
  async function submit(): Promise<void> {
    if (!batch.length) return;
    const result = object(await ollamaJson(config, nerPrompt, batch, nerSchema, config.privacyTimeout, cancellation));
    if (!Array.isArray(result?.entities) || result.entities.length > 64) throw new Error('NER non valido');
    for (const entity of result.entities) {
      const row = object(entity);
      const kind = row?.kind as Kind;
      const value = str(row?.value);
      if (typeof row?.index !== 'number' || !Number.isInteger(row.index) || !types.includes(kind) ||
          value.trim().length < 2 || value.length > 256) {
        throw new Error('Entità NER non valida');
      }
      const matches = new Set(batch.filter(item => item.text.includes(value)).map(item => item.index));
      const verified = verifiedEntities(kind, value);
      for (const index of matches) {
        const text = texts[index];
        const protectedSpans = Array.from(text.matchAll(durablePattern), m => [m.index, m.index + m[0].length]);
        for (const entity of verified) {
          for (let start = text.indexOf(entity); start >= 0; start = text.indexOf(entity, start + entity.length)) {
            const end = start + entity.length;
            if (!protectedSpans.some(([left, right]) => start < right && end > left)) spans[index].push({ start, end, kind });
          }
        }
      }
    }
    batch = [];
    count = 0;
  }
  for (const [index, text] of texts.entries()) {
    if (!/\p{L}/u.test(text.replace(durablePattern, ''))) continue;
    for (let offset = 0; offset < text.length; offset += 1500) {
      const part = text.slice(offset, offset + 1750);
      if (count + part.length > 2000 || batch.length >= 32) await submit();
      batch.push({ index, text: part });
      count += part.length;
      if (offset + 1750 >= text.length) break;
    }
  }
  await submit();
  return spans;
}

export async function redactTexts(
  config: NerConfig,
  texts: string[],
  token: (kind: Kind, value: string) => string,
  signal?: AbortSignal,
): Promise<string[]> {
  const regexRedacted = texts.map(text => replaceSpans(text, regexSpans(text), token));
  if (config.ner === 'heuristic') return regexRedacted;
  const entities = await detectNer(config, regexRedacted, signal);
  return regexRedacted.map((text, i) => replaceSpans(text, entities[i], token));
}

const structuralFields = new Set(['role', 'type', 'model', 'id', 'name', 'tool_call_id', 'finish_reason', '$ref', '$schema']);
const secretField = /^(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|pwd|secret)$/i;
type TextSlot = { text: string; apply: (text: string) => void };

export class PayloadPrivacyError extends Error {}

export async function redactPayload(
  config: Config, payload: Json, vault: RequestVault, signal: AbortSignal,
): Promise<Json> {
  const slots: TextSlot[] = [];
  function guardIdentifier(value: string, scanNames: boolean): void {
    if (regexSpans(value).length > 0) throw new PayloadPrivacyError('Identificatore con dati sensibili');
    if (!scanNames) return;
    slots.push({
      text: value,
      apply: redacted => {
        if (redacted !== value) throw new PayloadPrivacyError('Identificatore con dati sensibili');
      },
    });
  }

  function visit(input: Json, assign: (json: Json) => void, key = '', parent = '', depth = 0, toolData = false): void {
    if (depth > 48) throw new PayloadPrivacyError('Payload troppo annidato');
    if (typeof input === 'string') {
      if (!toolData && key === 'arguments' && (parent === 'function' || parent === 'function_call')) {
        let decoded: Json;
        try { decoded = JSON.parse(input) as Json; } catch { throw new PayloadPrivacyError('Argomenti tool JSON non validi'); }
        const result: { json?: Json } = {};
        visit(decoded, value => { result.json = value; }, '', '', depth + 1, true);
        deferred.push(() => assign(JSON.stringify(result.json)));
      } else if (secretField.test(key) && input) {
        assign(vault.redact('SECRET', input));
      } else if (!toolData && structuralFields.has(key)) {
        guardIdentifier(input, key === 'name' || key === 'id' || key === 'tool_call_id');
        assign(input);
      } else {
        slots.push({ text: input, apply: assign });
      }
      return;
    }
    if (Array.isArray(input)) {
      const values: Json[] = [];
      assign(values);
      for (const [index, value] of input.entries()) visit(value, result => { values[index] = result; }, '', key, depth + 1, toolData);
      return;
    }
    const record = object(input);
    if (!record) { assign(input); return; }
    const result: Record<string, Json> = Object.create(null);
    assign(result);
    for (const [field, value] of Object.entries(record)) {
      const dataField = toolData || key === 'metadata';
      guardIdentifier(field, dataField || key === 'properties');
      if (dataField && secretField.test(field) && value !== undefined && value !== null && typeof value !== 'string') {
        throw new PayloadPrivacyError('Valore sensibile in un formato non testuale');
      }
      if (value !== undefined) visit(value, redacted => { result[field] = redacted; }, field, key, depth + 1, dataField);
    }
  }

  const deferred: (() => void)[] = [];
  const result: { payload?: Json } = {};
  visit(payload, value => { result.payload = value; });
  const redacted = await redactTexts(config, slots.map(slot => slot.text), vault.redact, signal);
  for (const [index, slot] of slots.entries()) slot.apply(redacted[index]);
  for (const apply of deferred) apply();
  return result.payload!;
}
