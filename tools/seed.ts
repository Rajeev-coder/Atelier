// tools/seed.ts
import pg from 'pg';
import { DatabaseClient } from '../src/shared/database/connection.js';
import { TenantProvisioningService } from '../src/modules/tenancy/services/tenantProvisioningService.js';
import { StaffRoleAssignmentService } from '../src/modules/policy/services/staffRoleAssignmentService.js';
import { CatalogueEligibilityService } from '../src/modules/catalogue/services/catalogueEligibilityService.js';
import {
  TenantId,
  UserId,
  BranchId,
  ServiceId,
  ResourceId,
  asUserId,
  asBranchId,
  asServiceId,
  asResourceId,
  toPaise,
  ResourceKind,
} from '../src/shared/types/index.js';

interface SeededStaff {
  email: string;
  phone: string;
  name: string;
  role: 'BRANCH_MANAGER' | 'FRONT_DESK_OPERATOR' | 'RECEPTIONIST' | 'SERVICE_PROVIDER' | 'PROFESSIONAL';
  tier?: string;
  compensationPaise: bigint;
  workDays: number[];
  startTime: string;
  endTime: string;
  breakStart?: string;
  breakEnd?: string;
}

interface SeededResource {
  name: string;
  type: ResourceKind;
}

interface SeededService {
  name: string;
  durationMinutes: number;
  pricePaise: bigint;
  requiredResourceTypes: ResourceKind[];
  eligibleStaffIndices: number[]; // indices into staff array
}

interface TenantSeedSpec {
  provisioningKey: string;
  name: string;
  slug: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerName: string;
  branchName: string;
  staff: SeededStaff[];
  resources: SeededResource[];
  services: SeededService[];
}

