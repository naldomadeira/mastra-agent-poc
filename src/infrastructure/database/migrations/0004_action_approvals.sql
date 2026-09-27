-- Evidência persistente de aprovação humana para ações sensíveis pedidas por canais automatizados.
-- Vinculada ao toolCallId e aos argumentos exatos exibidos ao aprovador; consumida uma única vez.

CREATE TABLE action_approvals (
  tool_call_id  text        PRIMARY KEY,
  run_id        text        NOT NULL,
  thread_id     text,
  capability    text        NOT NULL,
  input         jsonb       NOT NULL,
  approved      boolean     NOT NULL,
  approver_id   text        NOT NULL REFERENCES operators(id),
  reason        text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz
);
