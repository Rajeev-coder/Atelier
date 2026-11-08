// src/modules/payments/services/outletPaymentService.ts
import crypto from 'crypto';
import pg from 'pg';
import {
  TenantId,
  BranchId,
  ActorContext,
  Paise,
  toPaise,
} from '../../../shared/types/index.js';
import {
  AuthorizationDeniedError,
  InvariantViolationError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export type OutletPaymentMethod = 'OUTLET_CASH' | 'OUTLET_UPI' | 'OUTLET_CARD';

export interface SplitTenderItem {
  method: OutletPaymentMethod;
  amountPaise: Paise;
}

export interface SplitTenderCheckoutResult {
  appointmentId: string;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID';
  totalPaidPaise: Paise;
  outstandingBalancePaise: Paise;
  overpaymentAmountPaise: Paise;
  paymentIds: string[];
}

export interface CompleteAppointmentOptions {
  writeOff?: boolean;
  writeOffReason?: string;
}

export class OutletPaymentService {
  /**
   * Collects payment at the desk with split tender (e.g. ₹800 Cash + ₹1,200 UPI against a ₹2,000 bill).
   * Generates distinct payment records and immediate balanced double-entry ledger rows.
   */
  public static async collectSplitTender(
    client: pg.PoolClient,
    actor: ActorContext,
    branchId: BranchId,
    appointmentId: string,
    tenders: SplitTenderItem[],
    drawerSessionId?: string
  ): Promise<SplitTenderCheckoutResult> {
    const tenantId = actor.tenantId;

    if (!tenders || tenders.length === 0) {
      throw new InvariantViolationError('At least one tender item is required for checkout.');
    }

    // 1. Fetch current appointment financial state
    const apptRes = await client.query<{
      locked_price_paise: string;
      deposit_paid_paise: string;
      outstanding_balance_paise: string;
      payment_status: string;
      currency?: string;
    }>(
      `SELECT locked_price_paise, deposit_paid_paise, outstanding_balance_paise, payment_status
       FROM appointments WHERE tenant_id = $1 AND id = $2;`,
      [tenantId, appointmentId]
    );

    if (apptRes.rows.length === 0) {
      throw new EntityNotFoundError('Appointment', appointmentId);
    }

    const appt = apptRes.rows[0];
    const lockedPricePaise = BigInt(appt.locked_price_paise) as Paise;
    const previousDepositPaidPaise = BigInt(appt.deposit_paid_paise) as Paise;

    // Sum currently tendered amount
    let currentTenderTotal = 0n;
    for (const item of tenders) {
      if (item.amountPaise <= 0n) {
        throw new InvariantViolationError('Tender item amount must be greater than zero.');
      }
      currentTenderTotal += item.amountPaise;
    }

    // Calculate total collected across history and current checkout
    const newTotalPaid = (previousDepositPaidPaise + currentTenderTotal) as Paise;
    let paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID' = 'PARTIAL';
    let outstandingBalance = 0n as Paise;
    let overpaymentAmount = 0n as Paise;

    if (newTotalPaid > lockedPricePaise) {
      paymentStatus = 'OVERPAID';
      overpaymentAmount = (newTotalPaid - lockedPricePaise) as Paise;
      outstandingBalance = 0n as Paise;
    } else if (newTotalPaid === lockedPricePaise) {
      paymentStatus = 'PAID';
      outstandingBalance = 0n as Paise;
    } else {
      paymentStatus = 'PARTIAL';
      outstandingBalance = (lockedPricePaise - newTotalPaid) as Paise;
    }

    const paymentIds: string[] = [];

    // 2. Process each tender item with distinct payment and ledger rows
    for (const tender of tenders) {
      const idempotencyKey = `tender_${appointmentId}_${tender.method}_${crypto.randomBytes(6).toString('hex')}`;

      // Insert payment record
      const payRes = await client.query<{ id: string }>(
        `INSERT INTO payments (
          tenant_id, appointment_id, gateway, amount_paise, currency, status, idempotency_key
        ) VALUES ($1, $2, $3, $4, 'INR', 'PAID', $5)
        RETURNING id;`,
        [tenantId, appointmentId, tender.method, tender.amountPaise.toString(), idempotencyKey]
      );
      const paymentId = payRes.rows[0].id;
      paymentIds.push(paymentId);

      // Double-Entry Ledger Posting
      if (tender.method === 'OUTLET_CASH') {
        // Line 1: Debit Cash Drawer
        // Line 2: Credit Operating Revenue
        await client.query(
          `INSERT INTO ledger_entries (
            tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
          ) VALUES 
            ($1, $2, $3, 'DEBIT', 'CASH_DRAWER', $4, 'INR', 'Desk Cash Tender'),
            ($1, $2, $3, 'CREDIT', 'OPERATING_REVENUE', $4, 'INR', 'Desk Cash Tender');`,
          [tenantId, appointmentId, paymentId, tender.amountPaise.toString()]
        );

        if (drawerSessionId) {
          await client.query(
            `INSERT INTO desk_cash_payments (
              tenant_id, branch_id, drawer_session_id, appointment_id, amount_paise, collected_by_user_id
            ) VALUES ($1, $2, $3, $4, $5, $6);`,
            [tenantId, branchId, drawerSessionId, appointmentId, tender.amountPaise.toString(), actor.userId]
          );
        }
      } else {
        // Line 1: Debit Gateway Clearing
        // Line 2: Credit Operating Revenue
        await client.query(
          `INSERT INTO ledger_entries (
            tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
          ) VALUES 
            ($1, $2, $3, 'DEBIT', 'GATEWAY_CLEARING', $4, 'INR', 'Desk Digital Tender'),
            ($1, $2, $3, 'CREDIT', 'OPERATING_REVENUE', $4, 'INR', 'Desk Digital Tender');`,
          [tenantId, appointmentId, paymentId, tender.amountPaise.toString()]
        );
      }
    }

    // 3. Update Appointment financial status
    await client.query(
      `UPDATE appointments
       SET deposit_paid_paise = $1,
           outstanding_balance_paise = $2,
           payment_status = $3,
           overpayment_amount_paise = $4,
           updated_at = NOW()
       WHERE tenant_id = $5 AND id = $6;`,
      [
        newTotalPaid.toString(),
        outstandingBalance.toString(),
        paymentStatus,
        overpaymentAmount.toString(),
        tenantId,
        appointmentId,
      ]
    );

    // 4. Audit Log
    await AuditLogger.log(client, {
      tenantId,
      actorId: actor.userId,
      actorType: 'USER',
      role: actor.roles[0]?.role,
      action: 'payment:split_tender_checkout',
      resourceType: 'appointments',
      resourceId: appointmentId,
      diff: {
        tendersCount: tenders.length,
        totalPaidPaise: newTotalPaid.toString(),
        outstandingBalancePaise: outstandingBalance.toString(),
        overpaymentAmountPaise: overpaymentAmount.toString(),
        paymentStatus,
      },
      outcome: 'SUCCESS',
    });

    return {
      appointmentId,
      paymentStatus,
      totalPaidPaise: newTotalPaid,
      outstandingBalancePaise: outstandingBalance,
      overpaymentAmountPaise: overpaymentAmount,
      paymentIds,
    };
  }

  /**
   * Completes an appointment with strict balance and write-off governance.
   * If an outstanding balance remains, completion requires writeOff: true by an OWNER or BRANCH_MANAGER.
   */
  public static async completeAppointment(
    client: pg.PoolClient,
    actor: ActorContext,
    appointmentId: string,
    options?: CompleteAppointmentOptions
  ): Promise<{ appointmentId: string; status: string; wasWrittenOff: boolean }> {
    const tenantId = actor.tenantId;

    const apptRes = await client.query<{
      status: string;
      outstanding_balance_paise: string;
    }>(
      'SELECT status, outstanding_balance_paise FROM appointments WHERE tenant_id = $1 AND id = $2;',
      [tenantId, appointmentId]
    );

    if (apptRes.rows.length === 0) {
      throw new EntityNotFoundError('Appointment', appointmentId);
    }

    const appt = apptRes.rows[0];
    const outstandingPaise = BigInt(appt.outstanding_balance_paise) as Paise;

    // Invariant: Balance must be zero OR explicitly authorized write-off
    if (outstandingPaise > 0n) {
      if (!options?.writeOff) {
        throw new InvariantViolationError(
          `Cannot complete appointment with an outstanding balance of ₹${Number(outstandingPaise) / 100} without an approved write-off.`
        );
      }

      // RBAC: Restricted strictly to OWNER or BRANCH_MANAGER
      const isManagerOrOwner = actor.roles.some(
        (r) => r.role === 'OWNER' || r.role === 'BRANCH_MANAGER'
      );
      if (!isManagerOrOwner && !actor.isPlatformAdmin) {
        throw new AuthorizationDeniedError(
          'appointment:write_off',
          'Only Branch Managers or Owners are authorized to write off outstanding balances.'
        );
      }

      if (!options.writeOffReason || options.writeOffReason.trim().length === 0) {
        throw new InvariantViolationError('A non-empty reason is strictly required to write off a balance.');
      }

      // Adjusting Double-Entry for Bad Debt Expense:
      // Line 1: Debit BAD_DEBT_EXPENSE
      // Line 2: Credit ACCOUNTS_RECEIVABLE
      await client.query(
        `INSERT INTO ledger_entries (
          tenant_id, appointment_id, entry_type, account, amount_paise, currency, reason
        ) VALUES 
          ($1, $2, 'DEBIT', 'BAD_DEBT_EXPENSE', $3, 'INR', $4),
          ($1, $2, 'CREDIT', 'ACCOUNTS_RECEIVABLE', $3, 'INR', $4);`,
        [
          tenantId,
          appointmentId,
          outstandingPaise.toString(),
          `Manager Balance Write-Off: ${options.writeOffReason}`,
        ]
      );

      // Clear outstanding balance
      await client.query(
        `UPDATE appointments
         SET outstanding_balance_paise = 0,
             payment_status = 'PAID',
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2;`,
        [tenantId, appointmentId]
      );
    }

    // Update appointment status to COMPLETED
    await client.query(
      "UPDATE appointments SET status = 'COMPLETED', updated_at = NOW() WHERE tenant_id = $1 AND id = $2;",
      [tenantId, appointmentId]
    );

    await AuditLogger.log(client, {
      tenantId,
      actorId: actor.userId,
      actorType: 'USER',
      role: actor.roles[0]?.role,
      action: options?.writeOff ? 'appointment:complete_with_write_off' : 'appointment:complete',
      resourceType: 'appointments',
      resourceId: appointmentId,
      diff: {
        wasWrittenOff: !!options?.writeOff,
        writtenOffAmountPaise: options?.writeOff ? outstandingPaise.toString() : '0',
        reason: options?.writeOffReason || null,
      },
      outcome: 'SUCCESS',
    });

    return {
      appointmentId,
      status: 'COMPLETED',
      wasWrittenOff: !!options?.writeOff,
    };
  }

  /**
   * Corrects a mistaken outlet entry via append-only adjusting ledger rows.
   * (Direct UPDATE or DELETE on ledger_entries is prohibited by database triggers).
   */
  public static async createAdjustingEntry(
    client: pg.PoolClient,
    actor: ActorContext,
    appointmentId: string,
    mistakenPaymentId: string,
    reason: string,
    correctedTender?: SplitTenderItem
  ): Promise<{ reversingPaymentId: string; correctedPaymentId?: string }> {
    const tenantId = actor.tenantId;

    const payRes = await client.query<{
      amount_paise: string;
      gateway: string;
      status: string;
    }>(
      'SELECT amount_paise, gateway, status FROM payments WHERE tenant_id = $1 AND id = $2;',
      [tenantId, mistakenPaymentId]
    );

    if (payRes.rows.length === 0) {
      throw new EntityNotFoundError('Payment', mistakenPaymentId);
    }

    const pay = payRes.rows[0];
    const amountPaise = BigInt(pay.amount_paise) as Paise;

    // 1. Write exact reversing double-entry lines
    // Reversal: Credit Cash Drawer / Clearing, Debit Operating Revenue
    const clearingAccount = pay.gateway === 'OUTLET_CASH' ? 'CASH_DRAWER' : 'GATEWAY_CLEARING';

    await client.query(
      `INSERT INTO ledger_entries (
        tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
      ) VALUES 
        ($1, $2, $3, 'DEBIT', 'OPERATING_REVENUE', $4, 'INR', $5),
        ($1, $2, $3, 'CREDIT', $6, $4, 'INR', $5);`,
      [
        tenantId,
        appointmentId,
        mistakenPaymentId,
        amountPaise.toString(),
        `Correction Reversal: ${reason}`,
        clearingAccount,
      ]
    );

    // Mark mistaken payment as REFUNDED
    await client.query("UPDATE payments SET status = 'REFUNDED', updated_at = NOW() WHERE tenant_id = $1 AND id = $2;", [
      tenantId,
      mistakenPaymentId,
    ]);

    let correctedPaymentId: string | undefined;

    // 2. Post corrected entry if provided
    if (correctedTender) {
      const idempotencyKey = `adj_corr_${appointmentId}_${Date.now()}`;
      const corrRes = await client.query<{ id: string }>(
        `INSERT INTO payments (
          tenant_id, appointment_id, gateway, amount_paise, currency, status, idempotency_key
        ) VALUES ($1, $2, $3, $4, 'INR', 'PAID', $5)
        RETURNING id;`,
        [tenantId, appointmentId, correctedTender.method, correctedTender.amountPaise.toString(), idempotencyKey]
      );
      correctedPaymentId = corrRes.rows[0].id;

      const newClearingAccount = correctedTender.method === 'OUTLET_CASH' ? 'CASH_DRAWER' : 'GATEWAY_CLEARING';
      await client.query(
        `INSERT INTO ledger_entries (
          tenant_id, appointment_id, payment_id, entry_type, account, amount_paise, currency, reason
        ) VALUES 
          ($1, $2, $3, 'DEBIT', $6, $4, 'INR', $5),
          ($1, $2, $3, 'CREDIT', 'OPERATING_REVENUE', $4, 'INR', $5);`,
        [
          tenantId,
          appointmentId,
          correctedPaymentId,
          correctedTender.amountPaise.toString(),
          `Corrected Entry: ${reason}`,
          newClearingAccount,
        ]
      );
    }

    return {
      reversingPaymentId: mistakenPaymentId,
      correctedPaymentId,
    };
  }
}

