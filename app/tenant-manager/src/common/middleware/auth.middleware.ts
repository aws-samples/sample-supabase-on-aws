/**
 * Authentication middleware for Admin API
 */

import type { FastifyRequest, FastifyReply } from 'fastify'
import { getEnv } from '../../config/index.js'
import { UnauthorizedError } from '../errors/index.js'

/**
 * Extract bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return null
  }

  return parts[1] || null
}

/**
 * Admin API key authentication hook
 * Validates Bearer token against ADMIN_API_KEY
 */
export async function adminAuthHook(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const env = getEnv()
  const token = extractBearerToken(request.headers.authorization)

  if (!token) {
    throw new UnauthorizedError('Missing authorization header')
  }

  if (token !== env.ADMIN_API_KEY) {
    throw new UnauthorizedError('Invalid API key')
  }

  // Token is valid - proceed with request
}

/**
 * Create a preHandler hook for protected routes
 */
export function createAuthPreHandler() {
  return adminAuthHook
}
