/**
 * Guard léxico para SQL gerado pelo modelo. É a PRIMEIRA barreira (rejeita cedo, com mensagem
 * útil para o modelo se corrigir) — não a única: a role `agent_readonly` e a transação READ ONLY
 * garantem a leitura mesmo que algo escape daqui. Ver ADR 002.
 */

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

export const MAX_SQL_LENGTH = 5_000;

const FORBIDDEN_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'drop', 'alter', 'truncate', 'create', 'grant', 'revoke',
  'copy', 'call', 'do', 'execute', 'prepare', 'deallocate', 'set', 'reset', 'lock', 'vacuum', 'analyze',
  'cluster', 'reindex', 'comment', 'security', 'listen', 'notify', 'unlisten', 'load', 'discard',
  'checkpoint', 'refresh', 'import', 'into', 'share', 'declare', 'fetch', 'close', 'begin', 'commit',
  'rollback', 'savepoint', 'release', 'transaction',
]); // prettier-ignore

/** Funções com efeito colateral, acesso a arquivo/rede ou vazamento de configuração. */
const FORBIDDEN_FUNCTION = /^(pg_\w+|lo_\w+|dblink\w*|set_config|current_setting|query_to_xml\w*|txid_\w+|version)$/;

type Token = { kind: 'word' | 'quoted' | 'symbol'; value: string };

export function guardReadOnlySql(input: string): GuardResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'SQL vazio.' };
  if (raw.length > MAX_SQL_LENGTH) return { ok: false, reason: `SQL maior que ${MAX_SQL_LENGTH} caracteres.` };

  let tokens: Token[];
  try {
    tokens = tokenize(raw);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  // Apenas um statement: aceita no máximo um ';' final.
  const semicolons = tokens.flatMap((t, i) => (t.kind === 'symbol' && t.value === ';' ? [i] : []));
  if (semicolons.length > 1 || (semicolons.length === 1 && semicolons[0] !== tokens.length - 1)) {
    return { ok: false, reason: 'Apenas um statement por consulta.' };
  }
  const body = semicolons.length ? tokens.slice(0, -1) : tokens;

  const first = body.find((t) => !(t.kind === 'symbol' && t.value === '('));
  if (first?.kind !== 'word' || !['select', 'with'].includes(first.value)) {
    return { ok: false, reason: 'Somente consultas SELECT (ou WITH ... SELECT) são permitidas.' };
  }

  for (const [i, t] of body.entries()) {
    if (t.kind !== 'word') continue;
    if (FORBIDDEN_KEYWORDS.has(t.value)) {
      return { ok: false, reason: `Palavra-chave não permitida em consulta de leitura: ${t.value.toUpperCase()}.` };
    }
    if (t.value === 'information_schema' || t.value === 'pg_catalog') {
      return { ok: false, reason: 'Catálogos do sistema não são acessíveis; use a tool inspectSchema.' };
    }
    const next = body[i + 1];
    const isCall = next?.kind === 'symbol' && next.value === '(';
    if (FORBIDDEN_FUNCTION.test(t.value) && (isCall || t.value.startsWith('pg_'))) {
      return { ok: false, reason: `Função/objeto de sistema não permitido: ${t.value}.` };
    }
  }

  const end = semicolons.length ? raw.lastIndexOf(';') : raw.length;
  return { ok: true, sql: raw.slice(0, end).trim() };
}

/**
 * Tokenizador mínimo de SQL Postgres: separa palavras, identificadores entre aspas e símbolos,
 * descartando comentários e literais de string (inclusive dollar-quoted), para que palavras
 * dentro de strings/comentários não gerem falso positivo e não escondam comandos.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const pair = sql.slice(i, i + 2);
        if (pair === '/*') depth++;
        else if (pair === '*/') depth--;
        i += pair === '/*' || pair === '*/' ? 2 : 1;
      }
      if (depth > 0) throw new Error('Comentário /* não fechado.');
    } else if (c === "'" || ((c === 'e' || c === 'E') && next === "'")) {
      const escapes = c !== "'";
      i += escapes ? 2 : 1;
      for (;;) {
        if (i >= n) throw new Error('String literal não fechada.');
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      tokens.push({ kind: 'quoted', value: "'…'" });
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) throw new Error('Identificador entre aspas não fechado.');
      tokens.push({ kind: 'quoted', value: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const tag = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(sql.slice(i))?.[0];
      if (!tag) {
        tokens.push({ kind: 'symbol', value: c });
        i++;
        continue;
      }
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error('String dollar-quoted não fechada.');
      tokens.push({ kind: 'quoted', value: "'…'" });
      i = end + tag.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))![0];
      tokens.push({ kind: 'word', value: word.toLowerCase() });
      i += word.length;
    } else {
      tokens.push({ kind: 'symbol', value: c });
      i++;
    }
  }
  return tokens;
}
