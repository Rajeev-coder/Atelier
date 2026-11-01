// src/modules/tenancy/services/tenantProvisioningService.ts
import pg from 'pg';
import { DatabaseClient } from '../../../shared/database/connection.js';
import { TenantId, UserId, BranchId, asTenantId, asUserId, asBranchId } from '../../../shared/types/index.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export interface ProvisionTenantInput {
  provisioningKey: string;
  name: string;
  slug: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerName: string;
  timezone?: string;
  currency?: string;
}

export interface ProvisioningResult {
  tenantId: TenantId;
  branchId: BranchId;
  ownerId: UserId;
  isExisting: boolean;
}

export interface SetupChecklist {
  hasBranch: boolean;
  hasServices: boolean;
  hasStaff: boolean;
  hasWorkingHours: boolean;
  isReadyForLive: boolean;
}

export class TenantProvisioningService {
  /**
   * Idempotent tenant provisioning (Slice 1).
   * Transactionally provisions tenant, default branch, owner user, owner role, and audit record.
   */
  public static async provisionTenant(input: ProvisionTenantInput): Promise<ProvisioningResult> {
    return DatabaseClient.withPlatformTransaction(async (client) => {
      // 1. Idempotency Check on provisioningKey
      const existingTenant = await client.query<{ id: string }>(
        'SELECT id FROM tenants WHERE provisioning_key = $1;',
        [input.provisioningKey]
      );

      if (existingTenant.rows.length > 0) {
        const tenantId = asTenantId(existingTenant.rows[0].id);

        const branchRow = await client.query<{ id: string }>(
          'SELECT id FROM branches WHERE tenant_id = $1 AND is_default = TRUE LIMIT 1;',
          [tenantId]
        );
        const ownerRow = await client.query<{ user_id: string }>(
          "SELECT user_id FROM role_assignments WHERE tenant_id = $1 AND role_id = 'OWNER' LIMIT 1;",
          [tenantId]
        );

        return {
          tenantId,
          branchId: asBranchId(branchRow.rows[0]?.id || ''),
          ownerId: asUserId(ownerRow.rows[0]?.user_id || ''),
          isExisting: true,
        };
      }

      // 2. Insert Tenant
      const tenantRes = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, timezone, currency, provisioning_key, status)
         VALUES ($1, $2, $3, $4, $5, 'PROVISIONING')
         RETURNING id;`,
        [
          input.name,
          input.slug,
          input.timezone || 'Asia/Kolkata',
          input.currency || 'INR',
          input.provisioningKey,
        ]
      );
      const tenantId = asTenantId(tenantRes.rows[0].id);

      // Invariant: Row-Level Security session context set for subsequent tenant tables
      await client.query('SET LOCAL app.tenant_id = $1;', [tenantId]);

      // 3. Insert Default Branch
      const branchRes = await client.query<{ id: string }>(
        `INSERT INTO branches (tenant_id, name, timezone, is_default)
         VALUES ($1, 'Main Branch', $2, TRUE)
         RETURNING id;`,
        [tenantId, input.timezone || 'Asia/Kolkata']
      );
      const branchId = asBranchId(branchRes.rows[0].id);

      // 4. Create or Resolve Owner User
      let ownerId: UserId;
      const userRes = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1;',
        [input.ownerEmail]
      );

      if (userRes.rows.length > 0) {
        ownerId = asUserId(userRes.rows[0].id);
      } else {
        const newUserRes = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id;`,
          [
            input.ownerEmail,
            input.ownerPhone,
            input.ownerName,
            'INVITED_HASH', // Set during password activation invite flow
          ]
        );
        ownerId = asUserId(newUserRes.rows[0].id);
      }

      // 5. Assign OWNER Role with TENANT scope
      await client.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type)
         VALUES ($1, $2, 'OWNER', 'TENANT');`,
        [tenantId, ownerId]
      );

      // Create owner staff profile
      await client.query(
        `INSERT INTO staff_profiles (tenant_id, user_id, tier, base_compensation_paise)
         VALUES ($1, $2, 'OWNER', 0);`,
        [tenantId, ownerId]
      );

      // 6. Write Platform Audit Row
      await AuditLogger.log(client, {
        tenantId,
        actorId: ownerId,
        actorType: 'PLATFORM_ADMIN',
        action: 'tenant:provision',
        resourceType: 'tenants',
        resourceId: tenantId,
        diff: { name: input.name, slug: input.slug, provisioningKey: input.provisioningKey },
        outcome: 'SUCCESS',
      });

      return {
        tenantId,
        branchId,
        ownerId,
        isExisting: false,
      };
    });
  }

  /**
   * Generates the setup checklist for the tenant.
   */
  public static async getSetupChecklist(client: pg.PoolClient, tenantId: TenantId): Promise<SetupChecklist> {
    const branches = await client.query('SELECT count(*) FROM branches WHERE tenant_id = $1;', [tenantId]);
    const services = await client.query('SELECT count(*) FROM services WHERE tenant_id = $1 AND is_active = TRUE;', [tenantId]);
    const staff = await client.query('SELECT count(*) FROM role_assignments WHERE tenant_id = $1;', [tenantId]);
    const hours = await client.query('SELECT count(*) FROM professional_working_hours WHERE tenant_id = $1;', [tenantId]);

    const hasBranch = Number(branches.rows[0].count) > 0;
    const hasServices = Number(services.rows[0].count) > 0;
    const hasStaff = Number(staff.rows[0].count) >= 2; // Owner + at least one team member
    const hasWorkingHours = Number(hours.rows[0].count) > 0;

    return {
      hasBranch,
      hasServices,
      hasStaff,
      hasWorkingHours,
      isReadyForLive: hasBranch && hasServices && hasStaff && hasWorkingHours,
    };
  }
}

