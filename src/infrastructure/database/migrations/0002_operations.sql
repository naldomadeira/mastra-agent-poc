-- Tabelas operacionais: NÃO expostas à role de leitura do agente.

CREATE TABLE operators (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  role  text NOT NULL CHECK (role IN ('viewer','support','manager'))
);

CREATE TABLE notifications (
  id               serial      PRIMARY KEY,
  customer_id      integer     NOT NULL REFERENCES customers(id),
  order_id         integer     REFERENCES orders(id),
  channel          text        NOT NULL DEFAULT 'email',
  subject          text        NOT NULL,
  body             text        NOT NULL,
  sent_by          text        NOT NULL,
  sent_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_customer_sent_idx ON notifications(customer_id, sent_at);

-- Trilha de auditoria de capabilities (leituras e ações), independente do canal.
CREATE TABLE audit_log (
  id                 bigserial   PRIMARY KEY,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           text        NOT NULL,
  actor_role         text        NOT NULL,
  channel            text        NOT NULL CHECK (channel IN ('agent','http','mcp','workflow','system')),
  agent_id           text,
  thread_id          text,
  run_id             text,
  tool_call_id       text,
  capability         text        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('read','action')),
  input              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  outcome            text        NOT NULL CHECK (outcome IN ('success','rejected','denied','error')),
  result             jsonb,
  error              text,
  approval_required  boolean     NOT NULL DEFAULT false,
  approved_by        text,
  approved_at        timestamptz
);
CREATE INDEX audit_log_occurred_idx ON audit_log(occurred_at DESC);
