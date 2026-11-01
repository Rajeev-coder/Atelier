// src/shared/database/connection.ts
import pg from 'pg';
import { TenantId } from '../types/index.js';

const { Pool } = pg;

export class DatabaseClient {
  private static pool: pg.Pool;

  public static initialize(connectionString?: string): pg.Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: connectionString || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/salon_platform',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      this.pool.on('error', (err) => {
        console.error('Unexpected error on idle PostgreSQL client', err);
      });
    }
    return this.pool;
  }

  public static getPool(): pg.Pool {
    if (!this.pool) {
      return this.initialize();
    }
    return this.pool;
  }

  public static async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Executes a transaction strictly bound to a tenant context with PostgreSQL RLS.
   */
  public static async withTenantTransaction<T>(
    tenantId: TenantId,
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN;');
      // Invariant: Row-Level Security requires app.tenant_id set within transaction scope
      await client.query('SET LOCAL app.tenant_id = $1;', [tenantId]);
      await client.query("SET LOCAL lock_timeout = '2s';");
      await client.query("SET LOCAL statement_timeout = '10s';");

      const result = await callback(client);

      await client.query('COMMIT;');
      return result;
    } catch (error) {
      await client.query('ROLLBACK;');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Executes a platform transaction without tenant isolation (e.g. provisioning a new tenant).
   */
  public static async withPlatformTransaction<T>(
    callback: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN;');
      await client.query("SET LOCAL lock_timeout = '2s';");
      await client.query("SET LOCAL statement_timeout = '10s';");

      const result = await callback(client);

      await client.query('COMMIT;');
      return result;
    } catch (error) {
      await client.query('ROLLBACK;');
      throw error;
    } finally {
      client.release();
    }
  }
}

