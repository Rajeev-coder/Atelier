// src/modules/scheduling/services/deskBookingService.ts
import crypto from 'crypto';
import pg from 'pg';
import {
  TenantId,
  BranchId,
  ServiceId,
  UserId,
  ActorContext,
  Paise,
} from '../../../shared/types/index.js';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvariantViolationError,
  AuthorizationDeniedError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';
import { CatalogueEligibilityService } from '../../catalogue/services/catalogueEligibilityService.js';
import { CustomerService } from '../../customers/services/customerService.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';
import { OutboxService } from '../../messaging/services/outboxService.js';

export interface CreateHoldInput {
  branchId: BranchId;
  serviceId: ServiceId;
  professionalId: UserId;
  customerPhone: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  resourceIds?: string[];
  ttlMinutes?: number; // default: 5
}

export interface HoldResult {
  holdId: string;
  expiresAt: string;
  startTime: string;
  endTime: string;
}

export interface CreateDeskBookingInput {
  idempotencyKey: string;
  branchId: BranchId;
  serviceId: ServiceId;
  professionalId: UserId;
  customerPhone: string;
  customerFirstName?: string;
  customerLastName?: string;
  startTime: string; // ISO 8601
  resourceIds: string[];
  holdId?: string;
  isManagerOverride?: boolean;
  overrideReason?: string;
}

export interface DeskBookingResponse {
  appointmentId: string;
  status: string;
  startTime: string;
  endTime: string;
  lockedPricePaise: string;
  customerId: string;
  customerPhone: string;
  isManagerOverride: boolean;
  assignedResourceIds: string[];
}

