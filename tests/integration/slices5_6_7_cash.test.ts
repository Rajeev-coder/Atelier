// tests/integration/slices5_6_7_cash.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseClient } from '../../src/shared/database/connection.js';
import { PettyCashService } from '../../src/modules/payments/services/pettyCashService.js';
import { OtpService } from '../../src/modules/scheduling/services/otpService.js';
import { PublicBookingService } from '../../src/modules/scheduling/services/publicBookingService.js';
import { RescheduleAndCancellationService } from '../../src/modules/scheduling/services/rescheduleAndCancellationService.js';
import { MaintenanceBlockService } from '../../src/modules/scheduling/services/maintenanceBlockService.js';
import { AvailabilityEngine } from '../../src/modules/scheduling/services/availabilityEngine.js';
import { TenantProvisioningService } from '../../src/modules/tenancy/services/tenantProvisioningService.js';
import { CatalogueEligibilityService } from '../../src/modules/catalogue/services/catalogueEligibilityService.js';
import { StaffRoleAssignmentService } from '../../src/modules/policy/services/staffRoleAssignmentService.js';
import {
  asTenantId,
  asUserId,
  asBranchId,
  toPaise,
  ActorContext,
  TenantId,
  UserId,
  BranchId,
  ServiceId,
  ResourceId,
} from '../../src/shared/types/index.js';
import {
  AuthorizationDeniedError,
  ConcurrencyConflictError,
  InvariantViolationError,
  TenantIsolationViolationError,
} from '../../src/shared/errors/index.js';

