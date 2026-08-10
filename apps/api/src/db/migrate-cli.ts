import { closePool } from './client';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  await runMigrations();
  console.log('Database migrations are up to date.');
  await closePool();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
