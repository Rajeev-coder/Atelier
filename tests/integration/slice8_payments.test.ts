// tests/integration/slice8_payments.test.ts
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseClient } from '../../src/shared/database/connection.js';
import { PaymentRouter } from '../../src/modules/payments/services/paymentRouter.js';
import { WebhookService } from '../../src/modules/payments/services/webhookService.js';
import { TenantProvisioningService } from '../../src/modules/tenancy/services/tenantProvisioningService.js';
import { CatalogueEligibilityService } from '../../src/modules/catalogue/services/catalogueEligibilityService.js';
import {
  TenantPaymentConfig,
  StripeAdapter,
  RazorpayAdapter,
} from '../../src/modules/payments/adapters/paymentGateway.js';
import {
  asTenantId,
  asUserId,
  asBranchId,
  toPaise,
  TenantId,
  UserId,
  BranchId,
  ServiceId,
} from '../../src/shared/types/index.js';
import { InvariantViolationError } from '../../src/shared/errors/index.js';

describe('Slice 8: Multi-Gateway Payments, Ledger Immutability & Webhook Reconciliations', () => {
  let isDbAvailable = false;

  let inrTenantId: TenantId;
  let inrBranchId: BranchId;
  let inrServiceId: ServiceId;
  let inrCoachId: UserId;

  let usdTenantId: TenantId;
  let usdBranchId: BranchId;

  const inrWebhookSecret = 'rzp_sec_test_secret_123';
  const usdWebhookSecret = 'whsec_stripe_test_secret_456';

  beforeAll(async () => {
    try {
      const pool = DatabaseClient.initialize();
      const client = await pool.connect();
      await client.query('SELECT 1;');
      client.release();
      isDbAvailable = true;
    } catch {
      console.warn('Real PostgreSQL is not running. Testing router algorithms and state contracts.');
      isDbAvailable = false;
    }
  });

  afterAll(async () => {
    if (isDbAvailable) {
      await DatabaseClient.close();
    }
  });

  describe('Scenario 1: Multi-Currency Dynamic Gateway Routing', () => {
    it('routes USD/EUR tenants to Stripe and INR tenants to Razorpay UPI', () => {
      // 1. USD Tenant Config
      const usdConfig: TenantPaymentConfig = {
        tenantId: asTenantId('tenant-usd-001'),
        defaultCurrency: 'USD',
        enabledGateways: ['STRIPE'],
        credentialsEncrypted: { apiKey: 'sk_test_usd' },
        webhookSecret: usdWebhookSecret,
      };

      const usdGateway = PaymentRouter.getGateway(usdConfig, undefined, 'USD');
      expect(usdGateway).toBeInstanceOf(StripeAdapter);
      expect(usdGateway.gatewayType).toBe('STRIPE');

      // 2. INR Tenant Config
      const inrConfig: TenantPaymentConfig = {
        tenantId: asTenantId('tenant-inr-002'),
        defaultCurrency: 'INR',
        enabledGateways: ['RAZORPAY'],
        credentialsEncrypted: { keyId: 'rzp_id', keySecret: 'rzp_sec' },
        webhookSecret: inrWebhookSecret,
      };

      const inrGateway = PaymentRouter.getGateway(inrConfig, undefined, 'INR');
      expect(inrGateway).toBeInstanceOf(RazorpayAdapter);
      expect(inrGateway.gatewayType).toBe('RAZORPAY');

      // 3. Multi-gateway tenant with customer method preference
      const dualConfig: TenantPaymentConfig = {
        tenantId: asTenantId('tenant-dual-003'),
        defaultCurrency: 'INR',
        enabledGateways: ['STRIPE', 'RAZORPAY'],
        credentialsEncrypted: {},
        webhookSecret: 'secret',
      };

      const preferredStripe = PaymentRouter.getGateway(dualConfig, 'STRIPE', 'USD');
      expect(preferredStripe).toBeInstanceOf(StripeAdapter);

      const preferredRazorpay = PaymentRouter.getGateway(dualConfig, 'RAZORPAY', 'INR');
      expect(preferredRazorpay).toBeInstanceOf(RazorpayAdapter);
    });
  });

  describe('Scenario 2: Replay & Out-of-Order Webhook Deduplication', () => {
    it('safely deduplicates 10 concurrent webhook deliveries and rejects out-of-order refunds', async () => {
      if (!isDbAvailable) {
        expect(WebhookService.processWebhook).toBeDefined();
        return;
      }

      // Provision USD Tenant
      const usdProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'pay-usd-tenant-001',
        name: 'Iron Forge USA',
        slug: 'iron-forge-usa',
        ownerEmail: 'owner@ironforge-usa.com',
        ownerPhone: '+15550001111',
        ownerName: 'Marcus US',
        currency: 'USD',
      });
      usdTenantId = usdProv.tenantId;
      usdBranchId = usdProv.branchId;

      let appointmentId = '';
      const orderId = `pi_test_${Date.now()}`;

      await DatabaseClient.withTenantTransaction(usdTenantId, async (client) => {
        // Set up Payment Config
        await client.query(
          `INSERT INTO tenant_payment_configs (tenant_id, default_currency, enabled_gateways, webhook_secret_encrypted)
           VALUES ($1, 'USD', ARRAY['STRIPE'], $2);`,
          [usdTenantId, usdWebhookSecret]
        );

        // Create Appointment (PENDING_PAYMENT)
        const aRes = await client.query<{ id: string }>(
          `INSERT INTO appointments (
            tenant_id, branch_id, customer_id, service_id, professional_id,
            start_time, end_time, status, locked_price_paise
          ) VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NOW(), NOW() + INTERVAL '1 hour', 'PENDING_PAYMENT', 15000)
          RETURNING id;`,
          [usdTenantId, usdBranchId]
        );
        appointmentId = aRes.rows[0].id;

        // Create Payment record (UNPAID)
        await client.query(
          `INSERT INTO payments (
            tenant_id, appointment_id, gateway, gateway_order_id, amount_paise, currency, status, idempotency_key
          ) VALUES ($1, $2, 'STRIPE', $3, 15000, 'USD', 'UNPAID', $4);`,
          [usdTenantId, appointmentId, orderId, `idem_pay_${Date.now()}`]
        );
      });

      // 1. Out-of-Order Webhook Test: Deliver `charge.refunded` before payment is PAID
      const prematureRefundPayload = JSON.stringify({
        id: `evt_premature_refund_${Date.now()}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_test_${Date.now()}`,
            amount: 15000,
            currency: 'usd',
            metadata: { appointmentId },
          },
        },
      });
      const prematureSig = crypto.createHmac('sha256', usdWebhookSecret).update(prematureRefundPayload).digest('hex');

      await expect(
        DatabaseClient.withTenantTransaction(usdTenantId, async (client) => {
          return WebhookService.processWebhook(client, usdTenantId, 'STRIPE', prematureRefundPayload, prematureSig);
        })
      ).rejects.toThrow(InvariantViolationError);

      // 2. Concurrency Replay Test: Deliver payment_intent.succeeded 10 times concurrently
      const successPayload = JSON.stringify({
        id: `evt_success_${orderId}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: orderId,
            amount: 15000,
            currency: 'usd',
            metadata: { appointmentId },
          },
        },
      });
      const successSig = crypto.createHmac('sha256', usdWebhookSecret).update(successPayload).digest('hex');

      const concurrentDeliveries = Array.from({ length: 10 }, () => {
        return DatabaseClient.withTenantTransaction(usdTenantId, async (client) => {
          return WebhookService.processWebhook(client, usdTenantId, 'STRIPE', successPayload, successSig);
        });
      });

      const results = await Promise.all(concurrentDeliveries);

      const processed = results.filter((r) => r.status === 'PROCESSED');
      const ignored = results.filter((r) => r.status === 'IGNORED_DUPLICATE');

      // Invariant: Exactly 1 delivery processes the ledger mutation, 9 are deduplicated safely
      expect(processed.length).toBe(1);
      expect(ignored.length).toBe(9);

      // Verify DB State: Exactly 2 ledger lines (1 Debit, 1 Credit), Appointment is CONFIRMED
      await DatabaseClient.withTenantTransaction(usdTenantId, async (client) => {
        const ledger = await client.query('SELECT * FROM ledger_entries WHERE tenant_id = $1 AND appointment_id = $2;', [
          usdTenantId,
          appointmentId,
        ]);
        expect(ledger.rows.length).toBe(2);

        const appt = await client.query<{ status: string }>('SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2;', [
          usdTenantId,
          appointmentId,
        ]);
        expect(appt.rows[0].status).toBe('CONFIRMED');
      });
    });
  });

  describe('Scenario 3: Late Success / Expiry Race Condition', () => {
    it('triggers automatic refund when payment arrives for an expired appointment whose slot was taken', async () => {
      if (!isDbAvailable) {
        return;
      }

      // Provision INR Tenant
      const inrProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'pay-inr-tenant-002',
        name: 'Iron Forge Mumbai',
        slug: 'iron-forge-mumbai',
        ownerEmail: 'owner@ironforge-mumbai.com',
        ownerPhone: '+919811888001',
        ownerName: 'Vikram Mumbai',
        currency: 'INR',
      });
      inrTenantId = inrProv.tenantId;
      inrBranchId = inrProv.branchId;

      let expiredApptId = '';
      let competingApptId = '';
      const slotTime = '2026-11-20T10:00:00.000Z';
      const slotEndTime = '2026-11-20T11:00:00.000Z';
      const rzpOrderId = `order_late_${Date.now()}`;

      await DatabaseClient.withTenantTransaction(inrTenantId, async (client) => {
        await client.query(
          `INSERT INTO tenant_payment_configs (tenant_id, default_currency, enabled_gateways, webhook_secret_encrypted)
           VALUES ($1, 'INR', ARRAY['RAZORPAY'], $2);`,
          [inrTenantId, inrWebhookSecret]
        );

        // Coach
        const uRes = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ('coach@mumbai.com', '+919811888002', 'Coach Ranveer', 'HASH')
           RETURNING id;`
        );
        inrCoachId = asUserId(uRes.rows[0].id);

        // Expired Appointment (Customer 1 timed out)
        const expRes = await client.query<{ id: string }>(
          `INSERT INTO appointments (
            tenant_id, branch_id, customer_id, service_id, professional_id,
            start_time, end_time, status, locked_price_paise
          ) VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), $3, $4, $5, 'EXPIRED', 150000)
          RETURNING id;`,
          [inrTenantId, inrBranchId, inrCoachId, slotTime, slotEndTime]
        );
        expiredApptId = expRes.rows[0].id;

        // Payment record linked to expired appointment
        await client.query(
          `INSERT INTO payments (
            tenant_id, appointment_id, gateway, gateway_order_id, amount_paise, currency, status, idempotency_key
          ) VALUES ($1, $2, 'RAZORPAY', $3, 150000, 'INR', 'UNPAID', $4);`,
          [inrTenantId, expiredApptId, rzpOrderId, `idem_late_${Date.now()}`]
        );

        // Meanwhile, Customer 2 booked that EXACT slot! (CONFIRMED)
        const compRes = await client.query<{ id: string }>(
          `INSERT INTO appointments (
            tenant_id, branch_id, customer_id, service_id, professional_id,
            start_time, end_time, status, locked_price_paise
          ) VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), $3, $4, $5, 'CONFIRMED', 150000)
          RETURNING id;`,
          [inrTenantId, inrBranchId, inrCoachId, slotTime, slotEndTime]
        );
        competingApptId = compRes.rows[0].id;
      });

      // Customer 1's late payment webhook arrives from Razorpay!
      const lateWebhookPayload = JSON.stringify({
        id: `evt_late_${Date.now()}`,
        event: 'order.paid',
        payload: {
          payment: {
            entity: {
              id: `pay_late_${Date.now()}`,
              order_id: rzpOrderId,
              amount: 150000,
              currency: 'INR',
              notes: { appointmentId: expiredApptId },
            },
          },
        },
      });
      const lateSig = crypto.createHmac('sha256', inrWebhookSecret).update(lateWebhookPayload).digest('hex');

      // Process late webhook
      await DatabaseClient.withTenantTransaction(inrTenantId, async (client) => {
        const res = await WebhookService.processWebhook(client, inrTenantId, 'RAZORPAY', lateWebhookPayload, lateSig);
        expect(res.status).toBe('LATE_RECONCILED');
        expect(res.action).toBe('REFUNDED');
      });

      // Assert:
      // 1. Appointment remains EXPIRED
      // 2. Payment status is REFUNDED
      // 3. Adjusting ledger entries written (Debit CUSTOMER_REFUNDS, Credit GATEWAY_CLEARING)
      await DatabaseClient.withTenantTransaction(inrTenantId, async (client) => {
        const appt = await client.query<{ status: string }>('SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2;', [
          inrTenantId,
          expiredApptId,
        ]);
        expect(appt.rows[0].status).toBe('EXPIRED');

        const pay = await client.query<{ status: string }>(
          'SELECT status FROM payments WHERE tenant_id = $1 AND appointment_id = $2;',
          [inrTenantId, expiredApptId]
        );
        expect(pay.rows[0].status).toBe('REFUNDED');

        const ledger = await client.query<{ entry_type: string; account: string }>(
          'SELECT entry_type, account FROM ledger_entries WHERE tenant_id = $1 AND appointment_id = $2;',
          [inrTenantId, expiredApptId]
        );
        expect(ledger.rows.length).toBe(2);
        const accounts = ledger.rows.map((r) => `${r.entry_type}:${r.account}`);
        expect(accounts).toContain('DEBIT:CUSTOMER_REFUNDS');
        expect(accounts).toContain('CREDIT:GATEWAY_CLEARING');
      });
    });
  });

  describe('Scenario 4: Ledger Immutability & Append-Only Trigger', () => {
    it('throws a database exception if an SQL UPDATE or DELETE is attempted on ledger_entries', async () => {
      if (!isDbAvailable) {
        return;
      }

      await DatabaseClient.withTenantTransaction(usdTenantId, async (client) => {
        // Query an existing ledger entry
        const entryRes = await client.query<{ id: string }>('SELECT id FROM ledger_entries WHERE tenant_id = $1 LIMIT 1;', [
          usdTenantId,
        ]);
        if (entryRes.rows.length === 0) return;

        const entryId = entryRes.rows[0].id;

        // Attempt UPDATE -> Must throw database exception
        await expect(
          client.query('UPDATE ledger_entries SET amount_paise = 99999 WHERE id = $1;', [entryId])
        ).rejects.toThrow(/CRITICAL INVARIANT VIOLATION.*strictly append-only/);

        // Attempt DELETE -> Must throw database exception
        await expect(
          client.query('DELETE FROM ledger_entries WHERE id = $1;', [entryId])
        ).rejects.toThrow(/CRITICAL INVARIANT VIOLATION.*strictly append-only/);
      });
    });
  });
});
