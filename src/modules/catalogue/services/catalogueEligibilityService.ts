// src/modules/catalogue/services/catalogueEligibilityService.ts
import pg from 'pg';
import {
  TenantId,
  BranchId,
  ServiceId,
  UserId,
  ResourceId,
  Paise,
  ResourceKind,
  asServiceId,
  asResourceId,
} from '../../../shared/types/index.js';
import { InvariantViolationError, EntityNotFoundError } from '../../../shared/errors/index.js';

export interface CreateServiceInput {
  name: string;
  description?: string;
  durationMinutes: number;
  basePricePaise: Paise;
}

export interface CreateResourceInput {
  branchId: BranchId;
  name: string;
  resourceType: ResourceKind;
}

export interface ServiceQuote {
  serviceId: ServiceId;
  professionalId: UserId;
  basePricePaise: Paise;
  adjustmentPaise: Paise;
  totalPricePaise: Paise;
  durationMinutes: number;
}

export class CatalogueEligibilityService {
  /**
   * Creates a catalogue service with positive duration and non-negative base price in integer paise.
   */
  public static async createService(
    client: pg.PoolClient,
    tenantId: TenantId,
    input: CreateServiceInput
  ): Promise<{ serviceId: ServiceId }> {
    if (input.durationMinutes <= 0) {
      throw new InvariantViolationError('Service duration must be greater than zero.');
    }
    if (input.basePricePaise < 0n) {
      throw new InvariantViolationError('Service base price cannot be negative.');
    }

    const res = await client.query<{ id: string }>(
      `INSERT INTO services (tenant_id, name, description, duration_minutes, base_price_paise)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id;`,
      [tenantId, input.name, input.description || null, input.durationMinutes, input.basePricePaise.toString()]
    );

    return { serviceId: asServiceId(res.rows[0].id) };
  }

