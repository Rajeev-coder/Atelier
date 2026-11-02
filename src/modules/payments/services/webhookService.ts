// src/modules/payments/services/webhookService.ts
import pg from 'pg';
import { TenantId } from '../../../shared/types/index.js';
import {
  GatewayType,
  PaymentStatus,
  TenantPaymentConfig,
} from '../adapters/paymentGateway.js';
import { PaymentRouter } from './paymentRouter.js';
import { LatePaymentReconciler } from './latePaymentReconciler.js';
import {
  InvariantViolationError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export interface WebhookProcessResult {
  status: 'PROCESSED' | 'IGNORED_DUPLICATE' | 'LATE_RECONCILED';
  eventId: string;
  paymentId?: string;
  action?: string;
}

export class WebhookService {
  /**
   * Processes an incoming payment gateway webhook with:
   * 1. Signature verification against tenant secrets.
   * 2. Atomic event deduplication in payment_events.
   * 3. State machine validation (rejects out-of-order transitions).
   * 4. Double-entry ledger generation (Credit Salon Revenue, Debit Gateway Clearing).
   * 5. Late-payment reconciliation for expired holds.
   */
  public static async processWebhook(
    client: pg.PoolClient,
    tenantId: TenantId,
    gatewayType: GatewayType,
    rawBody: string,
    signatureHeader: string
  ): Promise<WebhookProcessResult> {
    // 1. Fetch Tenant Payment Configuration
    const configRes = await client.query<{
      default_currency: string;
      enabled_gateways: string[];
      credentials_encrypted: Record<string, string>;
      webhook_secret_encrypted: string;
    }>(
      'SELECT default_currency, enabled_gateways, credentials_encrypted, webhook_secret_encrypted FROM tenant_payment_configs WHERE tenant_id = $1;',
      [tenantId]
    );

    if (configRes.rows.length === 0) {
      throw new EntityNotFoundError('TenantPaymentConfig', tenantId);
    }

    const tenantConfig: TenantPaymentConfig = {
      tenantId,
      defaultCurrency: configRes.rows[0].default_currency,
      enabledGateways: configRes.rows[0].enabled_gateways as GatewayType[],
      credentialsEncrypted: configRes.rows[0].credentials_encrypted,
      webhookSecret: configRes.rows[0].webhook_secret_encrypted,
    };

    // 2. Resolve Gateway Adapter and Verify Signature
    const adapter = PaymentRouter.getGateway(tenantConfig, gatewayType);
    const eventData = await adapter.verifyWebhookSignature(tenantConfig, rawBody, signatureHeader);

    // 3. Replay-Safe Deduplication Check in payment_events
    try {
      await client.query(
        `INSERT INTO payment_events (tenant_id, gateway, gateway_event_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5);`,
        [tenantId, gatewayType, eventData.eventId, eventData.eventType, JSON.parse(rawBody)]
      );
    } catch (err: any) {
      // Catch unique violation on (tenant_id, gateway, gateway_event_id)
      if (err.code === '23505') {
        return {
          status: 'IGNORED_DUPLICATE',
          eventId: eventData.eventId,
        };
      }
      throw err;
    }

    // 4. Resolve Payment Entity
    let paymentRes = await client.query<{
      id: string;
      appointment_id: string;
      status: PaymentStatus;
      amount_paise: string;
      currency: string;
    }>(
      `SELECT id, appointment_id, status, amount_paise, currency FROM payments 
       WHERE tenant_id = $1 AND (gateway_order_id = $2 OR appointment_id = $3);`,
      [tenantId, eventData.gatewayOrderId || 'N/A', eventData.appointmentId || '00000000-0000-0000-0000-000000000000']
    );

    if (paymentRes.rows.length === 0) {
      throw new EntityNotFoundError('Payment', eventData.gatewayOrderId || 'N/A');
    }

    const payment = paymentRes.rows[0];

    // 5. State Machine Transition Validation
    // Invariant: Cannot refund an unpaid payment (Out-of-order delivery protection)
    if (eventData.status === 'REFUNDED' && payment.status !== 'PAID') {
      throw new InvariantViolationError(
        `Illegal State Transition: Cannot transition payment ${payment.id} from ${payment.status} to REFUNDED. Out-of-order webhook delivery detected.`
      );
    }

    // Invariant: Cannot pay an already refunded payment
    if (eventData.status === 'PAID' && payment.status === 'REFUNDED') {
      throw new InvariantViolationError(
        `Illegal State Transition: Payment ${payment.id} is already REFUNDED and cannot be marked PAID.`
      );
    }

    // 6. Check Associated Appointment Status
    const apptRes = await client.query<{ status: string }>(
      'SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2;',
      [tenantId, payment.appointment_id]
    );
    const appointmentStatus = apptRes.rows[0]?.status;

    // Handle Late Payment on Expired Appointment
    if (appointmentStatus === 'EXPIRED') {
      const lateResult = await LatePaymentReconciler.handleLatePayment(
        client,
        tenantConfig,
        adapter,
        payment,
        eventData
      );
      return {
        status: 'LATE_RECONCILED',
        eventId: eventData.eventId,
        paymentId: payment.id,
        action: lateResult.action,
      };
    }

    // 7. Transition Payment & Write Double-Entry Ledger
    if (eventData.status === 'PAID') {
      await client.query(
        "UPDATE payments SET status = 'PAID', gateway_payment_id = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3;",
        [eventData.gatewayPaymentId, tenantId, payment.id]
      );

      // Transition appointment to CONFIRMED if PENDING_PAYMENT
      if (appointmentStatus === 'PENDING_PAYMENT') {
        await client.query(
          "UPDATE appointments SET status = 'CONFIRMED', updated_at = NOW() WHERE tenant_id = $1 AND id = $2;",
          [tenantId, payment.appointment_id]
        );
      }

      // Append-Only Balanced Double-Entry:
      // Line 1: Debit Gateway Clearing (Asset +)
      // Line 2: Credit Salon Revenue (Revenue +)
      await client.query(
        `INSERT INTO ledger_entries (
          tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
        ) VALUES 
          ($1, $2, $3, 'DEBIT', 'GATEWAY_CLEARING', $4, $5, 'Online payment captured'),
          ($1, $2, $3, 'CREDIT', 'SALON_REVENUE', $4, $5, 'Online payment captured');`,
        [tenantId, payment.appointment_id, payment.id, eventData.amountPaise.toString(), eventData.currency]
      );

      // Audit Log
      await AuditLogger.log(client, {
        tenantId,
        actorId: null,
        actorType: 'SYSTEM',
        action: 'payment:webhook_processed',
        resourceType: 'payments',
        resourceId: payment.id,
        diff: {
          gateway: gatewayType,
          eventId: eventData.eventId,
          amountPaise: eventData.amountPaise.toString(),
          status: 'PAID',
        },
        outcome: 'SUCCESS',
      });
    }

    return {
      status: 'PROCESSED',
      eventId: eventData.eventId,
      paymentId: payment.id,
    };
  }
}

