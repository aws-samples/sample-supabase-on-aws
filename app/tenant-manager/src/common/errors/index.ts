/**
 * Custom error classes for tenant-manager
 */

/**
 * Base error class for tenant-manager
 */
export class TenantManagerError extends Error {
  public readonly statusCode: number
  public readonly code: string

  constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
    super(message)
    this.name = 'TenantManagerError'
    this.statusCode = statusCode
    this.code = code
    Error.captureStackTrace(this, this.constructor)
  }
}

/**
 * Error for invalid requests (400)
 */
export class BadRequestError extends TenantManagerError {
  constructor(message: string, code: string = 'BAD_REQUEST') {
    super(message, 400, code)
    this.name = 'BadRequestError'
  }
}

/**
 * Error for unauthorized access (401)
 */
export class UnauthorizedError extends TenantManagerError {
  constructor(message: string = 'Unauthorized', code: string = 'UNAUTHORIZED') {
    super(message, 401, code)
    this.name = 'UnauthorizedError'
  }
}

/**
 * Error for forbidden access (403)
 */
export class ForbiddenError extends TenantManagerError {
  constructor(message: string = 'Forbidden', code: string = 'FORBIDDEN') {
    super(message, 403, code)
    this.name = 'ForbiddenError'
  }
}

/**
 * Error for not found resources (404)
 */
export class NotFoundError extends TenantManagerError {
  constructor(message: string, code: string = 'NOT_FOUND') {
    super(message, 404, code)
    this.name = 'NotFoundError'
  }
}

/**
 * Error for conflict/duplicate resources (409)
 */
export class ConflictError extends TenantManagerError {
  constructor(message: string, code: string = 'CONFLICT') {
    super(message, 409, code)
    this.name = 'ConflictError'
  }
}

/**
 * Error for database operations
 */
export class DatabaseError extends TenantManagerError {
  public readonly formattedError?: string

  constructor(message: string, code: string = 'DATABASE_ERROR', formattedError?: string) {
    super(message, 500, code)
    this.name = 'DatabaseError'
    this.formattedError = formattedError
  }
}

/**
 * Error for external service failures
 */
export class ExternalServiceError extends TenantManagerError {
  public readonly service: string

  constructor(message: string, service: string, code: string = 'EXTERNAL_SERVICE_ERROR') {
    super(message, 502, code)
    this.name = 'ExternalServiceError'
    this.service = service
  }
}

/**
 * Error for provisioning failures
 */
export class ProvisioningError extends TenantManagerError {
  public readonly rollbackPerformed: boolean

  constructor(message: string, rollbackPerformed: boolean = false) {
    super(message, 500, 'PROVISIONING_ERROR')
    this.name = 'ProvisioningError'
    this.rollbackPerformed = rollbackPerformed
  }
}