export class DeskBookingService {
  /**
   * Generates a deterministic SHA-256 hash of the normalized request payload.
   */
  public static computePayloadHash(payload: unknown): string {
    const serialized = JSON.stringify(payload, Object.keys(payload as object).sort());
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Acquires a short-lived slot hold (TTL 5 minutes).
   * Protected at the database level by GiST exclusion constraints on slot_holds and appointment_resources.
   */
  public static async createHold(
    client: pg.PoolClient,
    actor: ActorContext,
    input: CreateHoldInput
  ): Promise<HoldResult> {
    const tenantId = actor.tenantId;
    const ttlMinutes = input.ttlMinutes || 5;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

    try {
      // 1. Insert slot hold (exclusion constraint prevents concurrent hold overlap for professional)
      const holdRes = await client.query<{ id: string }>(
        `INSERT INTO slot_holds (
          tenant_id, branch_id, service_id, professional_id, customer_phone_e164,
          start_time, end_time, expires_at, status, created_by_role
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9)
        RETURNING id;`,
        [
          tenantId,
          input.branchId,
          input.serviceId,
          input.professionalId,
          input.customerPhone,
          input.startTime,
          input.endTime,
          expiresAt,
          actor.roles[0]?.role || 'FRONT_DESK_OPERATOR',
        ]
      );
      const holdId = holdRes.rows[0].id;

      // 2. Lock required resources under HELD status (exclusion constraint prevents concurrent resource collision)
      if (input.resourceIds && input.resourceIds.length > 0) {
        for (const resId of input.resourceIds) {
          await client.query(
            `INSERT INTO appointment_resources (
              tenant_id, hold_id, resource_id, start_time, end_time, status
            ) VALUES ($1, $2, $3, $4, $5, 'HELD');`,
            [tenantId, holdId, resId, input.startTime, input.endTime]
          );
        }
      }

      return {
        holdId,
        expiresAt,
        startTime: input.startTime,
        endTime: input.endTime,
      };
    } catch (err: any) {
      if (err.code === '23P01' || (err.message && err.message.includes('exclusion'))) {
        throw new ConcurrencyConflictError(
          'Slot or required resource is already held or booked by another client.'
        );
      }
      throw err;
    }
  }

  /**
   * Creates an appointment at the desk, enforcing:
   * 1. Request payload idempotency.
   * 2. Server-side 4-axis price quote calculation.
   * 3. Customer identity with phone normalization.
   * 4. Manager override authorization (if specified).
   * 5. Database GiST exclusion constraints for race protection.
   */
  public static async createDeskBooking(
    client: pg.PoolClient,
    actor: ActorContext,
    input: CreateDeskBookingInput
  ): Promise<{ statusCode: number; data: DeskBookingResponse }> {
    const tenantId = actor.tenantId;
    const requestHash = this.computePayloadHash(input);

    // 1. Idempotency Check
    const existingKey = await client.query<{
      status_code: number;
      response_payload: DeskBookingResponse;
      request_hash: string;
    }>(
      'SELECT status_code, response_payload, request_hash FROM idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2;',
      [tenantId, input.idempotencyKey]
    );

    if (existingKey.rows.length > 0) {
      const record = existingKey.rows[0];
      if (record.request_hash !== requestHash) {
        throw new IdempotencyConflictError(
          'Idempotency key was previously used with a different request payload.'
        );
      }
      return {
        statusCode: record.status_code,
        data: record.response_payload,
      };
    }

    // 2. Verify Role Capability for Desk Bookings
    const allowedRoles = ['OWNER', 'BRANCH_MANAGER', 'FRONT_DESK_OPERATOR', 'RECEPTIONIST'];
    const hasRole = actor.roles.some((r) => allowedRoles.includes(r.role));
    if (!hasRole && !actor.isPlatformAdmin) {
      throw new AuthorizationDeniedError('desk:book', 'Role not permitted to create desk bookings.');
    }

    // 3. Manager Override Validation
    if (input.isManagerOverride) {
      const isManagerOrOwner = actor.roles.some(
        (r) => r.role === 'OWNER' || r.role === 'BRANCH_MANAGER'
      );
      if (!isManagerOrOwner) {
        throw new AuthorizationDeniedError(
          'booking:override',
          'Only Branch Managers or Owners can authorize a booking override.'
        );
      }
      if (!input.overrideReason || input.overrideReason.trim().length === 0) {
        throw new InvariantViolationError('An override reason is strictly required for manager overrides.');
      }
    }

    // 4. Server-Side 4-Axis Price Calculation (Never trust client prices)
    const quote = await CatalogueEligibilityService.calculateServiceQuote(
      client,
      tenantId,
      input.serviceId,
      input.professionalId
    );

    // Calculate End Time from service duration
    const startDate = new Date(input.startTime);
    const endDate = new Date(startDate.getTime() + quote.durationMinutes * 60 * 1000);
    const endTime = endDate.toISOString();

    // 5. Customer Identity Resolution & Normalization
    const customer = await CustomerService.findOrCreateCustomer(client, tenantId, {
      phone: input.customerPhone,
      firstName: input.customerFirstName,
      lastName: input.customerLastName,
      consentWhatsApp: true,
      consentWordingVersion: 'v1.0-desk-verbal',
    });

    // 6. Handle Pre-existing Hold (if holdId provided)
    if (input.holdId) {
      const holdRes = await client.query<{ status: string; expires_at: Date }>(
        'SELECT status, expires_at FROM slot_holds WHERE tenant_id = $1 AND id = $2;',
        [tenantId, input.holdId]
      );
      if (holdRes.rows.length === 0) {
        throw new EntityNotFoundError('SlotHold', input.holdId);
      }
      if (holdRes.rows[0].status !== 'ACTIVE' || new Date(holdRes.rows[0].expires_at) <= new Date()) {
        throw new ConvariantConflictError('Slot hold has expired or has already been consumed.');
      }

      // Mark hold consumed
      await client.query(
        "UPDATE slot_holds SET status = 'CONSUMED' WHERE tenant_id = $1 AND id = $2;",
        [tenantId, input.holdId]
      );

      // Release hold resource records to avoid GiST collision with the confirmed appointment
      await client.query(
        "UPDATE appointment_resources SET status = 'RELEASED' WHERE tenant_id = $1 AND hold_id = $2;",
        [tenantId, input.holdId]
      );
    }

    try {
      // 7. Insert Appointment (Database GiST exclusion constraint prevents race condition double-booking)
      const apptRes = await client.query<{ id: string; status: string }>(
        `INSERT INTO appointments (
          tenant_id, branch_id, customer_id, service_id, professional_id,
          start_time, end_time, status, locked_price_paise, outstanding_balance_paise, payment_status,
          idempotency_key, is_manager_override, override_reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED', $8, $8, 'UNPAID', $9, $10, $11)
        RETURNING id, status;`,
        [
          tenantId,
          input.branchId,
          customer.id,
          input.serviceId,
          input.professionalId,
          input.startTime,
          endTime,
          quote.totalPricePaise.toString(),
          input.idempotencyKey,
          input.isManagerOverride || false,
          input.overrideReason || null,
        ]
      );
      const apptId = apptRes.rows[0].id;

      // 8. Assign Required Resources under CONFIRMED status
      for (const resId of input.resourceIds) {
        await client.query(
          `INSERT INTO appointment_resources (
            tenant_id, appointment_id, resource_id, start_time, end_time, status
          ) VALUES ($1, $2, $3, $4, $5, 'CONFIRMED');`,
          [tenantId, apptId, resId, input.startTime, endTime]
        );
      }

      // 9. Transactional Outbox Pattern: Enqueue Confirmation & Reminder in the SAME transaction
      const sNameRes = await client.query<{ name: string }>('SELECT name FROM services WHERE id = $1;', [input.serviceId]);
      const serviceName = sNameRes.rows[0]?.name || 'Standard Service';

      await OutboxService.queueBookingMessages(
        client,
        tenantId,
        apptId,
        customer.phone_e164,
        `${customer.first_name} ${customer.last_name}`.trim(),
        serviceName,
        input.startTime,
        'Main Branch'
      );

      // 9. Write Immutable Audit Log
      await AuditLogger.log(client, {
        tenantId,
        actorId: actor.userId,
        actorType: 'USER',
        role: actor.roles[0]?.role,
        scope: actor.roles[0]?.scope,
        action: input.isManagerOverride ? 'booking:desk_create_override' : 'booking:desk_create',
        resourceType: 'appointments',
        resourceId: apptId,
        diff: {
          customerId: customer.id,
          phone: customer.phone_e164,
          serviceId: input.serviceId,
          professionalId: input.professionalId,
          totalPricePaise: quote.totalPricePaise.toString(),
          resources: input.resourceIds,
          isOverride: input.isManagerOverride,
        },
        outcome: 'SUCCESS',
      });

      const responsePayload: DeskBookingResponse = {
        appointmentId: apptId,
        status: apptRes.rows[0].status,
        startTime: input.startTime,
        endTime,
        lockedPricePaise: quote.totalPricePaise.toString(),
        customerId: customer.id,
        customerPhone: customer.phone_e164,
        isManagerOverride: input.isManagerOverride || false,
        assignedResourceIds: input.resourceIds,
      };

      // 10. Store Idempotency Key Record
      await client.query(
        `INSERT INTO idempotency_keys (
          tenant_id, idempotency_key, request_hash, status_code, response_payload
        ) VALUES ($1, $2, $3, $4, $5);`,
        [tenantId, input.idempotencyKey, requestHash, 201, JSON.stringify(responsePayload)]
      );

      return {
        statusCode: 201,
        data: responsePayload,
      };
    } catch (err: any) {
      if (err.code === '23P01' || (err.message && err.message.includes('exclusion'))) {
        throw new ConcurrencyConflictError(
          'Concurrency Collision: The professional or one of the required physical resources was just booked in a parallel transaction.'
        );
      }
      throw err;
    }
  }
}
class ConvariantConflictError extends ConcurrencyConflictError {}

