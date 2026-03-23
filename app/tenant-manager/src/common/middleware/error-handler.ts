/**
 * Global error handling middleware
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { TenantManagerError } from '../errors/index.js'

/**
 * Format error response (RFC 7807 Problem Details inspired)
 */
function formatErrorResponse(
  _statusCode: number,
  message: string,
  code?: string,
  details?: unknown,
  requestId?: string
) {
  return {
    error: {
      message,
      code: code || 'INTERNAL_ERROR',
      ...(details !== undefined && { details }),
      ...(requestId && { requestId }),
    },
  }
}

/**
 * Global error handler for Fastify
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const requestId = (request.headers['x-request-id'] as string) || undefined

  // Log the error
  request.log.error({
    err: error,
    req: {
      method: request.method,
      url: request.url,
      params: request.params,
      query: request.query,
    },
  })

  // Handle TenantManagerError instances
  if (error instanceof TenantManagerError) {
    reply.status(error.statusCode).send(
      formatErrorResponse(
        error.statusCode,
        error.message,
        error.code,
        undefined,
        requestId
      )
    )
    return
  }

  // Handle Fastify validation errors
  if (error.validation) {
    reply.status(400).send(
      formatErrorResponse(
        400,
        'Validation error',
        'VALIDATION_ERROR',
        error.validation,
        requestId
      )
    )
    return
  }

  // Handle known HTTP errors
  if (error.statusCode && error.statusCode < 500) {
    reply.status(error.statusCode).send(
      formatErrorResponse(
        error.statusCode,
        error.message,
        error.code || 'CLIENT_ERROR',
        undefined,
        requestId
      )
    )
    return
  }

  // Default to 500 for unknown errors
  const statusCode = error.statusCode || 500
  const message = statusCode >= 500 ? 'Internal server error' : error.message

  reply.status(statusCode).send(
    formatErrorResponse(
      statusCode,
      message,
      error.code || 'INTERNAL_ERROR',
      undefined,
      requestId
    )
  )
}

/**
 * Not found handler
 */
export function notFoundHandler(
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const requestId = (request.headers['x-request-id'] as string) || undefined
  reply.status(404).send(
    formatErrorResponse(
      404,
      `Route ${request.method} ${request.url} not found`,
      'NOT_FOUND',
      undefined,
      requestId
    )
  )
}
