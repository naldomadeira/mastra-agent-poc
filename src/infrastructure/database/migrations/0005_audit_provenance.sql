-- Proveniência explícita na trilha de auditoria: cada linha de execução diz quem solicitou,
-- qual aprovação a autorizou e a qual requisição pertence, sem depender de outra entrada.

ALTER TABLE audit_log
  ADD COLUMN requested_by    text,
  ADD COLUMN approval_id     text,
  ADD COLUMN correlation_id  text;

CREATE INDEX audit_log_approval_idx ON audit_log(approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX audit_log_run_idx ON audit_log(run_id) WHERE run_id IS NOT NULL;

COMMENT ON COLUMN audit_log.actor_id IS 'Principal em nome de quem a capability executou (permissões verificadas contra ele).';
COMMENT ON COLUMN audit_log.requested_by IS 'Operador que originou a solicitação (pode diferir do aprovador).';
COMMENT ON COLUMN audit_log.approval_id IS 'Chave da evidência em action_approvals que autorizou a execução.';
COMMENT ON COLUMN audit_log.correlation_id IS 'Id da requisição HTTP (x-request-id) que originou o evento.';
