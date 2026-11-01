// src/shared/errors/index.ts

export abstract class DomainError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly errorCode: string;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EntityNotFoundError extends DomainError {
  public readonly statusCode = 404;
  public readonly errorCode = 'ERR_RESOURCE_NOT_FOUND';

  constructor(resourceName: string, id?: string) {
    super(`The requested ${resourceName} was not found.`);
  }
}

/**
 * Thrown whenever cross-tenant access, foreign IDs, or unauthorized scope accesses occur.
 * Invariant: Must present identical semantics and status to EntityNotFoundError to prevent ID enumeration.
 */
export class TenantIsolationViolationError extends DomainError {
  public readonly statusCode = 404;
  public readonly errorCode = 'ERR_RESOURCE_NOT_FOUND';

  constructor() {
    super('The requested resource was not found.');
  }
}

export class AuthorizationDeniedError extends DomainError {
  public readonly statusCode = 403;
  public readonly errorCode = 'ERR_FORBIDDEN';

  constructor(action: string, reason?: string) {
    super(`Permission denied for action: ${action}${reason ? ` (${reason})` : ''}`);
  }
}

export class PrivilegeEscalationError extends DomainError {
  public readonly statusCode = 403;
  public readonly errorCode = 'ERR_PRIVILEGE_ESCALATION';

  constructor(message: string) {
    super(`Privilege escalation denied: ${message}`);
  }
}

export class ConcurrencyConflictError extends DomainError {
  public readonly statusCode = 409;
  public readonly errorCode = 'ERR_CONCURRENCY_CONFLICT';

  constructor(message: string) {
    super(message);
  }
}

export class InvariantViolationError extends DomainError {
  public readonly statusCode = 422;
  public readonly errorCode = 'ERR_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}

export class IdempotencyConflictError extends DomainError {
  public readonly statusCode = 409;
  public readonly errorCode = 'ERR_IDEMPOTENCY_CONFLICT';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Global Anti-Enumeration Error Formatter.
 * Invariant: Cross-tenant probes and non-existent IDs return the exact same HTTP 404 response body and headers.
 */
export async function formatErrorResponse(error: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  // Constant-time execution baseline to mitigate timing attacks on probe requests
  const start = process.hrtime.bigint();

  let status = 500;
  let code = 'ERR_INTERNAL_SERVER_ERROR';
  let message = 'An unexpected internal error occurred.';

  if (error instanceof TenantIsolationViolationError || error instanceof EntityNotFoundError) {
    status = 404;
    code = 'ERR_RESOURCE_NOT_FOUND';
    message = 'The requested resource was not found.';
  } else if (error instanceof DomainError) {
    status = error.statusCode;
    code = error.errorCode;
    message = error.message;
  }

  // Artificial jitter / padding up to minimum threshold if fast 404 lookup
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  if (status === 404 && elapsedMs < 2) {
    await new Promise((resolve) => setTimeout(resolve, 2 - elapsedMs));
  }

  return {
    status,
    body: {
      success: false,
      error: {
        code,
        message,
      },
    },
  };
}

