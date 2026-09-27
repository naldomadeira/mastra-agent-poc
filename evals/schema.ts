import { z } from 'zod';

/**
 * Formato PORTÁVEL de casos e resultados de avaliação.
 *
 * Este arquivo e `cases.json` não dependem de Mastra: a POC equivalente em AI SDK implementa um
 * `EvalTarget` (targets/types.ts) e roda exatamente os mesmos casos, produzindo o mesmo
 * `EvalResult`. Nomes de capabilities, workflows e fixtures são semânticos.
 */

export const ModelTurn = z.union([z.object({ tool: z.string(), input: z.unknown() }), z.object({ text: z.string() })]);
export type ModelTurn = z.infer<typeof ModelTurn>;

/** Operações de cenário (sem LLM), executadas pelo adaptador de cada POC. */
export const Step = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('recordApproval'),
    toolCallId: z.string(),
    capability: z.string(),
    input: z.unknown(),
    approver: z.string(),
    approved: z.boolean().default(true),
  }),
  z.object({
    op: z.literal('invoke'),
    capability: z.string(),
    input: z.unknown(),
    actor: z.string().optional(),
    channel: z.enum(['agent', 'http', 'mcp', 'workflow']).default('agent'),
    toolCallId: z.string().optional(),
    /** "ok" ou "error:<CODE>" (ex.: "error:APPROVAL_REQUIRED") */
    expect: z.string(),
  }),
  z.object({ op: z.literal('readonlySql'), sql: z.string(), expect: z.literal('rejected') }),
  z.object({
    op: z.literal('startWorkflow'),
    workflow: z.string(),
    ref: z.string(),
    actor: z.string().optional(),
    expectStatus: z.string().optional(),
  }),
  z.object({
    op: z.literal('resumeWorkflow'),
    ref: z.string(),
    approved: z.boolean(),
    approver: z.string(),
    expectStatus: z.string().optional(),
  }),
  z.object({
    op: z.literal('checkpoint'),
    label: z.string(),
    counts: z.record(z.string(), z.number()).optional(),
    unchanged: z.array(z.string()).optional(),
  }),
]);
export type Step = z.infer<typeof Step>;

const AuditMatch = z.object({ capability: z.string(), outcome: z.string(), count: z.number().optional() });

export const Expectations = z.object({
  /** behavior */
  tools: z
    .object({
      mustCall: z.array(z.string()).optional(),
      mustNotCall: z.array(z.string()).optional(),
      /** subsequência obrigatória na ordem das chamadas */
      order: z.array(z.string()).optional(),
    })
    .optional(),
  /** behavior — regex (flag i). mustMatch vale para a última resposta; mustNotMatch para todas. */
  response: z
    .object({ mustMatch: z.array(z.string()).optional(), mustNotMatch: z.array(z.string()).optional() })
    .optional(),
  /** safety */
  db: z
    .object({
      unchanged: z.array(z.string()).optional(),
      counts: z.record(z.string(), z.number()).optional(),
      rowValues: z
        .array(z.object({ table: z.string(), id: z.number(), column: z.string(), equals: z.unknown() }))
        .optional(),
    })
    .optional(),
  /** safety */
  audit: z
    .object({
      mustInclude: z.array(AuditMatch).optional(),
      /** só exigido se a capability tiver sido chamada pelo modelo */
      mustIncludeIfCalled: z.array(AuditMatch).optional(),
      mustNotInclude: z.array(AuditMatch).optional(),
    })
    .optional(),
  /** safety */
  approval: z.object({ requiredIfCalled: z.array(z.string()).optional() }).optional(),
});
export type Expectations = z.infer<typeof Expectations>;

export const EvalCase = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(['agent', 'scenario']),
  modes: z.array(z.enum(['live', 'adversarial'])),
  actor: z.string(),
  fixtures: z.array(z.string()).default([]),
  /** agent: mensagens do usuário, em ordem, na mesma conversa */
  turns: z.array(z.string()).default([]),
  /** como o "humano" responde a pedidos de aprovação */
  approvalPolicy: z.enum(['approve', 'reject', 'none']).default('none'),
  approver: z.string().optional(),
  /** adversarial: roteiro do modelo que se comporta mal (sequencial em todo o caso) */
  adversarialScript: z.array(ModelTurn).optional(),
  steps: z.array(Step).default([]),
  expect: Expectations,
});
export type EvalCase = z.infer<typeof EvalCase>;

export const Fixture = z.object({ name: z.string(), description: z.string(), sql: z.array(z.string()) });
export type Fixture = z.infer<typeof Fixture>;

export const CaseFile = z.object({
  version: z.string(),
  description: z.string(),
  /** Padrões reutilizáveis referenciados como "$nome" em response.mustNotMatch */
  patterns: z.record(z.string(), z.string()),
  fixtures: z.array(Fixture),
  cases: z.array(EvalCase),
});
export type CaseFile = z.infer<typeof CaseFile>;

// ── Observação produzida pelo adaptador + resultado normalizado ──────────────

export type ToolCallRecord = {
  name: string;
  input: unknown;
  /** executed | approval-requested | approved | declined | error */
  status: string;
  output?: unknown;
};

export type DbChange = { table: string; added: number[]; removed: number[]; changed: number[] };

export type AuditRecord = {
  capability: string;
  kind: string;
  outcome: string;
  actorId: string;
  channel: string;
  approvedBy: string | null;
  error: string | null;
};

export type CheckResult = {
  name: string;
  kind: 'safety' | 'behavior';
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
};

export type EvalResult = {
  caseId: string;
  category: string;
  target: string;
  mode: 'live' | 'adversarial';
  model: string | null;
  input: string[] | Step[];
  expected: Expectations;
  actual: { responses: string[]; steps: Array<{ op: string; outcome: string }> };
  passed: boolean;
  safetyPassed: boolean;
  behaviorPassed: boolean | null;
  checks: CheckResult[];
  toolCalls: ToolCallRecord[];
  databaseChanges: DbChange[];
  approvalRequired: boolean;
  approvalResult: 'none' | 'approved' | 'rejected' | 'pending' | 'mixed';
  auditEntries: AuditRecord[];
  error: string | null;
  durationMs: number;
};
