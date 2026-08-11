import { getPool } from './client';

interface WaitForDatabaseOptions {
  attempts?: number;
  intervalMs?: number;
  check?: () => Promise<unknown>;
  delay?: (milliseconds: number) => Promise<void>;
}

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export async function waitForDatabase({
  attempts = 120,
  intervalMs = 1_000,
  check = async () => getPool().query('SELECT 1'),
  delay = sleep,
}: WaitForDatabaseOptions = {}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(intervalMs);
    }
  }
  throw new Error(`Database did not become ready after ${attempts} attempts.`, {
    cause: lastError,
  });
}
