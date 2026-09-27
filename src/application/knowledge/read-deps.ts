import { getEnv } from '../../config/env';
import { getDeps } from '../../infrastructure/app-services';
import { getReadonlyPool } from '../../infrastructure/database/pool';
import type { ReadDeps } from './query-database';

export function getReadDeps(): ReadDeps {
  const env = getEnv();
  return {
    ...getDeps(),
    readonlyPool: getReadonlyPool(),
    limits: { timeoutMs: env.QUERY_TIMEOUT_MS, maxRows: env.QUERY_MAX_ROWS, timezone: env.APP_TIMEZONE },
  };
}
