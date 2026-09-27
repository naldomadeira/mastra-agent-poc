import { DomainError } from '../shared/errors';

export type OperatorRole = 'viewer' | 'support' | 'manager';

/** Quem está agindo. Sempre resolvido pelo servidor (sessão), nunca informado pelo modelo. */
export type Actor = { id: string; name: string; role: OperatorRole };

export type Permission =
  | 'data:read'
  | 'orders:cancel'
  | 'notifications:send'
  | 'payments:refund:request'
  | 'payments:refund:approve'
  | 'audit:read';

const PERMISSIONS: Record<OperatorRole, readonly Permission[]> = {
  viewer: ['data:read'],
  support: ['data:read', 'orders:cancel', 'notifications:send', 'payments:refund:request'],
  manager: [
    'data:read',
    'orders:cancel',
    'notifications:send',
    'payments:refund:request',
    'payments:refund:approve',
    'audit:read',
  ],
};

export const can = (actor: Actor, permission: Permission): boolean => PERMISSIONS[actor.role].includes(permission);

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new DomainError('FORBIDDEN', `${actor.name} (${actor.role}) não tem a permissão ${permission}.`);
  }
}

export const permissionsOf = (role: OperatorRole): readonly Permission[] => PERMISSIONS[role];
