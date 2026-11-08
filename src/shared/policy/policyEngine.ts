// src/shared/policy/policyEngine.ts
import { ActorContext, RoleType, ScopeDefinition, BranchId, UserId } from '../types/index.js';
import { AuthorizationDeniedError, PrivilegeEscalationError, TenantIsolationViolationError } from '../errors/index.js';

export type ActionName =
  | 'tenant:provision'
  | 'tenant:view'
  | 'tenant:update'
  | 'branch:create'
  | 'branch:view'
  | 'branch:update'
  | 'staff:assign_role'
  | 'staff:view_compensation'
  | 'staff:update_profile'
  | 'service:create'
  | 'service:update'
  | 'service:view'
  | 'resource:create'
  | 'resource:update'
  | 'resource:view'
  | 'eligibility:manage'
  | 'pricing:manage'
  | 'schedule:manage';

const ROLE_PERMISSIONS: Record<RoleType, Set<ActionName>> = {
  PLATFORM_ADMIN: new Set<ActionName>([
    'tenant:provision',
    'tenant:view',
    'tenant:update',
  ]),
  OWNER: new Set<ActionName>([
    'tenant:view',
    'tenant:update',
    'branch:create',
    'branch:view',
    'branch:update',
    'staff:assign_role',
    'staff:view_compensation',
    'staff:update_profile',
    'service:create',
    'service:update',
    'service:view',
    'resource:create',
    'resource:update',
    'resource:view',
    'eligibility:manage',
    'pricing:manage',
    'schedule:manage',
  ]),
  BRANCH_MANAGER: new Set<ActionName>([
    'branch:view',
    'branch:update',
    'staff:assign_role',
    'service:view',
    'resource:create',
    'resource:update',
    'resource:view',
    'eligibility:manage',
    'schedule:manage',
  ]),
  FRONT_DESK_OPERATOR: new Set<ActionName>([
    'branch:view',
    'service:view',
    'resource:view',
  ]),
  RECEPTIONIST: new Set<ActionName>([
    'branch:view',
    'service:view',
    'resource:view',
  ]),
  PROFESSIONAL: new Set<ActionName>([
    'branch:view',
    'service:view',
    'resource:view',
  ]),
  SERVICE_PROVIDER: new Set<ActionName>([
    'branch:view',
    'service:view',
    'resource:view',
  ]),
};

export class PolicyEngine {
  /**
   * Asserts whether an actor can execute an action on a target resource within a specific scope.
   * Throws TenantIsolationViolationError (maps to uniform 404) or AuthorizationDeniedError.
   */
  public static assertCan(
    actor: ActorContext,
    action: ActionName,
    target: {
      branchId?: BranchId | null;
      targetUserId?: UserId | null;
    }
  ): void {
    if (actor.isPlatformAdmin && ROLE_PERMISSIONS.PLATFORM_ADMIN.has(action)) {
      return;
    }

    let authorized = false;

    for (const assignment of actor.roles) {
      const allowedActions = ROLE_PERMISSIONS[assignment.role];
      if (!allowedActions || !allowedActions.has(action)) {
        continue;
      }

      // Check Scope Invariants
      switch (assignment.scope.type) {
        case 'TENANT':
          // Tenant-wide scope covers all branches and entities inside the tenant
          authorized = true;
          break;

        case 'BRANCH':
          // Branch scope requires matching the target branch
          if (target.branchId && assignment.scope.branchId === target.branchId) {
            authorized = true;
          }
          break;

        case 'SELF':
          // Self scope requires matching target user ID
          if (target.targetUserId && assignment.scope.userId === target.targetUserId) {
            authorized = true;
          }
          break;
      }

      if (authorized) {
        break;
      }
    }

    if (!authorized) {
      // Invariant: If actor is scoped to a branch and attempts to probe another branch,
      // return TenantIsolationViolationError (uniform 404) to prevent resource enumeration.
      if (target.branchId && actor.roles.some((r) => r.scope.type === 'BRANCH')) {
        throw new TenantIsolationViolationError();
      }
      throw new AuthorizationDeniedError(action, 'Role or scope mismatch');
    }
  }

  /**
   * Privilege Escalation Check: A grantor cannot assign a role with permissions they do not possess.
   */
  public static assertCanAssignRole(
    grantor: ActorContext,
    roleToAssign: RoleType,
    targetScope: ScopeDefinition
  ): void {
    if (grantor.isPlatformAdmin) {
      return;
    }

    // Only OWNER can assign OWNER or TENANT scoped roles
    if (roleToAssign === 'OWNER' || targetScope.type === 'TENANT') {
      const isOwner = grantor.roles.some((r) => r.role === 'OWNER' && r.scope.type === 'TENANT');
      if (!isOwner) {
        throw new PrivilegeEscalationError('Only tenant owners can grant OWNER or TENANT-scoped permissions.');
      }
    }

    // Branch Managers can only assign roles within their assigned branch
    const isBranchManager = grantor.roles.some((r) => r.role === 'BRANCH_MANAGER');
    if (isBranchManager && !grantor.roles.some((r) => r.role === 'OWNER')) {
      if (targetScope.type !== 'BRANCH' || !targetScope.branchId) {
        throw new PrivilegeEscalationError('Branch Managers can only assign roles scoped to their specific branch.');
      }

      const hasBranchAccess = grantor.roles.some(
        (r) => r.role === 'BRANCH_MANAGER' && r.scope.branchId === targetScope.branchId
      );

      if (!hasBranchAccess) {
        // Uniform 404 to hide foreign branch existence
        throw new TenantIsolationViolationError();
      }

      // Cannot assign OWNER or BRANCH_MANAGER
      if (roleToAssign === 'OWNER' || roleToAssign === 'BRANCH_MANAGER') {
        throw new PrivilegeEscalationError('Branch Managers cannot grant OWNER or BRANCH_MANAGER roles.');
      }
    }
  }
}

