// src/modules/scheduling/services/rescheduleAndCancellationService.ts
import crypto from 'crypto';
import pg from 'pg';
import {
  TenantId,
  UserId,
  ActorContext,
  Paise,
  toPaise,
} from '../../../shared/types/index.js';
import {
  TenantIsolationViolationError,
  InvariantViolationError,
  ConcurrencyConflictError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';
import { OutboxService } from '../../messaging/services/outboxService.js';

export interface CancellationPolicy {
  freeCancellationWindowHours: number; // default: 24
  lateCancellationFeeBps: number;       // default: 3000 (30%)
  minNoticeWindowHours: number;        // default: 2
}

export interface RescheduleResult {
  appointmentId: string;
  previousStartTime: string;
  newStartTime: string;
  newEndTime: string;
  status: string;
}

export interface CancellationResult {
  appointmentId: string;
  status: string;
  originalPricePaise: Paise;
  cancellationFeePaise: Paise;
  refundAmountPaise: Paise;
  isIdempotentReplay: boolean;
}

export class RescheduleAndCancellationService {
  private static readonly HMAC_SECRET = process.env.CUSTOMER_LINK_SECRET || 'PLATFORM_LINK_SIGNING_KEY_2026';

  /**
   * Generates a tamper-proof cryptographically signed URL token for customer self-service.
   */
  public static generateSignedCustomerToken(tenantId: TenantId, appointmentId: string): string {
    const payload = `${tenantId}:${appointmentId}`;
    const signature = crypto.createHmac('sha256', this.HMAC_SECRET).update(payload).digest('hex');
    return `${Buffer.from(payload).toString('base64url')}.${signature}`;
  }

  /**
   * Verifies the self-service token. Guessed or forged tokens throw TenantIsolationViolationError (404).
   */
  public static verifySignedCustomerToken(
    token: string
  ): { tenantId: TenantId; appointmentId: string } {
    try {
      const [encodedPayload, signature] = token.split('.');
      if (!encodedPayload || !signature) {
        throw new TenantIsolationViolationError();
      }

      const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
      const expectedSignature = crypto.createHmac('sha256', this.HMAC_SECRET).update(payload).digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        throw new TenantIsolationViolationError();
      }

      const [tenantId, appointmentId] = payload.split(':');
      return { tenantId: tenantId as TenantId, appointmentId };
    } catch {
      throw new TenantIsolationViolationError();
    }
  }

  /**
   * Atomically reschedules an appointment to a new start time.
   * If the target slot collides with an existing appointment or resource hold,
   * the database GiST constraint triggers a rollback, preserving the original booking intact.
   */
  public static async atomicReschedule(
    client: pg.PoolClient,
    tenantId: TenantId,
    appointmentId: string,
    newStartTimeISO: string,
    resourceIds?: string[]
  ): Promise<RescheduleResult> {
    // 1. Fetch current appointment
    const apptRes = await client.query<{
      start_time: Date;
      end_time: Date;
      status: string;
      service_id: string;
      professional_id: string;
    }>(
      `SELECT a.start_time, a.end_time, a.status, a.service_id, a.professional_id
       FROM appointments a
       WHERE a.tenant_id = $1 AND a.id = $2;`,
      [tenantId, appointmentId]
    );

    if (apptRes.rows.length === 0) {
      throw new EntityNotFoundError('Appointment', appointmentId);
    }

    const appt = apptRes.rows[0];

    if (appt.status === 'CANCELLED' || appt.status === 'COMPLETED') {
      throw new InvariantViolationError(`Cannot reschedule an appointment in ${appt.status} status.`);
    }

    const previousStartTime = new Date(appt.start_time).toISOString();

    // 2. Compute new end time from duration
    const sRes = await client.query<{ duration_minutes: number }>(
      'SELECT duration_minutes FROM services WHERE tenant_id = $1 AND id = $2;',
      [tenantId, appt.service_id]
    );
    const durationMinutes = sRes.rows[0].duration_minutes;

    const newStart = new Date(newStartTimeISO);
    const newEnd = new Date(newStart.getTime() + durationMinutes * 60 * 1000);
    const newEndTimeISO = newEnd.toISOString();

    try {
      // 3. Update appointment time (PostgreSQL GiST exclusion constraint verifies no overlap with other appointments)
      await client.query(
        `UPDATE appointments 
         SET start_time = $1, end_time = $2, version = version + 1, updated_at = NOW()
         WHERE tenant_id = $3 AND id = $4;`,
        [newStartTimeISO, newEndTimeISO, tenantId, appointmentId]
      );

      // 4. Update associated appointment resources
      await client.query(
        `UPDATE appointment_resources
         SET start_time = $1, end_time = $2
         WHERE tenant_id = $3 AND appointment_id = $4;`,
        [newStartTimeISO, newEndTimeISO, tenantId, appointmentId]
      );

      // 5. Shift Outbox Reminder Scheduled Time Atomically
      await OutboxService.updateReminderSchedule(client, tenantId, appointmentId, newStartTimeISO);

      // 6. Write Audit Log
      await AuditLogger.log(client, {
        tenantId,
        actorId: null,
        actorType: 'SYSTEM',
        action: 'booking:reschedule',
        resourceType: 'appointments',
        resourceId: appointmentId,
        diff: {
          previousStartTime,
          newStartTime: newStartTimeISO,
          newEndTime: newEndTimeISO,
        },
        outcome: 'SUCCESS',
      });

      return {
        appointmentId,
        previousStartTime,
        newStartTime: newStartTimeISO,
        newEndTime: newEndTimeISO,
        status: appt.status,
      };
    } catch (err: any) {
      if (err.code === '23P01' || (err.message && err.message.includes('exclusion'))) {
        throw new ConcurrencyConflictError(
          'Reschedule Conflict: The target slot or resource is already booked.'
        );
      }
      throw err;
    }
  }

  /**
   * Policy-Based Cancellation Engine.
   * Handles free-window (100% refund), late cancellation fees (e.g. 30%), and visit-window lockouts.
   */
  public static async cancelAppointment(
    client: pg.PoolClient,
    tenantId: TenantId,
    appointmentId: string,
    reason: string,
    callerType: 'CUSTOMER' | 'STAFF' = 'CUSTOMER'
  ): Promise<CancellationResult> {
    const apptRes = await client.query<{
      status: string;
      start_time: Date;
      locked_price_paise: string;
    }>(
      'SELECT status, start_time, locked_price_paise FROM appointments WHERE tenant_id = $1 AND id = $2;',
      [tenantId, appointmentId]
    );

    if (apptRes.rows.length === 0) {
      throw new EntityNotFoundError('Appointment', appointmentId);
    }

    const appt = apptRes.rows[0];

    // Idempotency: If already cancelled, return existing state with zero new refund
    if (appt.status === 'CANCELLED') {
      return {
        appointmentId,
        status: 'CANCELLED',
        originalPricePaise: toPaise(appt.locked_price_paise),
        cancellationFeePaise: 0n as Paise,
        refundAmountPaise: 0n as Paise,
        isIdempotentReplay: true,
      };
    }

    const originalPricePaise = BigInt(appt.locked_price_paise) as Paise;
    const now = new Date();
    const apptStart = new Date(appt.start_time);
    const diffHours = (apptStart.getTime() - now.getTime()) / (1000 * 60 * 60);

    // Fetch tenant cancellation policy
    const policyRes = await client.query<{
      free_cancellation_window_hours: number;
      late_cancellation_fee_bps: number;
      min_notice_window_hours: number;
    }>(
      'SELECT free_cancellation_window_hours, late_cancellation_fee_bps, min_notice_window_hours FROM cancellation_policies WHERE tenant_id = $1;',
      [tenantId]
    );

    const policy: CancellationPolicy = policyRes.rows.length > 0
      ? {
          freeCancellationWindowHours: policyRes.rows[0].free_cancellation_window_hours,
          lateCancellationFeeBps: policyRes.rows[0].late_cancellation_fee_bps,
          minNoticeWindowHours: policyRes.rows[0].min_notice_window_hours,
        }
      : {
          freeCancellationWindowHours: 24,
          lateCancellationFeeBps: 3000, // 30%
          minNoticeWindowHours: 2,
        };

    // Rule 1: Notice Window Lockout (Cannot cancel within 2 hours via customer link)
    if (callerType === 'CUSTOMER' && diffHours < policy.minNoticeWindowHours) {
      throw new InvariantViolationError(
        `Appointments cannot be cancelled online within ${policy.minNoticeWindowHours} hours of the visit time. Please call the outlet.`
      );
    }

    // Rule 2: Calculate Fee and Refund
    let cancellationFeePaise = 0n as Paise;
    let refundAmountPaise = originalPricePaise;

    if (diffHours < policy.freeCancellationWindowHours) {
      // Late cancellation fee applies
      cancellationFeePaise = toPaise((originalPricePaise * BigInt(policy.lateCancellationFeeBps)) / 10000n);
      refundAmountPaise = toPaise(originalPricePaise - cancellationFeePaise);
    }

    // 3. Mark appointment CANCELLED and release resources
    await client.query(
      "UPDATE appointments SET status = 'CANCELLED', updated_at = NOW() WHERE tenant_id = $1 AND id = $2;",
      [tenantId, appointmentId]
    );

    await client.query(
      "UPDATE appointment_resources SET status = 'RELEASED' WHERE tenant_id = $1 AND appointment_id = $2;",
      [tenantId, appointmentId]
    );

    // 4. Cancel all pending outbox messages for this appointment
    await OutboxService.cancelBookingMessages(client, tenantId, appointmentId);

    // 5. Write Immutable Audit Log
    await AuditLogger.log(client, {
      tenantId,
      actorId: null,
      actorType: callerType === 'CUSTOMER' ? 'CUSTOMER' : 'USER',
      action: 'booking:cancel',
      resourceType: 'appointments',
      resourceId: appointmentId,
      diff: {
        reason,
        diffHours,
        originalPricePaise: originalPricePaise.toString(),
        cancellationFeePaise: cancellationFeePaise.toString(),
        refundAmountPaise: refundAmountPaise.toString(),
      },
      outcome: 'SUCCESS',
    });

    return {
      appointmentId,
      status: 'CANCELLED',
      originalPricePaise,
      cancellationFeePaise,
      refundAmountPaise,
      isIdempotentReplay: false,
    };
  }
}

