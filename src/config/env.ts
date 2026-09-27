import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  READONLY_DATABASE_URL: z.url(),
  MASTRA_MODEL: z
    .string()
    .regex(/^[\w-]+\/[\w.-]+$/, 'formato esperado: provider/model')
    .default('anthropic/claude-sonnet-5'),
  QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  QUERY_MAX_ROWS: z.coerce.number().int().min(1).max(1_000).default(200),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Lê e valida o ambiente uma única vez. Falha cedo com mensagem legível. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração de ambiente inválida (veja .env.example): ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
