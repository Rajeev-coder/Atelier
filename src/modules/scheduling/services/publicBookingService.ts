// src/modules/scheduling/services/publicBookingService.ts
import pg from 'pg';
import {
  TenantId,
  BranchId,
  ServiceId,
  UserId,
  asTenantId,
  asBranchId,
} from '../../../shared/types/index.js';
import {
  TenantIsolationViolationError,
  InvariantViolationError,
  ConcurrencyConflictError,
  EntityNotFoundError,
} from '../../../shared/errors/index.js';
import { CatalogueEligibilityService } from '../../catalogue/services/catalogueEligibilityService.js';
import { CustomerService } from '../../customers/services/customerService.js';
import { PhoneNormalizer } from '../../../shared/utils/phoneNormalizer.js';
import { AuditLogger } from '../../../shared/audit/auditLogger.js';

export interface PublicCatalogueItem {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  basePricePaise: string;
}

export interface OnlineGuestBookingInput {
  branchId: BranchId;
  serviceId: ServiceId;
  professionalId: UserId;
  customerPhone: string;
  customerFirstName: string;
  customerLastName?: string;
  startTime: string; // ISO 8601
  resourceIds: string[];
  holdId?: string;
  otpVerifiedToken?: string;
  tamperedPricePaise?: string; // Tampered price sent by client (MUST BE DISCARDED)
}

export interface OnlineBookingResult {
  appointmentId: string;
  status: string;
  startTime: string;
  endTime: string;
  lockedPricePaise: string;
  customerId: string;
  assignedResourceIds: string[];
}

export class PublicBookingService {
  /**
   * Resolves a tenant by Host header or subdomain hint.
   * E.g. 'iron-forge.platform.test' or 'iron-forge-gym' -> Tenant
   */
  public static async resolveTenantByHost(
    client: pg.PoolClient,
    hostHeaderOrSlug: string
  ): Promise<{ tenantId: TenantId; slug: string; name: string }> {
    // Strip port and split subdomain (e.g. 'iron-forge.platform.test:3000' -> 'iron-forge')
    const clean = hostHeaderOrSlug.split(':')[0].trim();
    let slug = clean;
    if (clean.includes('.')) {
      slug = clean.split('.')[0];
    }

    const res = await client.query<{ id: string; slug: string; name: string; status: string }>(
      "SELECT id, slug, name, status FROM tenants WHERE (slug = $1 OR slug = $2) AND status != 'SUSPENDED';",
      [clean, slug]
    );

    if (res.rows.length === 0) {
      // Uniform 404 anti-enumeration response
      throw new TenantIsolationViolationError();
    }

    return {
      tenantId: asTenantId(res.rows[0].id),
      slug: res.rows[0].slug,
      name: res.rows[0].name,
    };
  }

