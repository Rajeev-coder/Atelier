// src/shared/middleware/pipeline.ts
import pg from 'pg';
import { DatabaseClient } from '../database/connection.js';
import { ActorContext, TenantId } from '../types/index.js';
import { AuditLogger } from '../audit/auditLogger.js';
import { FieldSerializer } from '../serialization/fieldSerializer.js';
import { formatErrorResponse, DomainError } from '../errors/index.js';
import { ActionName, PolicyEngine } from '../policy/policyEngine.js';

export interface ExecutionRequest<TInput> {
  actor: ActorContext;
  action: ActionName;
  resourceType: string;
  resourceId?: string;
  branchId?: string | null;
  input: TInput;
  serializationType?: 'STAFF' | 'CATALOGUE' | 'NONE';
}

export interface ExecutionResponse<TOutput> {
  statusCode: number;
  data?: TOutput;
  error?: Record<string, unknown>;
}

export class ExecutionPipeline {
  /**
   * Complete unified pipeline:
   * Authenticate -> Set DB Session -> Resolve Scoped Role -> Check Policy -> Execute Handler -> Serialize -> Write Audit
   */
  public static async execute<TInput, TOutput extends Record<string, unknown> | Array<Record<string, unknown>>>(
    request: ExecutionRequest<TInput>,
    handler: (client: pg.PoolClient, actor: ActorContext) => Promise<TOutput>
  ): Promise<ExecutionResponse<TOutput>> {
    const { actor, action, resourceType, branchId, input, serializationType = 'NONE' } = request;
    const tenantId = actor.tenantId;

    try {
      // 1. Evaluate Policy before opening database transaction
      PolicyEngine.assertCan(actor, action, {
        branchId: branchId ? (branchId as any) : undefined,
        targetUserId: actor.userId,
      });

      // 2. Open transaction with strict session tenancy (RLS)
      const output = await DatabaseClient.withTenantTransaction(tenantId, async (client) => {
        // Execute business logic inside tenant context
        const rawResult = await handler(client, actor);

        // 3. Write immutable audit log on success
        await AuditLogger.log(client, {
          tenantId,
          actorId: actor.userId,
          actorType: actor.isPlatformAdmin ? 'PLATFORM_ADMIN' : 'USER',
          role: actor.roles[0]?.role,
          scope: actor.roles[0]?.scope,
          action,
          resourceType,
          resourceId: request.resourceId || 'N/A',
          diff: typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null,
          ipAddress: actor.ipAddress,
          outcome: 'SUCCESS',
        });

        return rawResult;
      });

      // 4. Role-based Field Serialization
      const callerRoles = actor.roles.map((r) => r.role);
      let serializedData = output;

      if (serializationType === 'STAFF') {
        serializedData = FieldSerializer.serializeStaff(output, callerRoles) as TOutput;
      } else if (serializationType === 'CATALOGUE') {
        serializedData = FieldSerializer.serializeCatalogue(output, callerRoles) as TOutput;
      }

      return {
        statusCode: 200,
        data: serializedData,
      };
    } catch (err) {
      // Record failure audit row in an isolated transaction
      try {
        await DatabaseClient.withTenantTransaction(tenantId, async (client) => {
          await AuditLogger.log(client, {
            tenantId,
            actorId: actor.userId,
            actorType: actor.isPlatformAdmin ? 'PLATFORM_ADMIN' : 'USER',
            role: actor.roles[0]?.role,
            scope: actor.roles[0]?.scope,
            action,
            resourceType,
            resourceId: request.resourceId || 'N/A',
            diff: { error: err instanceof Error ? err.message : String(err) },
            ipAddress: actor.ipAddress,
            outcome: err instanceof DomainError && err.statusCode === 403 ? 'DENIED' : 'ERROR',
          });
        });
      } catch (auditErr) {
        console.error('Failed to write failure audit record', auditErr);
      }

      const formatted = await formatErrorResponse(err);
      return {
        statusCode: formatted.status,
        error: formatted.body,
      };
    }
  }
}

