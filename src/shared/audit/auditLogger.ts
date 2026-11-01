// src/shared/audit/auditLogger.ts
import pg from 'pg';
import { TenantId, UserId, ScopeDefinition, RoleType } from '../types/index.js';

export interface AuditRecordParams {
  tenantId: TenantId;
  actorId?: UserId | null;
  actorType: 'USER' | 'PLATFORM_ADMIN' | 'SYSTEM' | 'CUSTOMER';
  role?: RoleType | null;
  scope?: ScopeDefinition | null;
  action: string;
  resourceType: string;
  resourceId: string;
  diff?: Record<string, unknown> | null;
  ipAddress?: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
}

export class AuditLogger {
  /**
   * Writes an immutable audit row within the caller's transaction client.
   * If an operation fails, an audit log with outcome 'ERROR' or 'DENIED' must still be recorded.
   */
  public static async log(client: pg.PoolClient, params: AuditRecordParams): Promise<number> {
    const query = `
      INSERT INTO audit_logs (
        tenant_id,
        actor_id,
        actor_type,
        role,
        scope_type,
        scope_id,
        action,
        resource_type,
        resource_id,
        diff,
        ip_address,
        outcome
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id;
    `;

    const values = [
      params.tenantId,
      params.actorId || null,
      params.actorType,
      params.role || null,
      params.scope?.type || null,
      params.scope?.branchId || null,
      params.action,
      params.resourceType,
      params.resourceId,
      params.diff ? JSON.stringify(params.diff) : null,
      params.ipAddress || null,
      params.outcome,
    ];

    const result = await client.query(query, values);
    return Number(result.rows[0].id);
  }
}

