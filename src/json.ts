export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject { [key: string]: Json | undefined }

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