const SEED_DATA: TenantSeedSpec[] = [
  // 1. STRENGTH & CONDITIONING GYM
  {
    provisioningKey: 'prov-gym-001',
    name: 'Iron Forge Performance Gym',
    slug: 'iron-forge-gym',
    ownerEmail: 'marcus@ironforge.com',
    ownerPhone: '+919811000001',
    ownerName: 'Marcus Vance',
    branchName: 'Downtown Performance Center',
    staff: [
      {
        email: 'vikram@ironforge.com',
        phone: '+919811000002',
        name: 'Vikram Rathi',
        role: 'BRANCH_MANAGER',
        tier: 'HEAD_COACH',
        compensationPaise: 8000000n, // ₹80,000
        workDays: [1, 2, 3, 4, 5],
        startTime: '06:00:00',
        endTime: '14:00:00',
        breakStart: '10:00:00',
        breakEnd: '11:00:00',
      },
      {
        email: 'elena@ironforge.com',
        phone: '+919811000003',
        name: 'Elena Rostova',
        role: 'PROFESSIONAL',
        tier: 'SENIOR',
        compensationPaise: 6000000n,
        workDays: [1, 2, 3, 4, 5],
        startTime: '12:00:00',
        endTime: '20:00:00',
        breakStart: '15:00:00',
        breakEnd: '16:00:00',
      },
      {
        email: 'dev@ironforge.com',
        phone: '+919811000004',
        name: 'Dev Patel',
        role: 'PROFESSIONAL',
        tier: 'JUNIOR',
        compensationPaise: 4000000n,
        workDays: [2, 3, 4, 5, 6],
        startTime: '08:00:00',
        endTime: '16:00:00',
        breakStart: '12:00:00',
        breakEnd: '13:00:00',
      },
      {
        email: 'neha@ironforge.com',
        phone: '+919811000005',
        name: 'Neha Sharma',
        role: 'RECEPTIONIST',
        tier: 'STANDARD',
        compensationPaise: 3000000n,
        workDays: [1, 2, 3, 4, 5, 6],
        startTime: '06:00:00',
        endTime: '15:00:00',
      },
    ],
    resources: [
      { name: 'Power Rack 1', type: 'EQUIPMENT' },
      { name: 'Olympic Lifting Platform', type: 'EQUIPMENT' },
      { name: 'Cable Functional Trainer', type: 'EQUIPMENT' },
      { name: 'Assessment Room', type: 'ROOM' },
    ],
    services: [
      {
        name: '1-on-1 Powerlifting Coaching',
        durationMinutes: 60,
        pricePaise: 150000n, // ₹1,500
        requiredResourceTypes: ['EQUIPMENT'],
        eligibleStaffIndices: [0, 1], // Vikram & Elena
      },
      {
        name: 'Functional Movement & Mobility Screen',
        durationMinutes: 45,
        pricePaise: 120000n, // ₹1,200
        requiredResourceTypes: ['ROOM'],
        eligibleStaffIndices: [0, 1, 2], // Vikram, Elena, Dev
      },
      {
        name: 'Hypertrophy & Bodybuilding Personal Training',
        durationMinutes: 60,
        pricePaise: 100000n, // ₹1,000
        requiredResourceTypes: ['EQUIPMENT'],
        eligibleStaffIndices: [1, 2], // Elena & Dev
      },
      {
        name: 'Body Composition DEXA/InBody Consultation',
        durationMinutes: 30,
        pricePaise: 80000n, // ₹800
        requiredResourceTypes: ['ROOM'],
        eligibleStaffIndices: [0, 2], // Vikram & Dev
      },
    ],
  },

  // 2. HOLISTIC YOGA & BREATHWORK SHALA
  {
    provisioningKey: 'prov-yoga-002',
    name: 'Prana Yoga Sanctuary',
    slug: 'prana-yoga-sanctuary',
    ownerEmail: 'director@pranashala.com',
    ownerPhone: '+919822000001',
    ownerName: 'Ananya Iyer',
    branchName: 'Main Shala & Meditation Garden',
    staff: [
      {
        email: 'rohan@pranashala.com',
        phone: '+919822000002',
        name: 'Rohan Deshmukh',
        role: 'BRANCH_MANAGER',
        tier: 'MANAGER',
        compensationPaise: 6500000n,
        workDays: [1, 2, 3, 4, 5, 6],
        startTime: '08:00:00',
        endTime: '17:00:00',
      },
      {
        email: 'mira@pranashala.com',
        phone: '+919822000003',
        name: 'Mira Sen',
        role: 'RECEPTIONIST',
        tier: 'STANDARD',
        compensationPaise: 2800000n,
        workDays: [1, 2, 3, 4, 5, 6],
        startTime: '06:00:00',
        endTime: '15:00:00',
      },
      {
        email: 'bodhi@pranashala.com',
        phone: '+919822000004',
        name: 'Swami Bodhi',
        role: 'PROFESSIONAL',
        tier: 'LEAD_ACHARYA',
        compensationPaise: 9000000n,
        workDays: [1, 2, 3, 4, 5, 6],
        startTime: '06:00:00',
        endTime: '12:00:00',
        breakStart: '09:00:00',
        breakEnd: '09:30:00',
      },
      {
        email: 'kavita@pranashala.com',
        phone: '+919822000005',
        name: 'Kavita Rao',
        role: 'PROFESSIONAL',
        tier: 'BREATHWORK_MASTER',
        compensationPaise: 8500000n,
        workDays: [2, 3, 4, 5, 6, 0], // Tue–Sun
        startTime: '14:00:00',
        endTime: '20:00:00',
        breakStart: '17:00:00',
        breakEnd: '17:30:00',
      },
    ],
    resources: [
      { name: 'Bamboo Studio Mat Pod 1', type: 'CHAIR' },
      { name: 'Sound Healing Chamber', type: 'ROOM' },
      { name: 'Private Shala Room A', type: 'ROOM' },
    ],
    services: [
      {
        name: 'Private Vinyasa & Posture Alignment',
        durationMinutes: 60,
        pricePaise: 200000n, // ₹2,000
        requiredResourceTypes: ['ROOM'],
        eligibleStaffIndices: [2], // Swami Bodhi
      },
      {
        name: '1-on-1 Pranayama & Cyclic Breathwork Mastery',
        durationMinutes: 45,
        pricePaise: 150000n, // ₹1,500
        requiredResourceTypes: ['CHAIR'],
        eligibleStaffIndices: [2, 3], // Swami Bodhi, Kavita
      },
      {
        name: 'Tibetan Singing Bowl Sound Bath Therapy',
        durationMinutes: 60,
        pricePaise: 250000n, // ₹2,500
        requiredResourceTypes: ['ROOM'],
        eligibleStaffIndices: [3], // Kavita
      },
      {
        name: 'Seated Mindfulness & Somatic Release Session',
        durationMinutes: 30,
        pricePaise: 100000n, // ₹1,000
        requiredResourceTypes: ['ROOM'],
        eligibleStaffIndices: [2, 3], // Both
      },
    ],
  },

  // 3. PREMIUM HAIR & AESTHETIC LOUNGE
  {
    provisioningKey: 'prov-salon-003',
    name: 'Luxe Salon & Spa',
    slug: 'luxe-salon',
    ownerEmail: 'owner@luxesalon.com',
    ownerPhone: '+919833000001',
    ownerName: 'Natasha Kapoor',
    branchName: 'Flagship Lounge',
    staff: [
      {
        email: 'siddharth@luxesalon.com',
        phone: '+919833000002',
        name: 'Siddharth Roy',
        role: 'BRANCH_MANAGER',
        tier: 'FLOOR_MANAGER',
        compensationPaise: 7500000n,
        workDays: [1, 2, 3, 4, 5, 6],
        startTime: '09:30:00',
        endTime: '19:00:00',
      },
      {
        email: 'tanvi@luxesalon.com',
        phone: '+919833000003',
        name: 'Tanvi Mehta',
        role: 'RECEPTIONIST',
        tier: 'CONCIERGE',
        compensationPaise: 3200000n,
        workDays: [1, 2, 3, 4, 5, 6],
        startTime: '09:00:00',
        endTime: '18:00:00',
      },
      {
        email: 'aarav@luxesalon.com',
        phone: '+919833000004',
        name: 'Aarav Mehra',
        role: 'PROFESSIONAL',
        tier: 'MASTER_SPECIALIST',
        compensationPaise: 9500000n,
        workDays: [3, 4, 5, 6, 0], // Wed–Sun
        startTime: '10:00:00',
        endTime: '19:00:00',
        breakStart: '13:30:00',
        breakEnd: '14:30:00',
      },
      {
        email: 'zoya@luxesalon.com',
        phone: '+919833000005',
        name: 'Zoya Khan',
        role: 'PROFESSIONAL',
        tier: 'COLOR_SPECIALIST',
        compensationPaise: 9000000n,
        workDays: [2, 3, 4, 5, 6], // Tue–Sat
        startTime: '11:00:00',
        endTime: '20:00:00',
        breakStart: '15:00:00',
        breakEnd: '16:00:00',
      },
      {
        email: 'meera@luxesalon.com',
        phone: '+919833000006',
        name: 'Meera Nair',
        role: 'PROFESSIONAL',
        tier: 'SENIOR_ESTHETICIAN',
        compensationPaise: 8000000n,
        workDays: [1, 2, 3, 4, 5], // Mon–Fri
        startTime: '09:00:00',
        endTime: '18:00:00',
        breakStart: '12:30:00',
        breakEnd: '13:30:00',
      },
    ],
    resources: [
      { name: 'Styling Chair 1', type: 'CHAIR' },
      { name: 'Washing Station A', type: 'CHAIR' },
      { name: 'Treatment Bed / Facial Room', type: 'BED' },
      { name: 'Nail Station 1', type: 'CHAIR' },
    ],
    services: [
      {
        name: 'Balayage & Olaplex Reconstruction',
        durationMinutes: 120,
        pricePaise: 550000n, // ₹5,500
        requiredResourceTypes: ['CHAIR'], // Needs Styling Chair + Washing Station
        eligibleStaffIndices: [2, 3], // Aarav & Zoya
      },
      {
        name: 'Precision Signature Haircut & Blowdry',
        durationMinutes: 45,
        pricePaise: 120000n, // ₹1,200
        requiredResourceTypes: ['CHAIR'],
        eligibleStaffIndices: [2, 3], // Aarav & Zoya
      },
      {
        name: 'Hydra-Clarifying Glow Facial',
        durationMinutes: 60,
        pricePaise: 350000n, // ₹3,500
        requiredResourceTypes: ['BED'],
        eligibleStaffIndices: [4], // Meera
      },
      {
        name: 'Classic Gel Pedicure & Foot Reflexology',
        durationMinutes: 45,
        pricePaise: 140000n, // ₹1,400
        requiredResourceTypes: ['CHAIR'],
        eligibleStaffIndices: [4], // Meera
      },
    ],
  },
];

