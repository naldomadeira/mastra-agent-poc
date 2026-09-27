import './load-env';
import pg from 'pg';
import { seed } from '../src/infrastructure/database/seed';

if (process.env.NODE_ENV === 'production') throw new Error('Seed apaga dados: proibido em produção.');

const target = process.argv.includes('--test') ? 'test' : 'dev';
const url = target === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) throw new Error(`URL de banco ausente para o alvo "${target}"`);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { orders } = await seed(client);
  console.log(`[db:seed:${target}] ${orders} pedidos criados`);
} finally {
  await client.end();
}
