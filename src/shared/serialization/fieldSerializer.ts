// src/shared/serialization/fieldSerializer.ts
import { RoleType } from '../types/index.js';

export class FieldSerializer {
  /**
   * Serializes a staff entity or list of staff entities, stripping sensitive compensation fields
   * for roles without explicit compensation view permissions (e.g., FRONT_DESK_OPERATOR, PROFESSIONAL).
   */
  public static serializeStaff<T extends Record<string, unknown>>(
    data: T | T[],
    callerRoles: RoleType[]
  ): Record<string, unknown> | Array<Record<string, unknown>> {
    const isPrivileged = callerRoles.includes('OWNER') || callerRoles.includes('PLATFORM_ADMIN');

    const sanitize = (item: T): Record<string, unknown> => {
      const copy = { ...item };
      if (!isPrivileged) {
        delete copy['base_compensation_paise'];
        delete copy['commission_rate_bps'];
        delete copy['compensation'];
        delete copy['payroll_id'];
        delete copy['bank_account'];
      }
      return copy;
    };

    if (Array.isArray(data)) {
      return data.map(sanitize);
    }
    return sanitize(data);
  }

  /**
   * Serializes catalogue services and pricing, filtering out gateway credentials or cost metrics.
   */
  public static serializeCatalogue<T extends Record<string, unknown>>(
    data: T | T[],
    callerRoles: RoleType[]
  ): Record<string, unknown> | Array<Record<string, unknown>> {
    const isOwnerOrAdmin = callerRoles.includes('OWNER') || callerRoles.includes('PLATFORM_ADMIN');

    const sanitize = (item: T): Record<string, unknown> => {
      const copy = { ...item };
      if (!isOwnerOrAdmin) {
        delete copy['internal_margin_bps'];
        delete copy['cost_paise'];
        delete copy['gateway_keys'];
      }
      return copy;
    };

    if (Array.isArray(data)) {
      return data.map(sanitize);
    }
    return sanitize(data);
  }
}

