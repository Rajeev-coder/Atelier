// src/modules/payments/services/latePaymentReconciler.ts
import pg from 'pg';
import { TenantPaymentConfig, IPaymentGateway, WebhookEventData } from '../adapters/paymentGateway.js';
import { TenantId, Paise } from '../../../shared/types/index.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export interface LateReconciliationResult {
  action: 'REVIVED' | 'REFUNDED';
  appointmentId: string;
  refundId?: string;
}

export class LatePaymentReconciler {
  /**
   * Resolves late payment webhooks arriving on an EXPIRED appointment.
   * If slot is still free -> Revives booking to CONFIRMED.
   * If slot is occupied by another client -> Triggers automatic gateway refund and writes adjusting ledger.
   */
  public static async handleLatePayment(
    client: pg.PoolClient,
    config: TenantPaymentConfig,
    gatewayAdapter: IPaymentGateway,
    paymentRecord: { id: string; appointment_id: string },
    eventData: WebhookEventData
  ): Promise<LateReconciliationResult> {
    const tenantId = config.tenantId;
    const appointmentId = paymentRecord.appointment_id;

    // 1. Fetch expired appointment details
    const apptRes = await client.query<{
      start_time: Date;
      end_time: Date;
      professional_id: string;
      status: string;
    }>(
      'SELECT start_time, end_time, professional_id, status FROM appointments WHERE tenant_id = $1 AND id = $2;',
      [tenantId, appointmentId]
    );

    if (apptRes.rows.length === 0) {
      throw new Error(`Appointment ${appointmentId} not found during late reconciliation.`);
    }

    const appt = apptRes.rows[0];

    // 2. Check if professional slot is still free
    const collisionRes = await client.query<{ count: string }>(
      `SELECT count(*) FROM appointments 
       WHERE tenant_id = $1 
         AND professional_id = $2 
         AND id != $3
         AND status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN')
         AND tstzrange(start_time, end_time, '[)') && tstzrange($4, $5, '[)');`,
      [tenantId, appt.professional_id, appointmentId, appt.start_time.toISOString(), appt.end_time.toISOString()]
    );

    const isSlotOccupied = Number(collisionRes.rows[0].count) > 0;

    if (!isSlotOccupied) {
      // Branch A: Slot is free -> REVIVE APPOINTMENT
      await client.query(
        "UPDATE appointments SET status = 'CONFIRMED', version = version + 1, updated_at = NOW() WHERE tenant_id = $1 AND id = $2;",
        [tenantId, appointmentId]
      );

      await client.query(
        "UPDATE payments SET status = 'PAID', gateway_payment_id = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3;",
        [eventData.gatewayPaymentId, tenantId, paymentRecord.id]
      );

      // Balanced Double-Entry: Credit Salon Revenue, Debit Gateway Clearing
      await client.query(
        `INSERT INTO ledger_entries (
          tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
        ) VALUES 
          ($1, $2, $3, 'DEBIT', 'GATEWAY_CLEARING', $4, $5, 'Late payment received - slot revived'),
          ($1, $2, $3, 'CREDIT', 'SALON_REVENUE', $4, $5, 'Late payment received - slot revived');`,
        [tenantId, appointmentId, paymentRecord.id, eventData.amountPaise.toString(), eventData.currency]
      );

      await AuditLogger.log(client, {
        tenantId,
        actorId: null,
        actorType: 'SYSTEM',
        action: 'payment:late_revival',
        resourceType: 'appointments',
        resourceId: appointmentId,
        diff: {
          paymentId: paymentRecord.id,
          gatewayPaymentId: eventData.gatewayPaymentId,
          amountPaise: eventData.amountPaise.toString(),
        },
        outcome: 'SUCCESS',
      });

      return { action: 'REVIVED', appointmentId };
    } else {
      // Branch B: Slot occupied -> TRIGGER AUTOMATIC GATEWAY REFUND
      const refundResult = await gatewayAdapter.refund(
        config,
        eventData.gatewayPaymentId,
        eventData.amountPaise,
        'Slot occupied after hold expiry'
      );

      await client.query(
        "UPDATE payments SET status = 'REFUNDED', gateway_payment_id = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3;",
        [eventData.gatewayPaymentId, tenantId, paymentRecord.id]
      );

      // Adjusting Double-Entry: Debit Customer Refunds, Credit Gateway Clearing
      await client.query(
        `INSERT INTO ledger_entries (
          tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
        ) VALUES 
          ($1, $2, $3, 'DEBIT', 'CUSTOMER_REFUNDS', $4, $5, 'Late payment refund - slot conflict'),
          ($1, $2, $3, 'CREDIT', 'GATEWAY_CLEARING', $4, $5, 'Late payment refund - slot conflict');`,
        [tenantId, appointmentId, paymentRecord.id, eventData.amountPaise.toString(), eventData.currency]
      );

      await AuditLogger.log(client, {
        tenantId,
        actorId: null,
        actorType: 'SYSTEM',
        action: 'payment:late_automatic_refund',
        resourceType: 'appointments',
        resourceId: appointmentId,
        diff: {
          paymentId: paymentRecord.id,
          refundId: refundResult.refundId,
          reason: 'Slot occupied after hold expiry',
          amountPaise: eventData.amountPaise.toString(),
        },
        outcome: 'SUCCESS',
      });

      return { action: 'REFUNDED', appointmentId, refundId: refundResult.refundId };
    }
  }
}

