import type { AuditRecord, EvalCase, Fixture, ModelTurn, Step, ToolCallRecord } from '../schema';

/** Observação crua de uma execução de caso, antes da avaliação. */
export type AgentRun = {
  responses: string[];
  toolCalls: ToolCallRecord[];
  approvalRequested: boolean;
  approvalDecisions: Array<'approved' | 'rejected' | 'pending'>;
};

export type StepOutcome = { op: string; outcome: string; ok: boolean; detail?: string };

/** Estado observável do banco: hash por linha, para diff sem depender do ORM de cada POC. */
export type DbSnapshot = Record<string, Map<number, string>>;

/**
 * Contrato que cada POC implementa para rodar os casos portáveis.
 * A POC AI SDK implementa esta mesma interface; runner, grader e casos são reaproveitados.
 */
export interface EvalTarget {
  readonly name: string;
  /** Recria o dataset determinístico (mesmo seed nas duas POCs). */
  reset(): Promise<void>;
  applyFixture(fixture: Fixture): Promise<void>;
  snapshot(tables: string[]): Promise<DbSnapshot>;
  rowValue(table: string, id: number, column: string): Promise<unknown>;
  count(table: string): Promise<number>;
  auditSince(marker: number): Promise<AuditRecord[]>;
  auditMarker(): Promise<number>;
  /** Conversa com o agente. `script` presente = modo adversarial (modelo roteirizado). */
  runAgent(c: EvalCase, script?: ModelTurn[]): Promise<AgentRun>;
  runStep(step: Step, c: EvalCase, state: Map<string, unknown>): Promise<StepOutcome>;
  modelName(mode: 'live' | 'adversarial'): string | null;
  close(): Promise<void>;
}
