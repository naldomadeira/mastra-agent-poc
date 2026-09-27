import type pg from 'pg';
import type { Repositories, UnitOfWork } from '../../domain/ports';
import { type Queryable, withTransaction } from '../database/pool';
import {
  pgApprovalRepository,
  pgAuditRepository,
  pgCustomerRepository,
  pgNotificationRepository,
  pgOperatorRepository,
} from './misc-repositories';
import { pgOrderRepository } from './order-repository';
import { pgPaymentRepository } from './payment-repository';

export function createRepositories(db: Queryable): Repositories {
  return {
    orders: pgOrderRepository(db),
    payments: pgPaymentRepository(db),
    customers: pgCustomerRepository(db),
    notifications: pgNotificationRepository(db),
    operators: pgOperatorRepository(db),
    audit: pgAuditRepository(db),
    approvals: pgApprovalRepository(db),
  };
}

export function createPgUnitOfWork(pool: pg.Pool): UnitOfWork {
  return {
    repos: createRepositories(pool),
    transaction: (fn) => withTransaction(pool, (client) => fn(createRepositories(client))),
  };
}
