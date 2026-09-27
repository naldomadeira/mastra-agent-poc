import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Testes de integração usam o banco commerce_test (nunca o de desenvolvimento).
const env = existsSync('.env') ? (parseEnv(readFileSync('.env', 'utf8')) as Record<string, string>) : {};

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false, // arquivos de integração compartilham o mesmo banco
    testTimeout: 20_000,
    env: {
      ...env,
      DATABASE_URL: env.TEST_DATABASE_URL,
      READONLY_DATABASE_URL: env.TEST_READONLY_DATABASE_URL,
      // Testes nunca chamam um LLM real.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      MASTRA_MODEL: 'anthropic/claude-haiku-4-5-20251001',
    },
  },
});
