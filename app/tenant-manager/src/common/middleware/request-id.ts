/**
 * Request ID middleware for request tracing
 * Adds X-Request-ID header to all requests and responses
 */

import crypto from 'crypto'
import type { FastifyInstance } from 'fastify'

/**
 * Register request-id hook on a Fastify instance
 */
export function registerRequestId(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const requestId =
      (request.headers['x-request-id'] as string) || crypto.randomUUID()
    // Attach to request for downstream use
    request.headers['x-request-id'] = requestId
    // Echo back in response
    reply.header('x-request-id', requestId)
  })
}
