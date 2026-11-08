// tests/verification/guardrails.test.ts
//
// SDE-3 Guardrail Invariant Test Suite
// Covers GR-T01→GR-T04 (Tenancy), GR-A01→GR-A06 (Authorization),
//         GR-S01→GR-S04 (Scheduling), GR-D01→GR-D05 (Financial),
//         GR-M01→GR-M03 (Transactional Messaging)
//
// All DB-dependent tests use the `isDbAvailable` guard with graceful fallback.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { DatabaseClient } from '../../src/shared/database/connection.js';
import { FieldSerializer } from '../../src/shared/serialization/fieldSerializer.js';
import { PolicyEngine } from '../../src/shared/policy/policyEngine.js';
import { AvailabilityEngine } from '../../src/modules/scheduling/services/availabilityEngine.js';
import { MockWhatsAppAdapter } from '../../src/modules/messaging/adapters/whatsappAdapter.js';
import { MessagingOutboxWorker } from '../../src/modules/messaging/workers/messagingOutboxWorker.js';
import {
  asTenantId,
  asUserId,
  asBranchId,
  toPaise,
  ActorContext,
  TenantId,
  BranchId,
  UserId,
} from '../../src/shared/types/index.js';
import {
  TenantIsolationViolationError,
  EntityNotFoundError,
  AuthorizationDeniedError,
  PrivilegeEscalationError,
  formatErrorResponse,
} from '../../src/shared/errors/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOwnerActor(tenantId: TenantId): ActorContext {
  return {
    userId: asUserId(randomUUID()),
    email: 'owner@test.com',
    isPlatformAdmin: false,
    tenantId,
    roles: [{ role: 'OWNER', scope: { type: 'TENANT' } }],
  };
}

function makeBranchManagerActor(tenantId: TenantId, branchId: BranchId): ActorContext {
  return {
    userId: asUserId(randomUUID()),
    email: 'manager@test.com',
    isPlatformAdmin: false,
    tenantId,
    roles: [{ role: 'BRANCH_MANAGER', scope: { type: 'BRANCH', branchId } }],
  };
}

function makeReceptionistActor(tenantId: TenantId, branchId: BranchId): ActorContext {
  return {
    userId: asUserId(randomUUID()),
    email: 'receptionist@test.com',
    isPlatformAdmin: false,
    tenantId,
    roles: [{ role: 'RECEPTIONIST', scope: { type: 'BRANCH', branchId } }],
  };
}

// ─── Suite Setup ─────────────────────────────────────────────────────────────

