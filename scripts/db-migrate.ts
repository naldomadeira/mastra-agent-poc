import './load-env';
import { migrate } from '../src/infrastructure/database/migrator';

const target = process.argv.includes('--test') ? 'test' : 'dev';
const url = target === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
const readonlyUrl = target === 'test' ? process.env.TEST_READONLY_DATABASE_URL : process.env.READONLY_DATABASE_URL;
if (!url || !readonlyUrl) throw new Error(`URLs de banco ausentes para o alvo "${target}" (veja .env.example)`);

const { applied, skipped } = await migrate(url, readonlyUrl);
console.log(`[db:migrate:${target}] aplicadas: ${applied.join(', ') || 'nenhuma'} | já aplicadas: ${skipped.length}`);
