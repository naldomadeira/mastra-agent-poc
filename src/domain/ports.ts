import type { ApprovalDecision, StoredApproval } from './approvals/approval';
import type { AuditEntry } from './audit/audit-entry';
import type { Customer } from './customers/customer';
import type { NewNotification, SentNotification } from './notifications/notification';
import type { Actor } from './operators/operator';
import type { Order, OrderStatus } from './orders/order';
import type { Payment } from './payments/payment';

// Portas do domínio. Implementações Postgres em src/infrastructure/repositories;
// testes de unidade usam implementações em memória.

export interface OrderRepository {
  findById(id: number): Promise<Order | null>;
  list(filter: { status?: OrderStatus; customerId?: number; limit: number }): Promise<Order[]>;
  /** Candidatos a atraso (pagos e com prazo vencido); a regra final é `isLate` no domínio. */
  listLate(now: Date, limit: number): Promise<Order[]>;
  markCancelled(id: number, reason: string, at: Date): Promise<void>;
  markRefunded(id: number): Promise<void>;
}

export interface PaymentRepository {
  findByOrderId(orderId: number): Promise<Payment | null>;
  markVoided(id: number): Promise<void>;
  markRefunded(id: number, reason: string, at: Date): Promise<void>;
}

export interface CustomerRepository {
  findById(id: number): Promise<Customer | null>;
}

export interface NotificationRepository {
  countSentSince(customerId: number, since: Date): Promise<number>;
  /** Pedidos (dentre os informados) que já tiveram notificação enviada desde `since`. */
  ordersNotifiedSince(orderIds: number[], since: Date): Promise<number[]>;
  create(notification: NewNotification, at: Date): Promise<SentNotification>;
}

export interface OperatorRepository {
  findById(id: string): Promise<Actor | null>;
  list(): Promise<Actor[]>;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
}

export interface ApprovalRepository {
  /** Registra a decisão; a primeira decisão para um toolCallId prevalece. */
  record(decision: ApprovalDecision, at: Date): Promise<void>;
  findByToolCallId(toolCallId: string): Promise<StoredApproval | null>;
  /** Marca como usada; retorna false se já estava consumida. */
  markConsumed(toolCallId: string, at: Date): Promise<boolean>;
}

export type Repositories = {
  orders: OrderRepository;
  payments: PaymentRepository;
  customers: CustomerRepository;
  notifications: NotificationRepository;
  operators: OperatorRepository;
  audit: AuditRepository;
  approvals: ApprovalRepository;
};

/** Acesso aos repositórios, com ou sem transação. */
export interface UnitOfWork {
  readonly repos: Repositories;
  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** Dependências de todo caso de uso: persistência e relógio (injetável para testes). */
export type Deps = { uow: UnitOfWork; now: () => Date };
