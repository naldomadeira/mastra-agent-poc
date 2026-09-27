// Scripts CLI carregam .env (Next e `mastra dev` já fazem isso sozinhos).
try {
  process.loadEnvFile('.env');
} catch {
  // Sem .env: segue com o ambiente do processo.
}