  /**
   * Returns sanitized public catalogue services for the storefront.
   * Completely excludes internal margins, cost prices, or staff compensation.
   */
  public static async getPublicCatalogue(
    client: pg.PoolClient,
    tenantId: TenantId
  ): Promise<PublicCatalogueItem[]> {
    const res = await client.query<{
      id: string;
      name: string;
      description: string | null;
      duration_minutes: number;
      base_price_paise: string;
    }>(
      `SELECT id, name, description, duration_minutes, base_price_paise 
       FROM services 
       WHERE tenant_id = $1 AND is_active = TRUE
       ORDER BY name ASC;`,
      [tenantId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      durationMinutes: row.duration_minutes,
      basePricePaise: row.base_price_paise,
    }));
  }

  /**
   * Creates an online guest booking with server-side price protection and OTP requirement for first-time guests.
   */
  public static async createOnlineBooking(
    client: pg.PoolClient,
    tenantId: TenantId,
    input: OnlineGuestBookingInput
  ): Promise<OnlineBookingResult> {
    const normalizedPhone = PhoneNormalizer.normalizeE164(input.customerPhone);

    // 1. First-Time Guest Check: Check if customer already exists in this tenant
    const existingCust = await client.query<{ id: string }>(
      'SELECT id FROM customers WHERE tenant_id = $1 AND phone_e164 = $2;',
      [tenantId, normalizedPhone]
    );

    const isFirstTimeGuest = existingCust.rows.length === 0;

    // Invariant: First-time online guests MUST provide a verified OTP token
    if (isFirstTimeGuest && !input.otpVerifiedToken) {
      throw new InvariantViolationError(
        'First-time online bookings require phone verification via OTP before confirmation.'
      );
    }

    // 2. Server-Side Price Guard: DISCARD any client-submitted price (e.g. input.tamperedPricePaise)
    // Server independently recalculates and locks the price quote
    const quote = await CatalogueEligibilityService.calculateServiceQuote(
      client,
      tenantId,
      input.serviceId,
      input.professionalId
    );

    const startDate = new Date(input.startTime);
    const endDate = new Date(startDate.getTime() + quote.durationMinutes * 60 * 1000);
    const endTime = endDate.toISOString();

    // 3. Resolve or Create Customer
    const customer = await CustomerService.findOrCreateCustomer(client, tenantId, {
      phone: normalizedPhone,
      firstName: input.customerFirstName,
      lastName: input.customerLastName,
      consentWhatsApp: true,
      consentWordingVersion: 'v1.0-online-booking-web',
    });

    // 4. Handle Hold consumption if hold was acquired
    if (input.holdId) {
      const holdRes = await client.query<{ status: string; expires_at: Date }>(
        'SELECT status, expires_at FROM slot_holds WHERE tenant_id = $1 AND id = $2;',
        [tenantId, input.holdId]
      );
      if (holdRes.rows.length === 0 || holdRes.rows[0].status !== 'ACTIVE' || new Date(holdRes.rows[0].expires_at) <= new Date()) {
        throw new ConcurrencyConflictError('Slot hold has expired or was already consumed.');
      }

      await client.query("UPDATE slot_holds SET status = 'CONSUMED' WHERE tenant_id = $1 AND id = $2;", [
        tenantId,
        input.holdId,
      ]);
      await client.query("UPDATE appointment_resources SET status = 'RELEASED' WHERE tenant_id = $1 AND hold_id = $2;", [
        tenantId,
        input.holdId,
      ]);
    }

    try {
      // 5. Insert Appointment (Database GiST exclusion constraint blocks concurrent double bookings)
      const apptRes = await client.query<{ id: string; status: string }>(
        `INSERT INTO appointments (
          tenant_id, branch_id, customer_id, service_id, professional_id,
          start_time, end_time, status, locked_price_paise
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED', $8)
        RETURNING id, status;`,
        [
          tenantId,
          input.branchId,
          customer.id,
          input.serviceId,
          input.professionalId,
          input.startTime,
          endTime,
          quote.totalPricePaise.toString(), // Locked server quote, NOT tampered price!
        ]
      );
      const apptId = apptRes.rows[0].id;

      // 6. Assign Required Resources under CONFIRMED status
      for (const resId of input.resourceIds) {
        await client.query(
          `INSERT INTO appointment_resources (
            tenant_id, appointment_id, resource_id, start_time, end_time, status
          ) VALUES ($1, $2, $3, $4, $5, 'CONFIRMED');`,
          [tenantId, apptId, resId, input.startTime, endTime]
        );
      }

      // 7. Write Audit Log
      await AuditLogger.log(client, {
        tenantId,
        actorId: null,
        actorType: 'CUSTOMER',
        action: 'booking:online_guest_confirmed',
        resourceType: 'appointments',
        resourceId: apptId,
        diff: {
          lockedPricePaise: quote.totalPricePaise.toString(),
          ignoredTamperedPrice: input.tamperedPricePaise || null,
          phone: normalizedPhone,
        },
        outcome: 'SUCCESS',
      });

      return {
        appointmentId: apptId,
        status: apptRes.rows[0].status,
        startTime: input.startTime,
        endTime,
        lockedPricePaise: quote.totalPricePaise.toString(),
        customerId: customer.id,
        assignedResourceIds: input.resourceIds,
      };
    } catch (err: any) {
      if (err.code === '23P01' || (err.message && err.message.includes('exclusion'))) {
        throw new ConcurrencyConflictError(
          'The requested slot or required resource is no longer available.'
        );
      }
      throw err;
    }
  }
}