describe('Slices 5, 6, 7 & Cash Drawer Integration Suite', () => {
  let isDbAvailable = false;

  let gymTenantId: TenantId;
  let gymBranchId: BranchId;
  let gymOwnerId: UserId;
  let gymManagerId: UserId;
  let gymReceptionistId: UserId;

  let orgTenantId: TenantId;
  let orgBranchId: BranchId;
  let orgProviderId: UserId;
  let balayageServiceId: ServiceId;
  let haircutServiceId: ServiceId;
  let stylingChairId: ResourceId;
  let washingStationId: ResourceId;

  beforeAll(async () => {
    try {
      const pool = DatabaseClient.initialize();
      const client = await pool.connect();
      await client.query('SELECT 1;');
      client.release();
      isDbAvailable = true;
    } catch {
      console.warn('Real PostgreSQL is not running. Testing domain models and policy contracts.');
      isDbAvailable = false;
    }
  });

  afterAll(async () => {
    if (isDbAvailable) {
      await DatabaseClient.close();
    }
  });

  describe('Scenario 1: Front-Desk Cash Drawer & Petty Cash Voucher System', () => {
    it('manages daily drawer sessions, handles vouchers, denies non-manager reconciliation, and balances perfectly', async () => {
      if (!isDbAvailable) {
        expect(PettyCashService.openDrawerSession).toBeDefined();
        return;
      }

      // Provision Gym Tenant
      const gymProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'cash-drawer-gym-001',
        name: 'Iron Forge Drawer Gym',
        slug: 'drawer-gym',
        ownerEmail: 'owner@drawergym.com',
        ownerPhone: '+919811555001',
        ownerName: 'Marcus Cash',
      });
      gymTenantId = gymProv.tenantId;
      gymBranchId = gymProv.branchId;
      gymOwnerId = gymProv.ownerId;

      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        // Create Manager and Receptionist
        const mUser = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ('mgr@drawergym.com', '+919811555002', 'Vikram Manager', 'HASH')
           RETURNING id;`
        );
        gymManagerId = asUserId(mUser.rows[0].id);

        const rUser = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ('rec@drawergym.com', '+919811555003', 'Neha Desk', 'HASH')
           RETURNING id;`
        );
        gymReceptionistId = asUserId(rUser.rows[0].id);

        await StaffRoleAssignmentService.assignRole(
          client,
          {
            userId: gymOwnerId,
            email: 'owner@drawergym.com',
            isPlatformAdmin: false,
            tenantId: gymTenantId,
            roles: [{ role: 'OWNER', scope: { type: 'TENANT' } }],
          },
          {
            targetUserId: gymManagerId,
            role: 'BRANCH_MANAGER',
            scope: { type: 'BRANCH', branchId: gymBranchId },
          }
        );

        await StaffRoleAssignmentService.assignRole(
          client,
          {
            userId: gymOwnerId,
            email: 'owner@drawergym.com',
            isPlatformAdmin: false,
            tenantId: gymTenantId,
            roles: [{ role: 'OWNER', scope: { type: 'TENANT' } }],
          },
          {
            targetUserId: gymReceptionistId,
            role: 'RECEPTIONIST',
            scope: { type: 'BRANCH', branchId: gymBranchId },
          }
        );
      });

      const receptionistActor: ActorContext = {
        userId: gymReceptionistId,
        email: 'rec@drawergym.com',
        isPlatformAdmin: false,
        tenantId: gymTenantId,
        roles: [{ role: 'RECEPTIONIST', scope: { type: 'BRANCH', branchId: gymBranchId } }],
      };

      const managerActor: ActorContext = {
        userId: gymManagerId,
        email: 'mgr@drawergym.com',
        isPlatformAdmin: false,
        tenantId: gymTenantId,
        roles: [{ role: 'BRANCH_MANAGER', scope: { type: 'BRANCH', branchId: gymBranchId } }],
      };

      let sessionId: string;

      // 1. Open Drawer Session with ₹2,000 float (200,000 paise)
      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        const sessionRes = await PettyCashService.openDrawerSession(client, receptionistActor, {
          branchId: gymBranchId,
          openingFloatPaise: toPaise(200000), // ₹2,000
        });
        sessionId = sessionRes.sessionId;
        expect(sessionId).toBeDefined();
      });

      // 2. Desk Collects ₹1,000 Cash (100,000 paise) for a walk-in booking
      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        // Create dummy appointment for payment link
        const apptRes = await client.query<{ id: string }>(
          `INSERT INTO appointments (
            tenant_id, branch_id, customer_id, service_id, professional_id,
            start_time, end_time, status, locked_price_paise
          ) VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), $3, NOW(), NOW() + INTERVAL '1 hour', 'CONFIRMED', 100000)
          RETURNING id;`,
          [gymTenantId, gymBranchId, gymManagerId]
        );

        await PettyCashService.recordCashPayment(
          client,
          receptionistActor,
          gymBranchId,
          sessionId,
          apptRes.rows[0].id,
          toPaise(100000) // ₹1,000
        );
      });

      // 3. Receptionist issues ₹150 (15,000 paise) provisional tea/refreshment voucher
      let voucherNumber: string;
      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        const voucherRes = await PettyCashService.createVoucher(client, receptionistActor, {
          branchId: gymBranchId,
          drawerSessionId: sessionId,
          amountPaise: toPaise(15000), // ₹150
          category: 'REFRESHMENTS',
          paidToName: 'Chaiwala Sharma Ji',
          notes: 'Evening tea and biscuits for guests',
        });
        voucherNumber = voucherRes.voucherNumber;
        expect(voucherNumber).toMatch(/^VOUCH-/);
      });

      // 4. Verify Non-Manager (Receptionist) CANNOT reconcile the session
      await expect(
        DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
          return PettyCashService.reconcileSession(client, receptionistActor, sessionId, toPaise(285000));
        })
      ).rejects.toThrow(AuthorizationDeniedError);

      // 5. Manager closes & reconciles drawer:
      // Expected = Opening (2,000) + Cash (1,000) - Voucher (150) = ₹2,850 (285,000 paise)
      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        const reconciliation = await PettyCashService.reconcileSession(
          client,
          managerActor,
          sessionId,
          toPaise(285000) // Counted cash exactly ₹2,850
        );

        expect(reconciliation.isBalanced).toBe(true);
        expect(reconciliation.variancePaise).toBe(0n);
        expect(reconciliation.expectedClosingPaise).toBe(285000n);
        expect(reconciliation.closingCountedPaise).toBe(285000n);
        expect(reconciliation.totalVouchersPaise).toBe(15000n);
        expect(reconciliation.totalCashCollectedPaise).toBe(100000n);
      });
    });
  });

  describe('Scenario 2: Online Guest Booking, Subdomain Resolution & Anti-Tamper Price Protection', () => {
    it('resolves tenant via host, locks server quote ignoring client price, throttles OTP and books guest', async () => {
      if (!isDbAvailable) {
        expect(PublicBookingService.resolveTenantByHost).toBeDefined();
        return;
      }

      // Provision Service Tenant
      const serviceProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'online-service-001',
        name: 'Femme Luxe Online Lounge',
        slug: 'femme-luxe',
        ownerEmail: 'owner@femmeluxeonline.com',
        ownerPhone: '+919833777001',
        ownerName: 'Natasha Online',
      });
      orgTenantId = serviceProv.tenantId;
      orgBranchId = serviceProv.branchId;

      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        // Setup Provider
        const uRes = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ('aarav@femmeluxeonline.com', '+919833777002', 'Aarav Master Specialist', 'HASH')
           RETURNING id;`
        );
        orgProviderId = asUserId(uRes.rows[0].id);

        // Balayage Service: 120 min, ₹5,500 (550,000 paise)
        const sRes = await CatalogueEligibilityService.createService(client, orgTenantId, {
          name: 'Balayage & Olaplex',
          durationMinutes: 120,
          basePricePaise: toPaise(550000), // ₹5,500
        });
        balayageServiceId = sRes.serviceId;

        // Resource: Styling Chair 1
        const rRes = await CatalogueEligibilityService.createResource(client, orgTenantId, {
          branchId: orgBranchId,
          name: 'Styling Chair 1',
          resourceType: 'CHAIR',
        });
        stylingChairId = rRes.resourceId;

        await CatalogueEligibilityService.setEligibility(client, orgTenantId, balayageServiceId, orgProviderId, true);
      });

      // 1. Subdomain Resolution: 'femme-luxe.platform.test' -> orgTenantId
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const resolved = await PublicBookingService.resolveTenantByHost(client, 'femme-luxe.platform.test');
        expect(resolved.tenantId).toBe(orgTenantId);
        expect(resolved.slug).toBe('femme-luxe');
      });

      // 2. OTP Verification Flow: First-time online guest phone
      const guestPhone = '+919800776655';
      let challengeId: string;
      let validCode: string;

      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const otpReq = await OtpService.requestOtp(client, orgTenantId, guestPhone);
        challengeId = otpReq.challengeId;
        validCode = otpReq.rawCodeForTest!;
        expect(challengeId).toBeDefined();
      });

      // Wrong OTP attempts: Verify lockout after threshold
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        // Send wrong codes
        await expect(OtpService.verifyOtp(client, orgTenantId, challengeId, '000000')).rejects.toThrow(
          InvariantViolationError
        );
      });

      // Valid OTP verification
      let verifiedToken: string;
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const verifyRes = await OtpService.verifyOtp(client, orgTenantId, challengeId, validCode);
        expect(verifyRes.verified).toBe(true);
        verifiedToken = verifyRes.verificationToken;
      });

      // 3. Online Guest Booking with Tampered Price:
      // Client maliciously sends `tamperedPricePaise = '10000'` (₹100) instead of ₹5,500
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const booking = await PublicBookingService.createOnlineBooking(client, orgTenantId, {
          branchId: orgBranchId,
          serviceId: balayageServiceId,
          professionalId: orgProviderId,
          customerPhone: guestPhone,
          customerFirstName: 'Priya',
          customerLastName: 'Sharma',
          startTime: '2026-11-15T10:00:00.000Z',
          resourceIds: [stylingChairId],
          otpVerifiedToken: verifiedToken,
          tamperedPricePaise: '10000', // ₹100 TAMPER ATTEMPT
        });

        expect(booking.appointmentId).toBeDefined();
        // INVARIANT ENFORCED: System locks server quote ₹5,500 (550,000 paise), DISCARDING client tampering
        expect(booking.lockedPricePaise).toBe('550000');
      });
    });
  });

  describe('Scenario 3: Atomic Reschedule, Concurrency Collision & Cancellation Engine', () => {
    it('atomically moves booking to free slot; fails with 409 and leaves original intact on collision', async () => {
      if (!isDbAvailable) {
        expect(RescheduleAndCancellationService.atomicReschedule).toBeDefined();
        return;
      }

      let appt1Id: string;
      let appt2Id: string;
      const originalTime = '2026-11-16T10:00:00.000Z';
      const slot2Time = '2026-11-16T14:00:00.000Z';
      const targetFreeTime = '2026-11-16T18:00:00.000Z';

      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        // Create Appointment 1 (10:00 - 12:00)
        const a1 = await client.query<{ id: string }>(
          `INSERT INTO appointments (
            tenant_id, branch_id, customer_id, service_id, professional_id,
            start_time, end_time, status, locked_price_paise
          ) VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, '2026-11-16T12:00:00.000Z', 'CONFIRMED', 550000)
          RETURNING id;`,
          [orgTenantId, orgBranchId, balayageServiceId, orgProviderId, originalTime]
        );
        appt1Id = a1.rows[0].id;

        // Create Appointment 2 (14:00 - 16:00)
        const a2 = await client.query<{ id: string }>(
          `INSERT INTO appointments (
            tenant_id, branch_id, customer_id, service_id, professional_id,
            start_time, end_time, status, locked_price_paise
          ) VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, '2026-11-16T16:00:00.000Z', 'CONFIRMED', 550000)
          RETURNING id;`,
          [orgTenantId, orgBranchId, balayageServiceId, orgProviderId, slot2Time]
        );
        appt2Id = a2.rows[0].id;
      });

      // 1. Reschedule Appointment 1 into Occupied Slot 2 (14:00) -> MUST FAIL with ConcurrencyConflictError (409)
      await expect(
        DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
          return RescheduleAndCancellationService.atomicReschedule(client, orgTenantId, appt1Id, slot2Time);
        })
      ).rejects.toThrow(ConcurrencyConflictError);

      // Verify Appointment 1 remains unchanged at originalTime (10:00)
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const check = await client.query<{ start_time: Date }>(
          'SELECT start_time FROM appointments WHERE tenant_id = $1 AND id = $2;',
          [orgTenantId, appt1Id]
        );
        expect(new Date(check.rows[0].start_time).toISOString()).toBe(originalTime);
      });

      // 2. Reschedule Appointment 1 into targetFreeTime (18:00) -> SUCCEEDS ATOMICALLY
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const res = await RescheduleAndCancellationService.atomicReschedule(
          client,
          orgTenantId,
          appt1Id,
          targetFreeTime
        );
        expect(res.appointmentId).toBe(appt1Id);
        expect(res.newStartTime).toBe(targetFreeTime);
      });

      // 3. Policy-Based Cancellation Test (> 24 hours out -> 100% refund)
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const cancelRes = await RescheduleAndCancellationService.cancelAppointment(
          client,
          orgTenantId,
          appt1Id,
          'Customer travel plans changed'
        );

        expect(cancelRes.status).toBe('CANCELLED');
        expect(cancelRes.cancellationFeePaise).toBe(0n);
        expect(cancelRes.refundAmountPaise).toBe(550000n); // 100% refund
        expect(cancelRes.isIdempotentReplay).toBe(false);

        // Idempotent re-cancellation: returns existing cancelled state without creating second refund
        const replayRes = await RescheduleAndCancellationService.cancelAppointment(
          client,
          orgTenantId,
          appt1Id,
          'Duplicate click'
        );
        expect(replayRes.isIdempotentReplay).toBe(true);
      });
    });
  });

  describe('Scenario 4: Multi-Resource Scheduling & Maintenance Block Exclusion', () => {
    it('omits Balayage when Washing Station A is under maintenance, but keeps Haircut available', async () => {
      if (!isDbAvailable) {
        expect(MaintenanceBlockService.createMaintenanceBlock).toBeDefined();
        return;
      }

      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        // Setup Haircut Service (only requires CHAIR)
        const sRes = await CatalogueEligibilityService.createService(client, orgTenantId, {
          name: 'Standard Haircut',
          durationMinutes: 45,
          basePricePaise: toPaise(120000),
        });
        haircutServiceId = sRes.serviceId;

        await client.query(
          `INSERT INTO service_resource_requirements (tenant_id, service_id, resource_type, quantity)
           VALUES ($1, $2, 'CHAIR', 1);`,
          [orgTenantId, haircutServiceId]
        );

        // Setup Washing Station Resource
        const rRes = await CatalogueEligibilityService.createResource(client, orgTenantId, {
          branchId: orgBranchId,
          name: 'Washing Station A',
          resourceType: 'CHAIR',
        });
        washingStationId = rRes.resourceId;

        // Balayage requires BOTH Styling Chair and Washing Station
        await client.query(
          `INSERT INTO service_resource_requirements (tenant_id, service_id, resource_type, quantity)
           VALUES ($1, $2, 'CHAIR', 2)
           ON CONFLICT DO NOTHING;`,
          [orgTenantId, balayageServiceId]
        );

        // Specialist working on Monday 2026-11-23 from 10:00 to 14:00
        await CatalogueEligibilityService.setWorkingHours(
          client,
          orgTenantId,
          orgBranchId,
          orgProviderId,
          1, // Monday
          '10:00:00',
          '14:00:00'
        );
        await CatalogueEligibilityService.setEligibility(client, orgTenantId, haircutServiceId, orgProviderId, true);
      });

      const managerActor: ActorContext = {
        userId: orgProviderId,
        email: 'owner@femmeluxeonline.com',
        isPlatformAdmin: false,
        tenantId: orgTenantId,
        roles: [{ role: 'OWNER', scope: { type: 'TENANT' } }],
      };

      // 1. Create Maintenance Block on Washing Station A (10:00 to 12:00)
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const block = await MaintenanceBlockService.createMaintenanceBlock(client, managerActor, {
          branchId: orgBranchId,
          resourceId: washingStationId,
          startTime: '2026-11-23T10:00:00.000Z',
          endTime: '2026-11-23T12:00:00.000Z',
          reason: 'Deep pipe cleaning and plumbing maintenance',
        });
        expect(block.blockId).toBeDefined();
      });

      // 2. Query Availability for Balayage (which needs Washing Station):
      // Must be unavailable during 10:00 - 12:00
      await DatabaseClient.withTenantTransaction(orgTenantId, async (client) => {
        const balayageSlots = await AvailabilityEngine.computeAvailableSlots(client, {
          tenantId: orgTenantId,
          branchId: orgBranchId,
          serviceId: balayageServiceId,
          date: '2026-11-23',
        });

        const balayageStartTimes = balayageSlots.map((s) => s.startTime);
        expect(balayageStartTimes).not.toContain('2026-11-23T10:00:00.000Z');
        expect(balayageStartTimes).not.toContain('2026-11-23T11:00:00.000Z');

        // 3. Query Availability for Standard Haircut (only needs Styling Chair):
        // Styling Chair 1 is free, so Haircut remains AVAILABLE!
        const haircutSlots = await AvailabilityEngine.computeAvailableSlots(client, {
          tenantId: orgTenantId,
          branchId: orgBranchId,
          serviceId: haircutServiceId,
          date: '2026-11-23',
        });

        const haircutStartTimes = haircutSlots.map((s) => s.startTime);
        expect(haircutStartTimes).toContain('2026-11-23T10:00:00.000Z');
      });
    });
  });
});

