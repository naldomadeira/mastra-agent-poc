import type { AuditEntry } from '../../domain/audit/audit-entry';
import type { Actor } from '../../domain/operators/operator';
import type {
  ApprovalRepository,
  AuditRepository,
  CustomerRepository,
  NotificationRepository,
  OperatorRepository,
} from '../../domain/ports';
import type { Queryable } from '../database/pool';

export function pgCustomerRepository(db: Queryable): CustomerRepository {
  return {
    async findById(id) {
      const { rows } = await db.query(
        `SELECT id, name, email, city, notifications_opt_out AS "notificationsOptOut" FROM customers WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    },
  };
}

export function pgNotificationRepository(db: Queryable): NotificationRepository {
  return {
    async countSentSince(customerId, since) {
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM notifications WHERE customer_id = $1 AND sent_at >= $2',
        [customerId, since],
      );
      return rows[0].n;
    },
    async ordersNotifiedSince(orderIds, since) {
      const { rows } = await db.query<{ order_id: number }>(
        'SELECT DISTINCT order_id FROM notifications WHERE order_id = ANY($1) AND sent_at >= $2',
        [orderIds, since],
      );
      return rows.map((r) => r.order_id);
    },
    async create(n, at) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO notifications(customer_id, order_id, subject, body, sent_by, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [n.customerId, n.orderId, n.subject, n.body, n.sentBy, at],
      );
      return { ...n, id: rows[0].id, channel: 'email', sentAt: at };
    },
  };
}

export function pgOperatorRepository(db: Queryable): OperatorRepository {
  return {
    async findById(id) {
      const { rows } = await db.query<Actor>('SELECT id, name, role FROM operators WHERE id = $1', [id]);
      return rows[0] ?? null;
    },
    async list() {
      const { rows } = await db.query<Actor>('SELECT id, name, role FROM operators ORDER BY id');
      return rows;
    },
  };
}

export function pgAuditRepository(db: Queryable): AuditRepository {
  return {
    async record(e: AuditEntry) {
      await db.query(
        `INSERT INTO audit_log(actor_id, actor_role, channel, agent_id, thread_id, run_id, tool_call_id,
                               capability, kind, input, outcome, result, error,
                               approval_required, approved_by, approved_at,
                               requested_by, approval_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          e.actorId,
          e.actorRole,
          e.channel,
          e.agentId ?? null,
          e.threadId ?? null,
          e.runId ?? null,
          e.toolCallId ?? null,
          e.capability,
          e.kind,
          JSON.stringify(e.input ?? {}),
          e.outcome,
          e.result === undefined ? null : JSON.stringify(e.result),
          e.error ?? null,
          e.approvalRequired ?? false,
          e.approvedBy ?? null,
          e.approvedAt ?? null,
          e.requestedBy ?? null,
          e.approvalId ?? null,
          e.correlationId ?? null,
        ],
      );
    },
  };
}

export function pgApprovalRepository(db: Queryable): ApprovalRepository {
  return {
    async record(d, at) {
      const res = await db.query(
        `INSERT INTO action_approvals(tool_call_id, run_id, thread_id, capability, input, approved, approver_id, reason, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tool_call_id) DO NOTHING`,
        [
          d.toolCallId,
          d.runId,
          d.threadId ?? null,
          d.capability,
          JSON.stringify(d.input ?? {}),
          d.approved,
          d.approverId,
          d.reason ?? null,
          at,
        ],
      );
      return res.rowCount === 1;
    },
    async findByToolCallId(toolCallId) {
      const { rows } = await db.query(
        `SELECT tool_call_id AS "toolCallId", run_id AS "runId", thread_id AS "threadId", capability, input, approved,
                approver_id AS "approverId", reason, decided_at AS "decidedAt", consumed_at AS "consumedAt"
         FROM action_approvals WHERE tool_call_id = $1`,
        [toolCallId],
      );
      return rows[0] ?? null;
    },
    async markConsumed(toolCallId, at) {
      const res = await db.query(
        'UPDATE action_approvals SET consumed_at = $2 WHERE tool_call_id = $1 AND consumed_at IS NULL',
        [toolCallId, at],
      );
      return res.rowCount === 1;
    },
  };
}
