// src/modules/customers/services/customerService.ts
import pg from 'pg';
import { TenantId, UserId } from '../../../shared/types/index.js';
import { PhoneNormalizer } from '../../../shared/utils/phoneNormalizer.js';

export interface CustomerRecord {
  id: string;
  tenant_id: string;
  first_name: string;
  last_name: string;
  phone_e164: string;
  email: string | null;
  consent_whatsapp: boolean;
  consent_timestamp: string | null;
  consent_wording_version: string | null;
  created_at: string;
}

export interface FindOrCreateCustomerInput {
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  consentWhatsApp?: boolean;
  consentWordingVersion?: string;
}

export interface CustomerProfileWithHistory {
  customer: CustomerRecord;
  upcomingAppointments: Array<Record<string, unknown>>;
  pastAppointments: Array<Record<string, unknown>>;
}

export class CustomerService {
  /**
   * Finds or creates a customer record by normalized E.164 phone within the caller's tenant.
   * Guarantees that identical phones in different tenants are completely isolated.
   */
  public static async findOrCreateCustomer(
    client: pg.PoolClient,
    tenantId: TenantId,
    input: FindOrCreateCustomerInput
  ): Promise<CustomerRecord> {
    const normalizedPhone = PhoneNormalizer.normalizeE164(input.phone);

    // 1. Try finding existing customer
    const existing = await client.query<CustomerRecord>(
      'SELECT * FROM customers WHERE tenant_id = $1 AND phone_e164 = $2;',
      [tenantId, normalizedPhone]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // 2. Insert new customer record with in-person consent
    const consentTimestamp = input.consentWhatsApp ? new Date().toISOString() : null;
    const res = await client.query<CustomerRecord>(
      `INSERT INTO customers (
        tenant_id,
        first_name,
        last_name,
        phone_e164,
        email,
        consent_whatsapp,
        consent_timestamp,
        consent_wording_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;`,
      [
        tenantId,
        input.firstName || 'Walk-in',
        input.lastName || 'Guest',
        normalizedPhone,
        input.email || null,
        input.consentWhatsApp ?? false,
        consentTimestamp,
        input.consentWordingVersion || 'v1.0-desk',
      ]
    );

    return res.rows[0];
  }

  /**
   * Retrieves customer profile along with upcoming and past appointments for desk view.
   */
  public static async getCustomerDetails(
    client: pg.PoolClient,
    tenantId: TenantId,
    customerId: string
  ): Promise<CustomerProfileWithHistory | null> {
    const customerRes = await client.query<CustomerRecord>(
      'SELECT * FROM customers WHERE tenant_id = $1 AND id = $2;',
      [tenantId, customerId]
    );

    if (customerRes.rows.length === 0) {
      return null;
    }

    const appointmentsRes = await client.query(
      `SELECT 
        a.id,
        a.service_id,
        s.name as service_name,
        a.professional_id,
        u.name as professional_name,
        a.start_time,
        a.end_time,
        a.status,
        a.locked_price_paise,
        a.is_manager_override
      FROM appointments a
      JOIN services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
      JOIN users u ON u.id = a.professional_id
      WHERE a.tenant_id = $1 AND a.customer_id = $2
      ORDER BY a.start_time DESC;`,
      [tenantId, customerId]
    );

    const now = new Date();
    const upcoming: Array<Record<string, unknown>> = [];
    const past: Array<Record<string, unknown>> = [];

    for (const appt of appointmentsRes.rows) {
      if (new Date(appt.start_time) >= now && appt.status !== 'CANCELLED') {
        upcoming.push(appt);
      } else {
        past.push(appt);
      }
    }

    return {
      customer: customerRes.rows[0],
      upcomingAppointments: upcoming,
      pastAppointments: past,
    };
  }
}

