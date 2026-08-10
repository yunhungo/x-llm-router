import { getConfig } from './config';
import { bootstrapInitialAdmin } from './db/bootstrap';
import { closePool } from './db/client';
import { runMigrations } from './db/migrate';
import { initializeLangfuse, shutdownLangfuse } from './services/langfuse';

async function main(): Promise<void> {
  const config = getConfig();
  await runMigrations();
  const createdAdmin = await bootstrapInitialAdmin();
  const langfuseProjectCount = await initializeLangfuse();
  const { buildApp } = await import('./app');
  const app = await buildApp();

  if (createdAdmin) {
    app.log.warn(
      { username: config.INITIAL_ADMIN_USERNAME },
      'Initial administrator created. Change the default password immediately.',
    );
  }
  app.log.info({ langfuseProjectCount }, 'Observability initialized');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await shutdownLangfuse();
    await closePool();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: '0.0.0.0', port: config.API_PORT });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