  /**
   * Creates a physical or room resource scoped strictly to a tenant branch.
   */
  public static async createResource(
    client: pg.PoolClient,
    tenantId: TenantId,
    input: CreateResourceInput
  ): Promise<{ resourceId: ResourceId }> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO resources (tenant_id, branch_id, name, resource_type)
       VALUES ($1, $2, $3, $4)
       RETURNING id;`,
      [tenantId, input.branchId, input.name, input.resourceType]
    );

    return { resourceId: asResourceId(res.rows[0].id) };
  }

  /**
   * Axis 4: Maps a professional's eligibility to perform a service.
   * Completely decoupled from Tier, Pay, or Price Adjustment.
   */
  public static async setEligibility(
    client: pg.PoolClient,
    tenantId: TenantId,
    serviceId: ServiceId,
    professionalId: UserId,
    isEligible: boolean
  ): Promise<void> {
    if (isEligible) {
      await client.query(
        `INSERT INTO service_professional_eligibility (tenant_id, service_id, professional_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, service_id, professional_id) DO NOTHING;`,
        [tenantId, serviceId, professionalId]
      );
    } else {
      await client.query(
        `DELETE FROM service_professional_eligibility
         WHERE tenant_id = $1 AND service_id = $2 AND professional_id = $3;`,
        [tenantId, serviceId, professionalId]
      );
    }
  }

  /**
   * Axis 3: Configures professional-specific price adjustment on a service.
   * Completely decoupled from professional compensation or eligibility.
   */
  public static async setProfessionalPriceAdjustment(
    client: pg.PoolClient,
    tenantId: TenantId,
    serviceId: ServiceId,
    professionalId: UserId,
    adjustmentPaise: Paise
  ): Promise<void> {
    if (adjustmentPaise < 0n) {
      throw new InvariantViolationError('Price adjustment cannot be negative.');
    }

    await client.query(
      `INSERT INTO professional_service_prices (tenant_id, service_id, professional_id, price_adjustment_paise)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, service_id, professional_id)
       DO UPDATE SET price_adjustment_paise = EXCLUDED.price_adjustment_paise;`,
      [tenantId, serviceId, professionalId, adjustmentPaise.toString()]
    );
  }

  /**
   * Axis 1 & 2: Updates staff tier and base compensation without impacting Axis 3 or Axis 4.
   */
  public static async updateStaffTierAndCompensation(
    client: pg.PoolClient,
    tenantId: TenantId,
    professionalId: UserId,
    tier: string,
    baseCompensationPaise: Paise
  ): Promise<void> {
    if (baseCompensationPaise < 0n) {
      throw new InvariantViolationError('Base compensation cannot be negative.');
    }

    const res = await client.query(
      `UPDATE staff_profiles
       SET tier = $1, base_compensation_paise = $2, updated_at = NOW()
       WHERE tenant_id = $3 AND user_id = $4;`,
      [tier, baseCompensationPaise.toString(), tenantId, professionalId]
    );

    if (res.rowCount === 0) {
      throw new EntityNotFoundError('StaffProfile', professionalId);
    }
  }

  /**
   * Calculates a finalized service price quote for a booking, verifying eligibility first.
   */
  public static async calculateServiceQuote(
    client: pg.PoolClient,
    tenantId: TenantId,
    serviceId: ServiceId,
    professionalId: UserId
  ): Promise<ServiceQuote> {
    // 1. Check Service Existence & Active Status
    const serviceRes = await client.query<{ duration_minutes: number; base_price_paise: string; is_active: boolean }>(
      'SELECT duration_minutes, base_price_paise, is_active FROM services WHERE tenant_id = $1 AND id = $2;',
      [tenantId, serviceId]
    );

    if (serviceRes.rows.length === 0 || !serviceRes.rows[0].is_active) {
      throw new EntityNotFoundError('Service', serviceId);
    }

    const durationMinutes = serviceRes.rows[0].duration_minutes;
    const basePricePaise = BigInt(serviceRes.rows[0].base_price_paise) as Paise;

    // 2. Check Axis 4: Professional Eligibility
    const eligibilityRes = await client.query(
      'SELECT 1 FROM service_professional_eligibility WHERE tenant_id = $1 AND service_id = $2 AND professional_id = $3;',
      [tenantId, serviceId, professionalId]
    );

    if (eligibilityRes.rows.length === 0) {
      throw new InvariantViolationError('Professional is not eligible to perform this service.');
    }

    // 3. Check Axis 3: Professional Price Adjustment
    const adjustmentRes = await client.query<{ price_adjustment_paise: string }>(
      'SELECT price_adjustment_paise FROM professional_service_prices WHERE tenant_id = $1 AND service_id = $2 AND professional_id = $3;',
      [tenantId, serviceId, professionalId]
    );

    const adjustmentPaise = adjustmentRes.rows.length > 0
      ? (BigInt(adjustmentRes.rows[0].price_adjustment_paise) as Paise)
      : (0n as Paise);

    const totalPricePaise = (basePricePaise + adjustmentPaise) as Paise;

    return {
      serviceId,
      professionalId,
      basePricePaise,
      adjustmentPaise,
      totalPricePaise,
      durationMinutes,
    };
  }

  /**
   * Sets professional working hours for a branch.
   */
  public static async setWorkingHours(
    client: pg.PoolClient,
    tenantId: TenantId,
    branchId: BranchId,
    professionalId: UserId,
    dayOfWeek: number,
    startTime: string,
    endTime: string
  ): Promise<void> {
    if (dayOfWeek < 0 || dayOfWeek > 6) {
      throw new InvariantViolationError('Day of week must be between 0 (Sunday) and 6 (Saturday).');
    }

    await client.query(
      `INSERT INTO professional_working_hours (tenant_id, branch_id, professional_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, id) DO NOTHING;`,
      [tenantId, branchId, professionalId, dayOfWeek, startTime, endTime]
    );
  }
}

