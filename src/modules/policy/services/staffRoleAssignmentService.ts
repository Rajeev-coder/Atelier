// src/modules/policy/services/staffRoleAssignmentService.ts
import pg from 'pg';
import {
  TenantId,
  UserId,
  RoleType,
  ScopeDefinition,
  ActorContext,
  asUserId,
  Paise,
} from '../../../shared/types/index.js';
import { PolicyEngine } from '../../../shared/policy/policyEngine.js';

export interface AssignRoleInput {
  targetUserId: UserId;
  role: RoleType;
  scope: ScopeDefinition;
  tier?: string;
  baseCompensationPaise?: Paise;
  commissionRateBps?: number;
}

export interface StaffMemberDetails {
  userId: string;
  name: string;
  email: string;
  phone: string;
  role: RoleType;
  scopeType: string;
  scopeId: string | null;
  tier: string;
  base_compensation_paise?: string;
  commission_rate_bps?: number;
}

export class StaffRoleAssignmentService {
  /**
   * Assigns a scoped role to a user within a tenant, enforcing strict privilege escalation boundaries.
   */
  public static async assignRole(
    client: pg.PoolClient,
    grantor: ActorContext,
    input: AssignRoleInput
  ): Promise<{ assignmentId: string }> {
    const tenantId = grantor.tenantId;

    // 1. Enforce Privilege Escalation Invariant
    PolicyEngine.assertCanAssignRole(grantor, input.role, input.scope);

    // 2. Insert or Update Staff Profile (Tier & Compensation)
    await client.query(
      `INSERT INTO staff_profiles (tenant_id, user_id, tier, base_compensation_paise, commission_rate_bps)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET
         tier = EXCLUDED.tier,
         base_compensation_paise = EXCLUDED.base_compensation_paise,
         commission_rate_bps = EXCLUDED.commission_rate_bps,
         updated_at = NOW();`,
      [
        tenantId,
        input.targetUserId,
        input.tier || 'STANDARD',
        input.baseCompensationPaise ? input.baseCompensationPaise.toString() : '0',
        input.commissionRateBps || 0,
      ]
    );

    // 3. Insert or Update Role Assignment with Branch/Tenant scope
    const res = await client.query<{ id: string }>(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id, role_id, scope_type, scope_id)
       DO UPDATE SET created_at = NOW()
       RETURNING id;`,
      [
        tenantId,
        input.targetUserId,
        input.role,
        input.scope.type,
        input.scope.branchId || null,
      ]
    );

    return { assignmentId: res.rows[0].id };
  }

  /**
   * Lists staff in the tenant with their role assignments and profile details.
   */
  public static async listStaff(
    client: pg.PoolClient,
    tenantId: TenantId
  ): Promise<StaffMemberDetails[]> {
    const query = `
      SELECT 
        u.id as "userId",
        u.name,
        u.email,
        u.phone_e164 as "phone",
        ra.role_id as "role",
        ra.scope_type as "scopeType",
        ra.scope_id as "scopeId",
        sp.tier,
        sp.base_compensation_paise,
        sp.commission_rate_bps
      FROM users u
      JOIN role_assignments ra ON ra.user_id = u.id AND ra.tenant_id = $1
      JOIN staff_profiles sp ON sp.user_id = u.id AND sp.tenant_id = $1
      ORDER BY u.name ASC;
    `;

    const res = await client.query(query, [tenantId]);
    return res.rows;
  }
}

