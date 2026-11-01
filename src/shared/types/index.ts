// src/shared/types/index.ts

export type TenantId = string & { readonly __brand: unique symbol };
export type UserId = string & { readonly __brand: unique symbol };
export type BranchId = string & { readonly __brand: unique symbol };
export type ServiceId = string & { readonly __brand: unique symbol };
export type ResourceId = string & { readonly __brand: unique symbol };
export type Paise = bigint & { readonly __brand: unique symbol };

export type RoleType = 'PLATFORM_ADMIN' | 'OWNER' | 'BRANCH_MANAGER' | 'RECEPTIONIST' | 'PROFESSIONAL';
export type ScopeType = 'TENANT' | 'BRANCH' | 'SELF';
export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED';
export type ResourceKind = 'ROOM' | 'BED' | 'CHAIR' | 'EQUIPMENT';

export interface ScopeDefinition {
  type: ScopeType;
  branchId?: BranchId | null;
  userId?: UserId | null;
}

export interface ActorContext {
  userId: UserId;
  email: string;
  isPlatformAdmin: boolean;
  tenantId: TenantId;
  roles: Array<{
    role: RoleType;
    scope: ScopeDefinition;
  }>;
  ipAddress?: string;
}

export interface SecurityContext {
  tenantId: TenantId;
  actor: ActorContext;
}

export function asTenantId(id: string): TenantId {
  return id as TenantId;
}

export function asUserId(id: string): UserId {
  return id as UserId;
}

export function asBranchId(id: string): BranchId {
  return id as BranchId;
}

export function asServiceId(id: string): ServiceId {
  return id as ServiceId;
}

export function asResourceId(id: string): ResourceId {
  return id as ResourceId;
}

export function toPaise(amount: number | bigint | string): Paise {
  return BigInt(amount) as Paise;
}