export async function runSeed(): Promise<void> {
  console.log('--- Starting Multi-Tenant Database Seed (3 Verticals) ---');

  for (const spec of SEED_DATA) {
    console.log(`\n[Seeding Tenant: ${spec.name} (${spec.slug})]`);

    // 1. Provision Tenant
    const provisionRes = await TenantProvisioningService.provisionTenant({
      provisioningKey: spec.provisioningKey,
      name: spec.name,
      slug: spec.slug,
      ownerEmail: spec.ownerEmail,
      ownerPhone: spec.ownerPhone,
      ownerName: spec.ownerName,
    });
    const tenantId = provisionRes.tenantId;
    const branchId = provisionRes.branchId;
    const ownerId = provisionRes.ownerId;

    console.log(`  Tenant ID: ${tenantId}, Default Branch: ${branchId}`);

    // Update branch name to spec
    await DatabaseClient.withTenantTransaction(tenantId, async (client) => {
      await client.query('UPDATE branches SET name = $1 WHERE id = $2;', [spec.branchName, branchId]);

      // 2. Create Resources
      const resourceMap = new Map<string, ResourceId>();
      for (const resSpec of spec.resources) {
        const res = await CatalogueEligibilityService.createResource(client, tenantId, {
          branchId,
          name: resSpec.name,
          resourceType: resSpec.type,
        });
        resourceMap.set(resSpec.name, res.resourceId);
        console.log(`    Created Resource: ${resSpec.name} (${resSpec.type}) -> ${res.resourceId}`);
      }

      // 3. Create Staff, Assign Scoped Roles, Profiles & Working Hours
      const staffUserIds: UserId[] = [];

      for (const staffSpec of spec.staff) {
        const userRes = await client.query<{ id: string }>(
          `INSERT INTO users (email, phone_e164, name, password_hash)
           VALUES ($1, $2, $3, 'PASS_HASH_SEEDED')
           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
           RETURNING id;`,
          [staffSpec.email, staffSpec.phone, staffSpec.name]
        );
        const staffUserId = asUserId(userRes.rows[0].id);
        staffUserIds.push(staffUserId);

        // Assign Role
        await StaffRoleAssignmentService.assignRole(
          client,
          {
            userId: ownerId,
            email: spec.ownerEmail,
            isPlatformAdmin: false,
            tenantId,
            roles: [{ role: 'OWNER', scope: { type: 'TENANT' } }],
          },
          {
            targetUserId: staffUserId,
            role: staffSpec.role,
            scope: { type: 'BRANCH', branchId },
            tier: staffSpec.tier,
            baseCompensationPaise: toPaise(staffSpec.compensationPaise),
          }
        );

        // Set Working Hours
        for (const day of staffSpec.workDays) {
          await CatalogueEligibilityService.setWorkingHours(
            client,
            tenantId,
            branchId,
            staffUserId,
            day,
            staffSpec.startTime,
            staffSpec.endTime
          );

          // Set Break Window if present
          if (staffSpec.breakStart && staffSpec.breakEnd) {
            await client.query(
              `INSERT INTO professional_breaks (tenant_id, branch_id, professional_id, day_of_week, start_time, end_time)
               VALUES ($1, $2, $3, $4, $5, $6);`,
              [tenantId, branchId, staffUserId, day, staffSpec.breakStart, staffSpec.breakEnd]
            );
          }
        }

        console.log(`    Staff Configured: ${staffSpec.name} (${staffSpec.role}) - Shifts & Breaks Set`);
      }

      // 4. Create Services, Requirements & Eligibility Mappings
      for (const servSpec of spec.services) {
        const servRes = await CatalogueEligibilityService.createService(client, tenantId, {
          name: servSpec.name,
          durationMinutes: servSpec.durationMinutes,
          basePricePaise: toPaise(servSpec.pricePaise),
        });
        const serviceId = servRes.serviceId;

        // Service Resource Requirements
        for (const reqType of servSpec.requiredResourceTypes) {
          await client.query(
            `INSERT INTO service_resource_requirements (tenant_id, service_id, resource_type, quantity)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (tenant_id, service_id, resource_type) DO NOTHING;`,
            [tenantId, serviceId, reqType]
          );
        }

        // Map Eligibility for Specified Staff
        for (const staffIdx of servSpec.eligibleStaffIndices) {
          const eligibleStaffId = staffUserIds[staffIdx];
          await CatalogueEligibilityService.setEligibility(client, tenantId, serviceId, eligibleStaffId, true);
        }

        console.log(`    Service Created: ${servSpec.name} (Duration: ${servSpec.durationMinutes}m, ₹${Number(servSpec.pricePaise)/100})`);
      }
    });
  }

  console.log('\n--- Multi-Tenant Database Seed Complete ---');
}

// Allow direct execution: `tsx tools/seed.ts`
if (process.argv[1]?.endsWith('seed.ts')) {
  runSeed()
    .then(() => DatabaseClient.close())
    .catch((err) => {
      console.error('Seed execution error:', err);
      process.exit(1);
    });
}

