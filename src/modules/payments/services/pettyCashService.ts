// src/modules/payments/services/pettyCashService.ts
import pg from 'pg';
import {
  TenantId,
  BranchId,
  UserId,
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

export type VoucherCategory = 'REFRESHMENTS' | 'SUPPLIES' | 'ERRANDS' | 'MISC';

export interface OpenSessionInput {
  branchId: BranchId;
  openingFloatPaise: Paise;
}

export interface CreateVoucherInput {
  branchId: BranchId;
  drawerSessionId: string;
  amountPaise: Paise;
  category: VoucherCategory;
  paidToName: string;
  notes?: string;
}

export interface ReconcileSessionResult {
  sessionId: string;
  openingFloatPaise: Paise;
  totalCashCollectedPaise: Paise;
  totalVouchersPaise: Paise;
  expectedClosingPaise: Paise;
  closingCountedPaise: Paise;
  variancePaise: Paise;
  isBalanced: boolean;
}

export class PettyCashService {
  /**
   * Opens a new front-desk cash drawer session with an initial opening float.
   */
  public static async openDrawerSession(
    client: pg.PoolClient,
    actor: ActorContext,
    input: OpenSessionInput
  ): Promise<{ sessionId: string }> {
    const tenantId = actor.tenantId;

    // Check if an open session already exists for this branch
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM cash_drawer_sessions WHERE tenant_id = $1 AND branch_id = $2 AND status = 'OPEN';",
      [tenantId, input.branchId]
    );

    if (existing.rows.length > 0) {
      throw new InvariantViolationError('An open cash drawer session is already active for this branch.');
    }

    const res = await client.query<{ id: string }>(
      `INSERT INTO cash_drawer_sessions (
        tenant_id, branch_id, opened_by_user_id, opening_float_paise, status
      ) VALUES ($1, $2, $3, $4, 'OPEN')
      RETURNING id;`,
      [tenantId, input.branchId, actor.userId, input.openingFloatPaise.toString()]
    );

    const sessionId = res.rows[0].id;

    await AuditLogger.log(client, {
      tenantId,
      actorId: actor.userId,
      actorType: 'USER',
      role: actor.roles[0]?.role,
      action: 'cash_drawer:open',
      resourceType: 'cash_drawer_sessions',
      resourceId: sessionId,
      diff: { openingFloatPaise: input.openingFloatPaise.toString(), branchId: input.branchId },
      outcome: 'SUCCESS',
    });

    return { sessionId };
  }

  /**
   * Creates a provisional petty cash voucher (e.g. tea/refreshments, emergency supplies).
   * Callable by Front Desk Operator or Branch Manager during an active OPEN session.
   */
  public static async createVoucher(
    client: pg.PoolClient,
    actor: ActorContext,
    input: CreateVoucherInput
  ): Promise<{ voucherId: string; voucherNumber: string }> {
    const tenantId = actor.tenantId;

    if (input.amountPaise <= 0n) {
      throw new InvariantViolationError('Petty cash voucher amount must be greater than zero.');
    }

    // Verify session is active and OPEN
    const sessionRes = await client.query<{ status: string; id: string }>(
      'SELECT status, id FROM cash_drawer_sessions WHERE tenant_id = $1 AND id = $2;',
      [tenantId, input.drawerSessionId]
    );

    if (sessionRes.rows.length === 0) {
      throw new EntityNotFoundError('CashDrawerSession', input.drawerSessionId);
    }
    if (sessionRes.rows[0].status !== 'OPEN') {
      throw new InvariantViolationError('Vouchers can only be issued against an OPEN cash drawer session.');
    }

    // Generate deterministic voucher number
    const countRes = await client.query<{ count: string }>(
      'SELECT count(*) FROM petty_cash_vouchers WHERE tenant_id = $1 AND branch_id = $2;',
      [tenantId, input.branchId]
    );
    const voucherSeq = Number(countRes.rows[0].count) + 1;
    const voucherNumber = `VOUCH-${new Date().getFullYear()}-${voucherSeq.toString().padStart(4, '0')}`;

    const res = await client.query<{ id: string }>(
      `INSERT INTO petty_cash_vouchers (
        tenant_id, branch_id, drawer_session_id, issued_by_user_id,
        amount_paise, category, paid_to_name, notes, voucher_number, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PROVISIONAL')
      RETURNING id;`,
      [
        tenantId,
        input.branchId,
        input.drawerSessionId,
        actor.userId,
        input.amountPaise.toString(),
        input.category,
        input.paidToName,
        input.notes || null,
        voucherNumber,
      ]
    );

    const voucherId = res.rows[0].id;

    await AuditLogger.log(client, {
      tenantId,
      actorId: actor.userId,
      actorType: 'USER',
      role: actor.roles[0]?.role,
      action: 'petty_cash:issue_provisional',
      resourceType: 'petty_cash_vouchers',
      resourceId: voucherId,
      diff: {
        voucherNumber,
        category: input.category,
        amountPaise: input.amountPaise.toString(),
        paidToName: input.paidToName,
      },
      outcome: 'SUCCESS',
    });

    return { voucherId, voucherNumber };
  }

  /**
   * Records a cash payment received at the front desk for an appointment.
   */
  public static async recordCashPayment(
    client: pg.PoolClient,
    actor: ActorContext,
    branchId: BranchId,
    drawerSessionId: string,
    appointmentId: string,
    amountPaise: Paise
  ): Promise<{ paymentId: string }> {
    const tenantId = actor.tenantId;

    const res = await client.query<{ id: string }>(
      `INSERT INTO desk_cash_payments (
        tenant_id, branch_id, drawer_session_id, appointment_id, amount_paise, collected_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;`,
      [tenantId, branchId, drawerSessionId, appointmentId, amountPaise.toString(), actor.userId]
    );

    return { paymentId: res.rows[0].id };
  }

  /**
   * Reconciles and closes a cash drawer session.
   * Invariant: Callable strictly by BRANCH_MANAGER or OWNER. FRONT_DESK_OPERATOR throws AuthorizationDeniedError.
   */
  public static async reconcileSession(
    client: pg.PoolClient,
    actor: ActorContext,
    sessionId: string,
    closingCountedPaise: Paise
  ): Promise<ReconcileSessionResult> {
    const tenantId = actor.tenantId;

    // RBAC Enforcement: Strictly BRANCH_MANAGER or OWNER
    const isManagerOrOwner = actor.roles.some(
      (r) => r.role === 'OWNER' || r.role === 'BRANCH_MANAGER'
    );
    if (!isManagerOrOwner && !actor.isPlatformAdmin) {
      throw new AuthorizationDeniedError(
        'cash_drawer:reconcile',
        'Only Branch Managers or Owners are authorized to reconcile and close a cash drawer session.'
      );
    }

    const sessionRes = await client.query<{
      opening_float_paise: string;
      status: string;
      branch_id: string;
    }>(
      'SELECT opening_float_paise, status, branch_id FROM cash_drawer_sessions WHERE tenant_id = $1 AND id = $2;',
      [tenantId, sessionId]
    );

    if (sessionRes.rows.length === 0) {
      throw new EntityNotFoundError('CashDrawerSession', sessionId);
    }
    const session = sessionRes.rows[0];

    if (session.status === 'RECONCILED') {
      throw new InvariantViolationError('This cash drawer session has already been reconciled.');
    }

    const openingFloatPaise = BigInt(session.opening_float_paise) as Paise;

    // Sum Desk Cash Payments
    const paymentsRes = await client.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount_paise), 0) as total FROM desk_cash_payments WHERE tenant_id = $1 AND drawer_session_id = $2;',
      [tenantId, sessionId]
    );
    const totalCashCollectedPaise = BigInt(paymentsRes.rows[0].total) as Paise;

    // Sum Petty Cash Vouchers
    const vouchersRes = await client.query<{ total: string }>(
      "SELECT COALESCE(SUM(amount_paise), 0) as total FROM petty_cash_vouchers WHERE tenant_id = $1 AND drawer_session_id = $2 AND status IN ('PROVISIONAL', 'APPROVED');",
      [tenantId, sessionId]
    );
    const totalVouchersPaise = BigInt(vouchersRes.rows[0].total) as Paise;

    // Expected Closing Cash = Opening Float + Cash Payments - Vouchers
    const expectedClosingPaise = (openingFloatPaise + totalCashCollectedPaise - totalVouchersPaise) as Paise;
    const variancePaise = (closingCountedPaise - expectedClosingPaise) as Paise;
    const isBalanced = variancePaise === 0n;

    // Update Session status to RECONCILED and approve all provisional vouchers
    await client.query(
      `UPDATE cash_drawer_sessions
       SET closing_counted_paise = $1,
           variance_paise = $2,
           status = 'RECONCILED',
           closed_by_user_id = $3,
           closed_at = NOW(),
           reconciled_at = NOW()
       WHERE tenant_id = $4 AND id = $5;`,
      [closingCountedPaise.toString(), variancePaise.toString(), actor.userId, tenantId, sessionId]
    );

    await client.query(
      `UPDATE petty_cash_vouchers
       SET status = 'APPROVED',
           approved_by_user_id = $1,
           approved_at = NOW()
       WHERE tenant_id = $2 AND drawer_session_id = $3 AND status = 'PROVISIONAL';`,
      [actor.userId, tenantId, sessionId]
    );

    // Audit Log Entry
    await AuditLogger.log(client, {
      tenantId,
      actorId: actor.userId,
      actorType: 'USER',
      role: actor.roles[0]?.role,
      action: 'cash_drawer:reconcile',
      resourceType: 'cash_drawer_sessions',
      resourceId: sessionId,
      diff: {
        openingFloatPaise: openingFloatPaise.toString(),
        totalCashCollectedPaise: totalCashCollectedPaise.toString(),
        totalVouchersPaise: totalVouchersPaise.toString(),
        expectedClosingPaise: expectedClosingPaise.toString(),
        closingCountedPaise: closingCountedPaise.toString(),
        variancePaise: variancePaise.toString(),
        isBalanced,
      },
      outcome: 'SUCCESS',
    });

    return {
      sessionId,
      openingFloatPaise,
      totalCashCollectedPaise,
      totalVouchersPaise,
      expectedClosingPaise,
      closingCountedPaise,
      variancePaise,
      isBalanced,
    };
  }
}

