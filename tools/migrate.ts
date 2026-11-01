// tools/migrate.ts
import fs from 'fs';
import path from 'path';
import { DatabaseClient } from '../src/shared/database/connection.js';

async function runMigrations() {
  const migrationsDir = path.resolve(process.cwd(), 'db/migrations');
  console.log(`Scanning migrations in: ${migrationsDir}`);

  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} migration file(s) to execute.`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`Running migration: ${file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');

    await DatabaseClient.withPlatformTransaction(async (client) => {
      await client.query(sql);
    });

    console.log(`Migration ${file} executed successfully.`);
  }

  await DatabaseClient.close();
  console.log('All migrations applied successfully.');
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