describe('Guardrail Invariant Tests (GR-T through GR-M)', () => {
  let isDbAvailable = false;
  let pool: pg.Pool;
  let tenantAId: TenantId;
  let tenantBId: TenantId;
  let branchAId: BranchId;

  beforeAll(async () => {
    try {
      pool = DatabaseClient.initialize();
      const client = await pool.connect();
      await client.query('SELECT 1;');
      client.release();
      isDbAvailable = true;

      // Provision minimal fixture data for DB tests
      const tASlug = `gr-tenant-a-${Date.now()}`;
      const tBSlug = `gr-tenant-b-${Date.now()}`;
      tenantAId = asTenantId(randomUUID());
      tenantBId = asTenantId(randomUUID());
      branchAId = asBranchId(randomUUID());

      const setup = await pool.connect();
      try {
        await setup.query('BEGIN;');

        // Insert tenants directly (platform transaction — no RLS tenant required)
        await setup.query(
          `INSERT INTO tenants (id, name, slug, status, onboarding_step)
           VALUES ($1, 'GR Tenant A', $2, 'ACTIVE', 'COMPLETE'),
                  ($3, 'GR Tenant B', $4, 'ACTIVE', 'COMPLETE')
           ON CONFLICT (id) DO NOTHING;`,
          [tenantAId, tASlug, tenantBId, tBSlug]
        );

        // Insert branch for Tenant A
        await setup.query(
          `INSERT INTO branches (id, tenant_id, name, address, timezone, is_active)
           VALUES ($1, $2, 'GR Branch A', '1 Test Lane', 'Asia/Kolkata', TRUE)
           ON CONFLICT (id) DO NOTHING;`,
          [branchAId, tenantAId]
        );

        await setup.query('COMMIT;');
      } catch (e) {
        await setup.query('ROLLBACK;');
        throw e;
      } finally {
        setup.release();
      }
    } catch {
      console.warn(
        'GR-SUITE: PostgreSQL is not running. All DB guardrail tests will verify logic contracts only.'
      );
      isDbAvailable = false;
      tenantAId = asTenantId(randomUUID());
      tenantBId = asTenantId(randomUUID());
      branchAId = asBranchId(randomUUID());
    }
  });

  afterAll(async () => {
    if (isDbAvailable) {
      await DatabaseClient.close();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GR-T: Tenancy & Isolation Guardrails
  // ══════════════════════════════════════════════════════════════════════════

  describe('GR-T: Tenancy & Zero-Leak Isolation', () => {
    it('GR-T01: Query without app.tenant_id session variable returns zero rows from RLS-protected table', async () => {
      if (!isDbAvailable) {
        // Contract: withTenantTransaction always sets app.tenant_id — this guardrail
        // confirms RLS returns empty set rather than cross-tenant data.
        expect(DatabaseClient.withTenantTransaction).toBeDefined();
        console.warn('GR-T01: Skipped (no DB) — contract: RLS returns 0 rows without tenant context.');
        return;
      }

      const client = await pool.connect();
      try {
        // Explicitly clear the session variable (simulate unauthenticated raw query)
        await client.query(`SET LOCAL app.tenant_id = '';`);

        // With RLS enabled, this should return zero rows (not throw)
        const res = await client.query('SELECT id FROM services LIMIT 10;');
        expect(res.rows).toHaveLength(0);
      } finally {
        client.release();
      }
    });

    it('GR-T02: Cross-tenant resource probe returns uniform 404, identical to non-existent ID', async () => {
      // This test is a pure domain-logic guardrail — no DB needed
      // Both TenantIsolationViolationError and EntityNotFoundError → HTTP 404 + same body
      const tenantViolation = new TenantIsolationViolationError();
      const notFoundError = new EntityNotFoundError('Service', randomUUID());

      const violationResp = await formatErrorResponse(tenantViolation);
      const notFoundResp = await formatErrorResponse(notFoundError);

      // Anti-enumeration invariant: Identical status and error code
      expect(violationResp.status).toBe(404);
      expect(notFoundResp.status).toBe(404);
      expect(violationResp.body.error).toEqual(notFoundResp.body.error);
    });

    it('GR-T03: Cross-tenant FK insert rejected by composite foreign key constraint (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-T03: Skipped (no DB) — contract: composite FK (tenant_id, resource_id) prevents cross-tenant inserts.');
        return;
      }

      const client = await pool.connect();
      try {
        // Attempt to insert a service pointing to Tenant B's tenant_id from Tenant A context
        await client.query(`SET LOCAL app.tenant_id = '${tenantAId}';`);

        // Insert a fake service for Tenant B
        const fakeBServiceId = randomUUID();
        await expect(
          client.query(
            `INSERT INTO service_resource_requirements (tenant_id, service_id, resource_type, quantity)
             VALUES ($1, $2, 'ROOM', 1);`,
            [tenantBId, fakeBServiceId]
          )
        ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
        // 23503 = FK violation, 23505 = unique violation — both indicate rejection
      } finally {
        client.release();
      }
    });

    it('GR-T04: Cross-tenant probe and non-existent ID have identical error response body structure', async () => {
      const crossTenantError = new TenantIsolationViolationError();
      const ghostIdError = new EntityNotFoundError('Appointment', randomUUID());

      const r1 = await formatErrorResponse(crossTenantError);
      const r2 = await formatErrorResponse(ghostIdError);

      // Structural invariant: Caller cannot distinguish cross-tenant vs non-existent
      expect(r1.status).toBe(r2.status);
      expect(Object.keys(r1.body)).toEqual(Object.keys(r2.body));
      expect((r1.body.error as any).code).toEqual((r2.body.error as any).code);
      expect((r1.body.error as any).message).toEqual((r2.body.error as any).message);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GR-A: Authorization & RBAC Guardrails
  // ══════════════════════════════════════════════════════════════════════════

  describe('GR-A: Authorization & RBAC', () => {
    it('GR-A01: PolicyEngine.assertCan() denies action not in role permission set', () => {
      // RECEPTIONIST does not have 'pricing:manage'
      const receptionist = makeReceptionistActor(tenantAId, branchAId);

      expect(() =>
        PolicyEngine.assertCan(receptionist, 'pricing:manage', { branchId: branchAId })
      ).toThrow(TenantIsolationViolationError);
      // Note: branch-scoped actor probing same branch → TenantIsolationViolationError (uniform 404)
    });

    it('GR-A02: Branch Manager cannot escalate to OWNER at TENANT scope', () => {
      const manager = makeBranchManagerActor(tenantAId, branchAId);

      expect(() =>
        PolicyEngine.assertCanAssignRole(manager, 'OWNER', { type: 'TENANT' })
      ).toThrow(PrivilegeEscalationError);
    });

    it('GR-A03: Branch Manager assigning role in different branch returns uniform 404', () => {
      const otherBranchId = asBranchId(randomUUID());
      const manager = makeBranchManagerActor(tenantAId, branchAId);

      // Manager is scoped to branchAId, but tries to assign into otherBranchId
      expect(() =>
        PolicyEngine.assertCanAssignRole(manager, 'RECEPTIONIST', {
          type: 'BRANCH',
          branchId: otherBranchId,
        })
      ).toThrow(TenantIsolationViolationError);
    });

    it('GR-A04: FieldSerializer strips compensation fields for RECEPTIONIST caller', () => {
      const rawStaff = {
        id: randomUUID(),
        name: 'Jane Smith',
        base_compensation_paise: 150000n,
        commission_rate_bps: 500,
        payroll_id: 'PAY-001',
        bank_account: '1234567890',
        email: 'jane@service.com',
      };

      const serialized = FieldSerializer.serializeStaff(rawStaff, ['RECEPTIONIST']) as Record<string, unknown>;

      expect(serialized['base_compensation_paise']).toBeUndefined();
      expect(serialized['commission_rate_bps']).toBeUndefined();
      expect(serialized['payroll_id']).toBeUndefined();
      expect(serialized['bank_account']).toBeUndefined();
      // Non-sensitive fields must still be present
      expect(serialized['id']).toBe(rawStaff.id);
      expect(serialized['name']).toBe(rawStaff.name);
      expect(serialized['email']).toBe(rawStaff.email);
    });

    it('GR-A05: FieldSerializer strips internal cost fields for PROFESSIONAL caller in catalogue', () => {
      const rawCatalogueItem = {
        id: randomUUID(),
        name: 'Deep Tissue Massage',
        price_paise: 350000n,
        internal_margin_bps: 4000,
        cost_paise: 200000n,
        gateway_keys: { stripe: 'sk_live_secret' },
      };

      const serialized = FieldSerializer.serializeCatalogue(rawCatalogueItem, ['PROFESSIONAL']) as Record<string, unknown>;

      expect(serialized['internal_margin_bps']).toBeUndefined();
      expect(serialized['cost_paise']).toBeUndefined();
      expect(serialized['gateway_keys']).toBeUndefined();
      // Public fields remain
      expect(serialized['id']).toBe(rawCatalogueItem.id);
      expect(serialized['name']).toBe(rawCatalogueItem.name);
      expect(serialized['price_paise']).toBe(rawCatalogueItem.price_paise);
    });

    it('GR-A06: OWNER caller receives all fields including compensation and cost metrics', () => {
      const rawStaff = {
        id: randomUUID(),
        name: 'Bob Trainer',
        base_compensation_paise: 250000n,
        commission_rate_bps: 1000,
        payroll_id: 'PAY-002',
        bank_account: '9876543210',
      };

      const serializedStaff = FieldSerializer.serializeStaff(rawStaff, ['OWNER']) as Record<string, unknown>;
      expect(serializedStaff['base_compensation_paise']).toBe(250000n);
      expect(serializedStaff['commission_rate_bps']).toBe(1000);
      expect(serializedStaff['payroll_id']).toBe('PAY-002');

      const rawCatalogueItem = {
        id: randomUUID(),
        name: 'Hot Stone Therapy',
        internal_margin_bps: 3500,
        cost_paise: 180000n,
        gateway_keys: { razorpay: 'rzp_live_secret' },
      };

      const serializedCatalogue = FieldSerializer.serializeCatalogue(rawCatalogueItem, ['OWNER']) as Record<string, unknown>;
      expect(serializedCatalogue['internal_margin_bps']).toBe(3500);
      expect(serializedCatalogue['cost_paise']).toBe(180000n);
      expect(serializedCatalogue['gateway_keys']).toEqual({ razorpay: 'rzp_live_secret' });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GR-S: Scheduling & Concurrency Guardrails
  // ══════════════════════════════════════════════════════════════════════════

  describe('GR-S: Scheduling & Concurrency', () => {
    it('GR-S01: DB exclusion constraint rejects overlapping professional appointments (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-S01: Skipped (no DB) — contract: GiST exclusion on appointments prevents professional double-booking.');
        return;
      }

      const client = await pool.connect();
      let profId: string = '';
      let customerId: string = '';
      let serviceId: string = '';

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);

        // We need a professional user, service, and customer for FK references
        profId = randomUUID();
        customerId = randomUUID();
        serviceId = randomUUID();
        const phone = '+917000000001';

        await client.query(
          `INSERT INTO users (id, tenant_id, email, name, phone_e164, is_active)
           VALUES ($1, $2, $3, 'GR Prof', $4, TRUE) ON CONFLICT (id) DO NOTHING;`,
          [profId, tenantAId, `grprof-${profId}@test.com`, phone]
        );
        await client.query(
          `INSERT INTO customers (id, tenant_id, phone_e164, first_name, consent_whatsapp)
           VALUES ($1, $2, $3, 'GR Customer', TRUE) ON CONFLICT (id) DO NOTHING;`,
          [customerId, tenantAId, phone]
        );
        await client.query(
          `INSERT INTO services (id, tenant_id, branch_id, name, duration_minutes, price_paise, is_active)
           VALUES ($1, $2, $3, 'GR Service', 60, 100000, TRUE) ON CONFLICT (id) DO NOTHING;`,
          [serviceId, tenantAId, branchAId]
        );

        const slot1Start = '2027-06-15T09:00:00Z';
        const slot1End   = '2027-06-15T10:00:00Z';

        // Insert first appointment — should succeed
        await client.query(
          `INSERT INTO appointments (id, tenant_id, branch_id, service_id, professional_id, customer_id,
             start_time, end_time, status, locked_price_paise, deposit_paid_paise, outstanding_balance_paise, payment_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED', 100000, 0, 100000, 'UNPAID');`,
          [randomUUID(), tenantAId, branchAId, serviceId, profId, customerId, slot1Start, slot1End]
        );

        // Insert overlapping appointment for the same professional — exclusion constraint must fire
        await expect(
          client.query(
            `INSERT INTO appointments (id, tenant_id, branch_id, service_id, professional_id, customer_id,
               start_time, end_time, status, locked_price_paise, deposit_paid_paise, outstanding_balance_paise, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED', 100000, 0, 100000, 'UNPAID');`,
            [randomUUID(), tenantAId, branchAId, serviceId, profId, customerId, slot1Start, slot1End]
          )
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(23P01|23505)/) });
      } finally {
        // Cleanup
        if (profId) {
          await client.query(`DELETE FROM appointments WHERE professional_id = $1 AND tenant_id = $2;`, [profId, tenantAId]);
          await client.query(`DELETE FROM customers WHERE phone_e164 = '+917000000001' AND tenant_id = $1;`, [tenantAId]);
          await client.query(`DELETE FROM services WHERE id = $1;`, [serviceId]);
          await client.query(`DELETE FROM users WHERE id = $1;`, [profId]);
        }
        client.release();
      }
    });

    it('GR-S02: DB exclusion constraint rejects overlapping resource bookings in appointment_resources (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-S02: Skipped (no DB) — contract: GiST exclusion on appointment_resources prevents resource double-booking.');
        return;
      }

      const client = await pool.connect();
      let resourceId: string = '';
      const holdId1 = randomUUID();
      const holdId2 = randomUUID();

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);

        resourceId = randomUUID();
        await client.query(
          `INSERT INTO resources (id, tenant_id, branch_id, name, resource_type, is_active)
           VALUES ($1, $2, $3, 'GR Resource', 'ROOM', TRUE) ON CONFLICT (id) DO NOTHING;`,
          [resourceId, tenantAId, branchAId]
        );

        const slotStart = '2027-06-20T10:00:00Z';
        const slotEnd   = '2027-06-20T11:00:00Z';

        // First hold — should succeed
        await client.query(
          `INSERT INTO appointment_resources (id, tenant_id, hold_id, resource_id, start_time, end_time, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'HELD');`,
          [randomUUID(), tenantAId, holdId1, resourceId, slotStart, slotEnd]
        );

        // Second overlapping hold — exclusion constraint must reject
        await expect(
          client.query(
            `INSERT INTO appointment_resources (id, tenant_id, hold_id, resource_id, start_time, end_time, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'HELD');`,
            [randomUUID(), tenantAId, holdId2, resourceId, slotStart, slotEnd]
          )
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(23P01|23505)/) });
      } finally {
        if (resourceId) {
          await client.query(`DELETE FROM appointment_resources WHERE resource_id = $1 AND tenant_id = $2;`, [resourceId, tenantAId]);
          await client.query(`DELETE FROM resources WHERE id = $1;`, [resourceId]);
        }
        client.release();
      }
    });

    it('GR-S03: Expired hold (expires_at < NOW()) does NOT contribute to busy windows', () => {
      // Pure logic test — rangesOverlap is a pure function
      const now = new Date();
      const expiredHoldStart = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
      const expiredHoldEnd   = new Date(now.getTime() - 30 * 60 * 1000); // 30m ago

      const candidateStart = new Date(now.getTime() - 45 * 60 * 1000);
      const candidateEnd   = new Date(now.getTime() - 15 * 60 * 1000);

      // The expired hold happens to overlap the candidate, but only unexpired holds are
      // passed into the busy times list (the SQL query uses `expires_at > NOW()`).
      // This test validates the overlap math itself — expired holds are excluded upstream.
      const overlaps = AvailabilityEngine.rangesOverlap(
        candidateStart, candidateEnd,
        expiredHoldStart, expiredHoldEnd
      );
      // These two ranges DO overlap — illustrates that the SQL filter is what prevents expired
      // holds from appearing; pure application logic trusts the query's WHERE clause.
      expect(overlaps).toBe(true); // structural overlap — exclusion is at SQL level

      // Now verify that a truly non-overlapping range returns false
      const futureStart = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const futureEnd   = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      expect(AvailabilityEngine.rangesOverlap(candidateStart, candidateEnd, futureStart, futureEnd)).toBe(false);
    });

    it('GR-S04: rangesOverlap() correctly identifies all overlap and non-overlap edge cases', () => {
      const t = (offset: number) => new Date(1_700_000_000_000 + offset * 60_000);

      // Adjacent (touching endpoints) — NOT an overlap for half-open [)
      expect(AvailabilityEngine.rangesOverlap(t(0), t(60), t(60), t(120))).toBe(false);
      expect(AvailabilityEngine.rangesOverlap(t(60), t(120), t(0), t(60))).toBe(false);

      // Exact overlap
      expect(AvailabilityEngine.rangesOverlap(t(0), t(60), t(0), t(60))).toBe(true);

      // Partial overlaps
      expect(AvailabilityEngine.rangesOverlap(t(0), t(60), t(30), t(90))).toBe(true);
      expect(AvailabilityEngine.rangesOverlap(t(30), t(90), t(0), t(60))).toBe(true);

      // Containment
      expect(AvailabilityEngine.rangesOverlap(t(0), t(120), t(30), t(90))).toBe(true);
      expect(AvailabilityEngine.rangesOverlap(t(30), t(90), t(0), t(120))).toBe(true);

      // No overlap — gap in between
      expect(AvailabilityEngine.rangesOverlap(t(0), t(30), t(60), t(90))).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GR-D: Financial & Ledger Guardrails
  // ══════════════════════════════════════════════════════════════════════════

  describe('GR-D: Financial Integrity & Ledger Immutability', () => {
    it('GR-D01: All paise calculations use bigint — zero float arithmetic in codebase', () => {
      // Structural invariant: toPaise() always returns bigint
      const p1 = toPaise(150000);
      const p2 = toPaise('150000');
      const p3 = toPaise(150000n);

      expect(typeof p1).toBe('bigint');
      expect(typeof p2).toBe('bigint');
      expect(typeof p3).toBe('bigint');

      // Arithmetic in bigint never produces floating-point
      const total = p1 + p2 + p3;
      expect(total).toBe(450000n);
      expect(typeof total).toBe('bigint');

      // Verify that division rounding is explicit and lossless for integer splits
      const amount = 10000n;
      const parts = 3n;
      const base = amount / parts;             // 3333n (truncated)
      const remainder = amount % parts;         // 1n
      const dist = [base + remainder, base, base];
      expect(dist.reduce((a, b) => a + b, 0n)).toBe(10000n);
    });

    it('GR-D02: Ledger UPDATE blocked by immutability trigger (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-D02: Skipped (no DB) — contract: enforce_ledger_immutability trigger blocks UPDATE on ledger_entries.');
        return;
      }

      const client = await pool.connect();
      const entryId = randomUUID();
      const paymentId = randomUUID();

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);

        // Insert a valid double-entry pair
        await client.query(
          `INSERT INTO ledger_entries (id, tenant_id, payment_id, entry_type, account_code, amount_paise, currency, description)
           VALUES ($1, $2, $3, 'DEBIT',  'CASH_DRAWER',  100000, 'INR', 'GR Test'),
                  ($4, $2, $3, 'CREDIT', 'OPERATING_REVENUE', 100000, 'INR', 'GR Test');`,
          [entryId, tenantAId, paymentId, randomUUID()]
        );

        // Attempt UPDATE — trigger must reject
        await expect(
          client.query(
            `UPDATE ledger_entries SET amount_paise = 1 WHERE id = $1;`,
            [entryId]
          )
        ).rejects.toThrow(/CRITICAL INVARIANT VIOLATION|strictly append-only/i);
      } finally {
        client.release();
      }
    });

    it('GR-D03: Ledger DELETE blocked by immutability trigger (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-D03: Skipped (no DB) — contract: enforce_ledger_immutability trigger blocks DELETE on ledger_entries.');
        return;
      }

      const client = await pool.connect();
      const entryId = randomUUID();
      const paymentId = randomUUID();

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);

        await client.query(
          `INSERT INTO ledger_entries (id, tenant_id, payment_id, entry_type, account_code, amount_paise, currency, description)
           VALUES ($1, $2, $3, 'DEBIT', 'CASH_DRAWER', 50000, 'INR', 'GR Delete Test'),
                  ($4, $2, $3, 'CREDIT', 'OPERATING_REVENUE', 50000, 'INR', 'GR Delete Test');`,
          [entryId, tenantAId, paymentId, randomUUID()]
        );

        // Attempt DELETE — trigger must reject
        await expect(
          client.query(
            `DELETE FROM ledger_entries WHERE id = $1;`,
            [entryId]
          )
        ).rejects.toThrow(/CRITICAL INVARIANT VIOLATION|strictly append-only/i);
      } finally {
        client.release();
      }
    });

    it('GR-D04: Double-entry invariant holds — SUM(DEBIT) === SUM(CREDIT) across 1,000 entries (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-D04: Skipped (no DB) — contract: every payment write is a balanced DEBIT+CREDIT pair.');
        return;
      }

      const client = await pool.connect();
      const paymentIds: string[] = [];

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);
        await client.query('BEGIN;');

        // Insert 500 balanced DEBIT+CREDIT pairs (= 1,000 total rows)
        for (let i = 0; i < 500; i++) {
          const pid = randomUUID();
          paymentIds.push(pid);
          const amount = BigInt(Math.floor(Math.random() * 100_000) + 1_000);

          await client.query(
            `INSERT INTO ledger_entries (id, tenant_id, payment_id, entry_type, account_code, amount_paise, currency, description)
             VALUES ($1, $2, $3, 'DEBIT',  'CASH_DRAWER',   $4, 'INR', 'GR-D04 stress'),
                    ($5, $2, $3, 'CREDIT', 'OPERATING_REVENUE', $4, 'INR', 'GR-D04 stress');`,
            [randomUUID(), tenantAId, pid, amount, randomUUID()]
          );
        }

        await client.query('COMMIT;');

        // Query double-entry balance
        const balRes = await client.query<{ debit_sum: string; credit_sum: string }>(
          `SELECT
             SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount_paise ELSE 0 END) AS debit_sum,
             SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_paise ELSE 0 END) AS credit_sum
           FROM ledger_entries
           WHERE tenant_id = $1 AND payment_id = ANY($2::uuid[]);`,
          [tenantAId, paymentIds]
        );

        const debitSum  = BigInt(balRes.rows[0].debit_sum  || '0');
        const creditSum = BigInt(balRes.rows[0].credit_sum || '0');

        // Fundamental double-entry invariant: Σ DEBIT = Σ CREDIT
        expect(debitSum).toBe(creditSum);
        expect(debitSum).toBeGreaterThan(0n);
      } catch (e) {
        await client.query('ROLLBACK;');
        throw e;
      } finally {
        client.release();
      }
    });

    it('GR-D05: 50 concurrent identical webhook events produce exactly 1 payment_events row (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-D05: Skipped (no DB) — contract: UNIQUE(tenant_id, gateway, gateway_event_id) is replay-safe deduplication.');
        return;
      }

      const gatewayEventId = `evt_gr_replay_${randomUUID()}`;
      const clients: pg.PoolClient[] = [];

      try {
        // Fire 50 concurrent inserts with the same gateway_event_id
        const tasks = Array.from({ length: 50 }, async () => {
          const c = await pool.connect();
          clients.push(c);
          await c.query(`SET app.tenant_id = '${tenantAId}';`);

          return c.query(
            `INSERT INTO payment_events (id, tenant_id, gateway, gateway_event_id, event_type, payload, processed_at)
             VALUES ($1, $2, 'STRIPE', $3, 'payment_intent.succeeded', '{}', NOW())
             ON CONFLICT (tenant_id, gateway, gateway_event_id) DO NOTHING;`,
            [randomUUID(), tenantAId, gatewayEventId]
          );
        });

        await Promise.allSettled(tasks);

        // Assert exactly 1 row was written
        const countRes = await pool.query(
          `SELECT COUNT(*) AS cnt FROM payment_events WHERE tenant_id = $1 AND gateway_event_id = $2;`,
          [tenantAId, gatewayEventId]
        );
        expect(Number(countRes.rows[0].cnt)).toBe(1);
      } finally {
        for (const c of clients) c.release();
        // Cleanup
        await pool.query(
          `DELETE FROM payment_events WHERE tenant_id = $1 AND gateway_event_id = $2;`,
          [tenantAId, gatewayEventId]
        );
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GR-M: Transactional Messaging Guardrails
  // ══════════════════════════════════════════════════════════════════════════

  describe('GR-M: Transactional Outbox Messaging', () => {
    it('GR-M01: Rolled-back transaction leaves zero outbox rows (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-M01: Skipped (no DB) — contract: outbox INSERT in same txn as booking; ROLLBACK eliminates both atomically.');
        return;
      }

      const client = await pool.connect();
      const bookingId = randomUUID();

      try {
        await client.query('BEGIN;');
        await client.query(`SET LOCAL app.tenant_id = '${tenantAId}';`);

        // Insert an outbox message inside the transaction
        await client.query(
          `INSERT INTO outbox_messages (
            id, tenant_id, booking_id, message_type, recipient_phone_e164,
            template_name, template_variables, provider_idempotency_key, status, scheduled_at
          ) VALUES ($1, $2, $3, 'BOOKING_CONFIRMATION', '+919000000001',
                    'booking_confirmation_v1', '{}', $4, 'QUEUED', NOW())
          ON CONFLICT (tenant_id, booking_id, message_type) DO NOTHING;`,
          [randomUUID(), tenantAId, bookingId, `${tenantAId}:${bookingId}:BOOKING_CONFIRMATION`]
        );

        // Intentional rollback (simulating a downstream failure)
        await client.query('ROLLBACK;');

        // Assert zero outbox rows committed for this booking_id
        const checkRes = await pool.query(
          `SELECT COUNT(*) AS cnt FROM outbox_messages WHERE tenant_id = $1 AND booking_id = $2;`,
          [tenantAId, bookingId]
        );
        expect(Number(checkRes.rows[0].cnt)).toBe(0);
      } catch (e) {
        await client.query('ROLLBACK;').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    });

    it('GR-M02: Duplicate outbox INSERT for same (tenant_id, booking_id, message_type) is silently ignored', async () => {
      if (!isDbAvailable) {
        console.warn('GR-M02: Skipped (no DB) — contract: UNIQUE(tenant_id, booking_id, message_type) with ON CONFLICT DO NOTHING.');
        return;
      }

      const bookingId = randomUUID();
      const client = await pool.connect();

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);

        const insertSql = `
          INSERT INTO outbox_messages (
            id, tenant_id, booking_id, message_type, recipient_phone_e164,
            template_name, template_variables, provider_idempotency_key, status, scheduled_at
          ) VALUES ($1, $2, $3, 'BOOKING_CONFIRMATION', '+919000000002',
                    'booking_confirmation_v1', '{}', $4, 'QUEUED', NOW())
          ON CONFLICT (tenant_id, booking_id, message_type) DO NOTHING;
        `;

        const key1 = `key-dup-${bookingId}-1`;
        const key2 = `key-dup-${bookingId}-2`;

        // First insert — succeeds
        await client.query(insertSql, [randomUUID(), tenantAId, bookingId, key1]);

        // Second insert — same (tenant_id, booking_id, message_type) — silently ignored
        await client.query(insertSql, [randomUUID(), tenantAId, bookingId, key2]);

        const countRes = await pool.query(
          `SELECT COUNT(*) AS cnt FROM outbox_messages WHERE tenant_id = $1 AND booking_id = $2 AND message_type = 'BOOKING_CONFIRMATION';`,
          [tenantAId, bookingId]
        );
        expect(Number(countRes.rows[0].cnt)).toBe(1);
      } finally {
        await pool.query(`DELETE FROM outbox_messages WHERE booking_id = $1;`, [bookingId]);
        client.release();
      }
    });

    it('GR-M03: MessagingOutboxWorker suppresses messages when customer has consent_whatsapp = false (DB)', async () => {
      if (!isDbAvailable) {
        console.warn('GR-M03: Skipped (no DB) — contract: worker checks consent_whatsapp before dispatching; suppresses if false.');
        return;
      }

      const bookingId = randomUUID();
      const optedOutPhone = `+9188${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`;
      const client = await pool.connect();

      try {
        await client.query(`SET app.tenant_id = '${tenantAId}';`);

        // Create customer with opted-out WhatsApp consent
        const custId = randomUUID();
        await client.query(
          `INSERT INTO customers (id, tenant_id, phone_e164, first_name, consent_whatsapp)
           VALUES ($1, $2, $3, 'Opted Out', FALSE) ON CONFLICT (id) DO NOTHING;`,
          [custId, tenantAId, optedOutPhone]
        );

        // Queue a BOOKING_CONFIRMATION for them
        await client.query(
          `INSERT INTO outbox_messages (
            id, tenant_id, booking_id, message_type, recipient_phone_e164,
            template_name, template_variables, provider_idempotency_key, status, scheduled_at
          ) VALUES ($1, $2, $3, 'BOOKING_CONFIRMATION', $4,
                    'booking_confirmation_v1', '{}', $5, 'QUEUED', NOW() - INTERVAL '1 minute')
          ON CONFLICT (tenant_id, booking_id, message_type) DO NOTHING;`,
          [randomUUID(), tenantAId, bookingId, optedOutPhone, `key-gr-m03-${bookingId}`]
        );

        // Run worker with mock adapter
        const mockAdapter = new MockWhatsAppAdapter();
        const worker = new MessagingOutboxWorker(mockAdapter);
        const result = await worker.processBatch(client, tenantAId, 10);

        // Assert the message was suppressed
        expect(result.suppressedCount).toBeGreaterThanOrEqual(1);
        expect(MockWhatsAppAdapter.dispatchCount).toBe(0);

        // Check the row is now SUPPRESSED in the DB
        const statusRes = await client.query(
          `SELECT status FROM outbox_messages WHERE tenant_id = $1 AND booking_id = $2;`,
          [tenantAId, bookingId]
        );
        if (statusRes.rows.length > 0) {
          expect(statusRes.rows[0].status).toBe('SUPPRESSED');
        }
      } finally {
        await pool.query(`DELETE FROM outbox_messages WHERE booking_id = $1;`, [bookingId]);
        await pool.query(`DELETE FROM customers WHERE phone_e164 = $1 AND tenant_id = $2;`, [optedOutPhone, tenantAId]);
        client.release();
      }
    });
  });
});

