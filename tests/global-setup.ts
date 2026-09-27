import { readEnvFile } from './helpers/env-file';
import { migrate } from '../src/infrastructure/database/migrator';

export default async function setup() {
  const env = readEnvFile();
  if (!env.TEST_DATABASE_URL || !env.TEST_READONLY_DATABASE_URL) {
    throw new Error('Defina TEST_DATABASE_URL e TEST_READONLY_DATABASE_URL no .env');
  }
  await migrate(env.TEST_DATABASE_URL, env.TEST_READONLY_DATABASE_URL);
}
