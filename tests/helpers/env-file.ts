import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Lê .env sem mutar process.env (o Vitest injeta os valores via `test.env`). */
export function readEnvFile(file = '.env'): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}
