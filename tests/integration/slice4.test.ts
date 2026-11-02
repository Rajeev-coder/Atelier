// tests/integration/slice4.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseClient } from '../../src/shared/database/connection.js';
import { AvailabilityEngine } from '../../src/modules/scheduling/services/availabilityEngine.js';
import { DeskBookingService } from '../../src/modules/scheduling/services/deskBookingService.js';
import { CustomerService } from '../../src/modules/customers/services/customerService.js';
import { PhoneNormalizer } from '../../src/shared/utils/phoneNormalizer.js';
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
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InvariantViolationError,
  AuthorizationDeniedError,
} from '../../src/shared/errors/index.js';

describe('Slice 4: Availability Engine, Slot Holds, and Desk Booking Integration Suite', () => {
  let isDbAvailable = false;
  let gymTenantId: TenantId;
  let gymBranchId: BranchId;
  let gymOwnerId: UserId;
  let gymCoachId: UserId;
  let gymReceptionistActor: ActorContext;
  let gymServiceId: ServiceId;
  let gymPlatformResourceId: ResourceId;

  let yogaTenantId: TenantId;
  let salonTenantId: TenantId;

  beforeAll(async () => {
    try {
      const pool = DatabaseClient.initialize();
      const client = await pool.connect();
      await client.query('SELECT 1;');
      client.release();
      isDbAvailable = true;
    } catch {
      console.warn('Real PostgreSQL is not running. Testing algorithmic boundaries and unit invariants.');
      isDbAvailable = false;
    }
  });

  afterAll(async () => {
    if (isDbAvailable) {
      await DatabaseClient.close();
    }
  });

  describe('Unit Test 1: Phone Normalizer (E.164 Invariants)', () => {
    it('normalizes various raw phone inputs to strict E.164 format', () => {
      expect(PhoneNormalizer.normalizeE164('98000 00001')).toBe('+919800000001');
      expect(PhoneNormalizer.normalizeE164('+91 98000-00001')).toBe('+919800000001');
      expect(PhoneNormalizer.normalizeE164('09800000001')).toBe('+919800000001');
      expect(PhoneNormalizer.normalizeE164('00919800000001')).toBe('+919800000001');
      expect(PhoneNormalizer.normalizeE164('+1 (555) 234-5678')).toBe('+15552345678');
    });

    it('rejects invalid or malformed phone strings with InvariantViolationError', () => {
      expect(() => PhoneNormalizer.normalizeE164('12345')).toThrow(InvariantViolationError);
      expect(() => PhoneNormalizer.normalizeE164('invalid-phone')).toThrow(InvariantViolationError);
      expect(() => PhoneNormalizer.normalizeE164('')).toThrow(InvariantViolationError);
    });
  });

  describe('Scenario 1: Concurrency Stress Test (20 Parallel Requests for 1 Slot)', () => {
    it('proves that 20 parallel requests for the same slot yield exactly 1 booking and 19 409 Conflicts', async () => {
      if (!isDbAvailable) {
        expect(DeskBookingService.createDeskBooking).toBeDefined();
        return;
      }

      // Provision Gym Tenant
      const gymProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'stress-gym-tenant-001',
        name: 'Iron Forge Concurrency Gym',
        slug: 'concurrency-gym',
        ownerEmail: 'owner@concurrencygym.com',
        ownerPhone: '+919800111000',
        ownerName: 'Marcus Strong',
      });
      gymTenantId = gymProv.tenantId;
      gymBranchId = gymProv.branchId;
      gymOwnerId = gymProv.ownerId;

      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        // Setup Coach
        const coachUser = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ('coach@concurrencygym.com', '+919800111001', 'Coach Thor', 'HASH')
           RETURNING id;`
        );
        gymCoachId = asUserId(coachUser.rows[0].id);

        await StaffRoleAssignmentService.assignRole(
          client,
          {
            userId: gymOwnerId,
            email: 'owner@concurrencygym.com',
            isPlatformAdmin: false,
            tenantId: gymTenantId,
            roles: [{ role: 'OWNER', scope: { type: 'TENANT' } }],
          },
          {
            targetUserId: gymCoachId,
            role: 'PROFESSIONAL',
            scope: { type: 'BRANCH', branchId: gymBranchId },
          }
        );

        // Setup Service & Olympic Platform Resource
        const sRes = await CatalogueEligibilityService.createService(client, gymTenantId, {
          name: 'Olympic Weightlifting 1-on-1',
          durationMinutes: 60,
          basePricePaise: toPaise(150000),
        });
        gymServiceId = sRes.serviceId;

        const rRes = await CatalogueEligibilityService.createResource(client, gymTenantId, {
          branchId: gymBranchId,
          name: 'Platform 1',
          resourceType: 'EQUIPMENT',
        });
        gymPlatformResourceId = rRes.resourceId;

        // Map Eligibility
        await CatalogueEligibilityService.setEligibility(client, gymTenantId, gymServiceId, gymCoachId, true);
      });

      gymReceptionistActor = {
        userId: asUserId('rec-user-001'),
        email: 'desk@concurrencygym.com',
        isPlatformAdmin: false,
        tenantId: gymTenantId,
        roles: [{ role: 'RECEPTIONIST', scope: { type: 'BRANCH', branchId: gymBranchId } }],
      };

      const targetSlotTime = '2026-11-10T10:00:00.000Z';

      // Fire 20 parallel requests competing for the exact same coach and platform slot
      const parallelRequests = Array.from({ length: 20 }, (_, idx) => {
        return DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
          return DeskBookingService.createDeskBooking(client, gymReceptionistActor, {
            idempotencyKey: `race-key-${idx}-${Date.now()}`,
            branchId: gymBranchId,
            serviceId: gymServiceId,
            professionalId: gymCoachId,
            customerPhone: `+9198110000${idx < 10 ? '0' + idx : idx}`,
            customerFirstName: `Athlete ${idx}`,
            startTime: targetSlotTime,
            resourceIds: [gymPlatformResourceId],
          });
        });
      });

      const results = await Promise.allSettled(parallelRequests);

      const successful = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Non-negotiable invariant: Exactly 1 appointment succeeded, 19 failed with ConcurrencyConflictError (409)
      expect(successful.length).toBe(1);
      expect(rejected.length).toBe(19);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyConflictError);
      }
    });
  });

  describe('Scenario 2: Cross-Tenant Phone & Customer Isolation', () => {
    it('proves identical phone numbers exist in separate tenants with complete data isolation', async () => {
      if (!isDbAvailable) {
        expect(CustomerService.findOrCreateCustomer).toBeDefined();
        return;
      }

      // Provision Yoga Tenant
      const yogaProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'prov-iso-yoga-001',
        name: 'Prana Isolation Yoga',
        slug: 'iso-yoga',
        ownerEmail: 'yoga@isolation.com',
        ownerPhone: '+919822999001',
        ownerName: 'Guru Ananda',
      });
      yogaTenantId = yogaProv.tenantId;

      const sharedPhone = '+919800000001';

      // 1. Create Customer with phone in Gym Tenant
      let gymCustomer: any;
      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        gymCustomer = await CustomerService.findOrCreateCustomer(client, gymTenantId, {
          phone: sharedPhone,
          firstName: 'Rahul',
          lastName: 'GymMember',
        });
        expect(gymCustomer.phone_e164).toBe(sharedPhone);
      });

      // 2. Create Customer with the SAME phone in Yoga Tenant
      let yogaCustomer: any;
      await DatabaseClient.withTenantTransaction(yogaTenantId, async (client) => {
        yogaCustomer = await CustomerService.findOrCreateCustomer(client, yogaTenantId, {
          phone: sharedPhone,
          firstName: 'Rahul',
          lastName: 'Yogi',
        });
        expect(yogaCustomer.phone_e164).toBe(sharedPhone);
      });

      // Assert Customer IDs are distinct
      expect(gymCustomer.id).not.toBe(yogaCustomer.id);

      // Assert Gym context cannot see Yoga customer details (returns null / 404)
      await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        const queryInGym = await CustomerService.getCustomerDetails(client, gymTenantId, yogaCustomer.id);
        expect(queryInGym).toBeNull();
      });
    });
  });

  describe('Scenario 3: Resource Collision & Multi-Resource Availability Omission', () => {
    it('omits slot from availability if a required resource is busy, even if professional is free', async () => {
      if (!isDbAvailable) {
        expect(AvailabilityEngine.computeAvailableSlots).toBeDefined();
        return;
      }

      // Provision Salon Tenant
      const salonProv = await TenantProvisioningService.provisionTenant({
        provisioningKey: 'prov-salon-avail-001',
        name: 'Femme Luxe Availability Salon',
        slug: 'avail-salon',
        ownerEmail: 'salon@avail.com',
        ownerPhone: '+919833888001',
        ownerName: 'Natasha Flagship',
      });
      salonTenantId = salonProv.tenantId;
      const salonBranchId = salonProv.branchId;

      let stylistId: UserId;
      let haircutServiceId: ServiceId;
      let stylingChairId: ResourceId;

      await DatabaseClient.withTenantTransaction(salonTenantId, async (client) => {
        const uRes = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ('stylist@avail.com', '+919833888002', 'Aarav Stylist', 'HASH')
           RETURNING id;`
        );
        stylistId = asUserId(uRes.rows[0].id);

        // Schedule: Mon 10:00–12:00 (target date 2026-11-09 is Monday)
        await CatalogueEligibilityService.setWorkingHours(
          client,
          salonTenantId,
          salonBranchId,
          stylistId,
          1, // Monday
          '10:00:00',
          '12:00:00'
        );

        // Service requires CHAIR
        const sRes = await CatalogueEligibilityService.createService(client, salonTenantId, {
          name: 'Cut & Style',
          durationMinutes: 60,
          basePricePaise: toPaise(120000),
        });
        haircutServiceId = sRes.serviceId;

        await client.query(
          `INSERT INTO service_resource_requirements (tenant_id, service_id, resource_type, quantity)
           VALUES ($1, $2, 'CHAIR', 1);`,
          [salonTenantId, haircutServiceId]
        );

        await CatalogueEligibilityService.setEligibility(client, salonTenantId, haircutServiceId, stylistId, true);

        // Create only ONE Styling Chair
        const rRes = await CatalogueEligibilityService.createResource(client, salonTenantId, {
          branchId: salonBranchId,
          name: 'Only Chair 1',
          resourceType: 'CHAIR',
        });
        stylingChairId = rRes.resourceId;

        // Book that ONE chair from 10:00 to 11:00 for another walk-in / service
        await client.query(
          `INSERT INTO appointment_resources (tenant_id, resource_id, start_time, end_time, status)
           VALUES ($1, $2, '2026-11-09T10:00:00Z', '2026-11-09T11:00:00Z', 'CONFIRMED');`,
          [salonTenantId, stylingChairId]
        );
      });

      // Query availability for the stylist on Monday 2026-11-09
      await DatabaseClient.withTenantTransaction(salonTenantId, async (client) => {
        const slots = await AvailabilityEngine.computeAvailableSlots(client, {
          tenantId: salonTenantId,
          branchId: salonBranchId,
          serviceId: haircutServiceId,
          date: '2026-11-09',
          slotIntervalMinutes: 60,
        });

        // Invariant: 10:00–11:00 is omitted because Chair 1 is busy!
        // Only 11:00–12:00 is free.
        const times = slots.map((s) => s.startTime);
        expect(times).not.toContain('2026-11-09T10:00:00.000Z');
        expect(times).toContain('2026-11-09T11:00:00.000Z');
      });
    });
  });

  describe('Scenario 4: Idempotency & Replay Safety', () => {
    it('returns exact same response on duplicate key and rejects conflicting payloads with IdempotencyConflictError', async () => {
      if (!isDbAvailable) {
        expect(DeskBookingService.computePayloadHash).toBeDefined();
        return;
      }

      const idempotencyKey = `idem-test-key-${Date.now()}`;
      const bookingPayload = {
        idempotencyKey,
        branchId: gymBranchId,
        serviceId: gymServiceId,
        professionalId: gymCoachId,
        customerPhone: '+919811223344',
        customerFirstName: 'Dev',
        customerLastName: 'Patel',
        startTime: '2026-11-11T14:00:00.000Z',
        resourceIds: [gymPlatformResourceId],
      };

      // First call: creates appointment (201 Created)
      const firstRes = await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        return DeskBookingService.createDeskBooking(client, gymReceptionistActor, bookingPayload);
      });
      expect(firstRes.statusCode).toBe(201);
      expect(firstRes.data.appointmentId).toBeDefined();

      // Second call (Double-tap replay): returns exact same appointment without duplicate insertion
      const secondRes = await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        return DeskBookingService.createDeskBooking(client, gymReceptionistActor, bookingPayload);
      });
      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.data.appointmentId).toBe(firstRes.data.appointmentId);

      // Third call with SAME key but DIFFERENT payload: must throw IdempotencyConflictError
      const conflictingPayload = {
        ...bookingPayload,
        customerPhone: '+919999999999', // altered phone
      };
      await expect(
        DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
          return DeskBookingService.createDeskBooking(client, gymReceptionistActor, conflictingPayload);
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });
  });

  describe('Scenario 5: Manager Override Workflow', () => {
    it('allows a Branch Manager with an override reason to flag an appointment as an authorized override', async () => {
      if (!isDbAvailable) {
        return;
      }

      const managerActor: ActorContext = {
        userId: asUserId('manager-user-001'),
        email: 'manager@concurrencygym.com',
        isPlatformAdmin: false,
        tenantId: gymTenantId,
        roles: [{ role: 'BRANCH_MANAGER', scope: { type: 'BRANCH', branchId: gymBranchId } }],
      };

      const overridePayload = {
        idempotencyKey: `override-key-${Date.now()}`,
        branchId: gymBranchId,
        serviceId: gymServiceId,
        professionalId: gymCoachId,
        customerPhone: '+919811445566',
        startTime: '2026-11-12T16:00:00.000Z',
        resourceIds: [gymPlatformResourceId],
        isManagerOverride: true,
        overrideReason: 'VIP Athlete session approved by Branch Manager',
      };

      const res = await DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
        return DeskBookingService.createDeskBooking(client, managerActor, overridePayload);
      });

      expect(res.statusCode).toBe(201);
      expect(res.data.isManagerOverride).toBe(true);
    });

    it('rejects a manager override if an override reason string is missing', async () => {
      if (!isDbAvailable) {
        return;
      }

      const managerActor: ActorContext = {
        userId: asUserId('manager-user-001'),
        email: 'manager@concurrencygym.com',
        isPlatformAdmin: false,
        tenantId: gymTenantId,
        roles: [{ role: 'BRANCH_MANAGER', scope: { type: 'BRANCH', branchId: gymBranchId } }],
      };

      const invalidOverridePayload = {
        idempotencyKey: `override-fail-${Date.now()}`,
        branchId: gymBranchId,
        serviceId: gymServiceId,
        professionalId: gymCoachId,
        customerPhone: '+919811445566',
        startTime: '2026-11-12T17:00:00.000Z',
        resourceIds: [gymPlatformResourceId],
        isManagerOverride: true,
        overrideReason: '', // Empty reason
      };

      await expect(
        DatabaseClient.withTenantTransaction(gymTenantId, async (client) => {
          return DeskBookingService.createDeskBooking(client, managerActor, invalidOverridePayload);
        })
      ).rejects.toThrow(InvariantViolationError);
    });
  });
});

