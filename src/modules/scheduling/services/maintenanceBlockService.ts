// src/modules/scheduling/services/maintenanceBlockService.ts
import pg from 'pg';
import {
  TenantId,
  BranchId,
  ResourceId,
  ActorContext,
} from '../../../shared/types/index.js';
import {
  InvariantViolationError,
  ConcurrencyConflictError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export interface CreateMaintenanceBlockInput {
  branchId: BranchId;
  resourceId: ResourceId;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  reason: string;
}

export interface AffectedAppointmentSummary {
  appointmentId: string;
  customerName: string;
  customerPhone: string;
  startTime: string;
  endTime: string;
  serviceName: string;
}

export interface MaintenanceBlockResult {
  blockId: string;
  resourceId: string;
  startTime: string;
  endTime: string;
  affectedAppointments: AffectedAppointmentSummary[];
}

export class MaintenanceBlockService {
  /**
   * Places a physical resource under maintenance for a specified time window.
   * Invariant: Does not silently delete or cancel existing bookings; surfaces affected appointments for staff reassignment.
   */
  public static async createMaintenanceBlock(
    client: pg.PoolClient,
    actor: ActorContext,
    input: CreateMaintenanceBlockInput
  ): Promise<MaintenanceBlockResult> {
    const tenantId = actor.tenantId;

    if (new Date(input.startTime) >= new Date(input.endTime)) {
      throw new InvariantViolationError('Maintenance start time must be before end time.');
    }

    // Verify resource exists in tenant and branch
    const resCheck = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM resources WHERE tenant_id = $1 AND branch_id = $2 AND id = $3;',
      [tenantId, input.branchId, input.resourceId]
    );

    if (resCheck.rows.length === 0) {
      throw new EntityNotFoundError('Resource', input.resourceId);
    }

    try {
      // 1. Insert Maintenance Block (GiST exclusion constraint prevents overlapping maintenance for the same resource)
      const res = await client.query<{ id: string }>(
        `INSERT INTO resource_maintenance_blocks (
          tenant_id, branch_id, resource_id, start_time, end_time, reason
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id;`,
        [tenantId, input.branchId, input.resourceId, input.startTime, input.endTime, input.reason]
      );
      const blockId = res.rows[0].id;

      // 2. Identify and flag any existing appointments scheduled on this resource during the block
      const affectedRes = await client.query<{
        id: string;
        first_name: string;
        last_name: string;
        phone_e164: string;
        start_time: Date;
        end_time: Date;
        service_name: string;
      }>(
        `SELECT 
          a.id,
          c.first_name,
          c.last_name,
          c.phone_e164,
          a.start_time,
          a.end_time,
          s.name as service_name
        FROM appointment_resources ar
        JOIN appointments a ON a.tenant_id = ar.tenant_id AND a.id = ar.appointment_id
        JOIN customers c ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
        JOIN services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
        WHERE ar.tenant_id = $1
          AND ar.resource_id = $2
          AND ar.status = 'CONFIRMED'
          AND tstzrange(ar.start_time, ar.end_time, '[)') && tstzrange($3, $4, '[)');`,
        [tenantId, input.resourceId, input.startTime, input.endTime]
      );

      const affectedAppointments: AffectedAppointmentSummary[] = affectedRes.rows.map((row) => ({
        appointmentId: row.id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        customerPhone: row.phone_e164,
        startTime: new Date(row.start_time).toISOString(),
        endTime: new Date(row.end_time).toISOString(),
        serviceName: row.service_name,
      }));

      // 3. Write Audit Log
      await AuditLogger.log(client, {
        tenantId,
        actorId: actor.userId,
        actorType: 'USER',
        role: actor.roles[0]?.role,
        action: 'resource:maintenance_block',
        resourceType: 'resource_maintenance_blocks',
        resourceId: blockId,
        diff: {
          resourceId: input.resourceId,
          resourceName: resCheck.rows[0].name,
          startTime: input.startTime,
          endTime: input.endTime,
          reason: input.reason,
          affectedCount: affectedAppointments.length,
        },
        outcome: 'SUCCESS',
      });

      return {
        blockId,
        resourceId: input.resourceId,
        startTime: input.startTime,
        endTime: input.endTime,
        affectedAppointments,
      };
    } catch (err: any) {
      if (err.code === '23P01' || (err.message && err.message.includes('exclusion'))) {
        throw new ConcurrencyConflictError(
          'An existing maintenance block is already active for this resource in the requested timeframe.'
        );
      }
      throw err;
    }
  }
}

