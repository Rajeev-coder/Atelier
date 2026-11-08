// src/modules/messaging/services/outboxService.ts
import pg from 'pg';
import { TenantId } from '../../../shared/types/index.js';
import { PhoneNormalizer } from '../../../shared/utils/phoneNormalizer.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export class OutboxService {
  /**
   * Enqueues transactional outbox messages (Confirmation + Reminder) within the caller's transaction.
   * Invariant: Must run in the exact same database transaction as the booking insertion.
   */
  public static async queueBookingMessages(
    client: pg.PoolClient,
    tenantId: TenantId,
    appointmentId: string,
    customerPhone: string,
    customerName: string,
    serviceName: string,
    appointmentStartTimeISO: string,
    branchAddress: string
  ): Promise<void> {
    const normalizedPhone = PhoneNormalizer.normalizeE164(customerPhone);
    const apptDate = new Date(appointmentStartTimeISO);

    // Format human-readable date and time
    const appointmentDateStr = apptDate.toLocaleDateString('en-IN', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
    const appointmentTimeStr = apptDate.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    });

    const templateVariables = {
      customer_name: customerName,
      service_name: serviceName,
      appointment_date: appointmentDateStr,
      appointment_time: appointmentTimeStr,
      branch_address: branchAddress,
    };

    // 1. Enqueue BOOKING_CONFIRMATION (Scheduled for immediate dispatch: NOW())
    const confirmationKey = `${tenantId}:${appointmentId}:BOOKING_CONFIRMATION`;
    await client.query(
      `INSERT INTO outbox_messages (
        tenant_id, booking_id, message_type, recipient_phone_e164,
        template_name, template_variables, provider_idempotency_key,
        status, scheduled_at
      ) VALUES ($1, $2, 'BOOKING_CONFIRMATION', $3, 'booking_confirmation_v1', $4, $5, 'QUEUED', NOW())
      ON CONFLICT (tenant_id, booking_id, message_type) DO NOTHING;`,
      [tenantId, appointmentId, normalizedPhone, JSON.stringify(templateVariables), confirmationKey]
    );

    // 2. Enqueue APPOINTMENT_REMINDER (Scheduled for 24 hours prior to appointment)
    const reminderScheduledAt = new Date(apptDate.getTime() - 24 * 60 * 60 * 1000);
    // If appointment is within 24 hours, schedule reminder immediately or 2 hours before
    const effectiveReminderTime = reminderScheduledAt > new Date()
      ? reminderScheduledAt
      : new Date(Date.now() + 60 * 1000);

    const reminderKey = `${tenantId}:${appointmentId}:APPOINTMENT_REMINDER`;
    await client.query(
      `INSERT INTO outbox_messages (
        tenant_id, booking_id, message_type, recipient_phone_e164,
        template_name, template_variables, provider_idempotency_key,
        status, scheduled_at
      ) VALUES ($1, $2, 'APPOINTMENT_REMINDER', $3, 'appointment_reminder_v1', $4, $5, 'QUEUED', $6)
      ON CONFLICT (tenant_id, booking_id, message_type) DO NOTHING;`,
      [tenantId, appointmentId, normalizedPhone, JSON.stringify(templateVariables), reminderKey, effectiveReminderTime.toISOString()]
    );
  }

  /**
   * Updates reminder schedule when an appointment is rescheduled.
   */
  public static async updateReminderSchedule(
    client: pg.PoolClient,
    tenantId: TenantId,
    appointmentId: string,
    newStartTimeISO: string
  ): Promise<void> {
    const newStart = new Date(newStartTimeISO);
    const newReminderTime = new Date(newStart.getTime() - 24 * 60 * 60 * 1000);

    const newDateStr = newStart.toLocaleDateString('en-IN', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
    const newTimeStr = newStart.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    });

    await client.query(
      `UPDATE outbox_messages
       SET scheduled_at = $1,
           template_variables = template_variables || jsonb_build_object('appointment_date', $2::text, 'appointment_time', $3::text)
       WHERE tenant_id = $4 AND booking_id = $5 AND message_type = 'APPOINTMENT_REMINDER' AND status = 'QUEUED';`,
      [newReminderTime.toISOString(), newDateStr, newTimeStr, tenantId, appointmentId]
    );
  }

  /**
   * Cancels all pending queued outbox messages for an appointment.
   */
  public static async cancelBookingMessages(
    client: pg.PoolClient,
    tenantId: TenantId,
    appointmentId: string
  ): Promise<void> {
    await client.query(
      "UPDATE outbox_messages SET status = 'CANCELLED' WHERE tenant_id = $1 AND booking_id = $2 AND status = 'QUEUED';",
      [tenantId, appointmentId]
    );
  }

  /**
   * Inbound WhatsApp STOP webhook handler: Opts out customer and suppresses future queued reminders.
   */
  public static async handleInboundStop(
    client: pg.PoolClient,
    tenantId: TenantId,
    phoneInput: string
  ): Promise<{ phoneE164: string; suppressedMessagesCount: number }> {
    const phoneE164 = PhoneNormalizer.normalizeE164(phoneInput);

    // 1. Opt out customer
    await client.query(
      'UPDATE customers SET consent_whatsapp = FALSE, updated_at = NOW() WHERE tenant_id = $1 AND phone_e164 = $2;',
      [tenantId, phoneE164]
    );

    // 2. Suppress any queued outbox messages for this phone
    const res = await client.query(
      "UPDATE outbox_messages SET status = 'SUPPRESSED' WHERE tenant_id = $1 AND recipient_phone_e164 = $2 AND status = 'QUEUED';",
      [tenantId, phoneE164]
    );

    await AuditLogger.log(client, {
      tenantId,
      actorId: null,
      actorType: 'CUSTOMER',
      action: 'whatsapp:inbound_stop_opt_out',
      resourceType: 'customers',
      resourceId: phoneE164,
      diff: { suppressedCount: res.rowCount },
      outcome: 'SUCCESS',
    });

    return {
      phoneE164,
      suppressedMessagesCount: res.rowCount || 0,
    };
  }

  /**
   * Seeds standard approved WhatsApp templates for a tenant.
   */
  public static async seedDefaultTemplates(client: pg.PoolClient, tenantId: TenantId): Promise<void> {
    await client.query(
      `INSERT INTO whatsapp_templates (tenant_id, template_name, status, body_template, approved_variables)
       VALUES 
        ($1, 'booking_confirmation_v1', 'APPROVED', 'Hello {{customer_name}}, your booking for {{service_name}} on {{appointment_date}} at {{appointment_time}} is confirmed at {{branch_address}}.', ARRAY['customer_name', 'service_name', 'appointment_date', 'appointment_time', 'branch_address']),
        ($1, 'appointment_reminder_v1', 'APPROVED', 'Reminder: Hello {{customer_name}}, you have {{service_name}} scheduled tomorrow ({{appointment_date}}) at {{appointment_time}} at {{branch_address}}.', ARRAY['customer_name', 'service_name', 'appointment_date', 'appointment_time', 'branch_address'])
       ON CONFLICT (tenant_id, template_name) DO NOTHING;`,
      [tenantId]
    );
  }
}

