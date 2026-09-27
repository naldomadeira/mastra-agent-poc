import type { Deps } from '../domain/ports';
import { getAppPool } from './database/pool';
import { createPgUnitOfWork } from './repositories/unit-of-work';

/** Composition root: liga os casos de uso à infraestrutura real. */
export function getDeps(): Deps {
  return { uow: createPgUnitOfWork(getAppPool()), now: () => new Date() };
}
