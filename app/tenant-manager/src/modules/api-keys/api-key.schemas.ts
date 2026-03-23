/**
 * Zod validation schemas for API key endpoints
 */

import { z } from 'zod'

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['publishable', 'secret']),
  role: z.enum(['anon', 'service_role']),
  description: z.string().max(1000).optional(),
})

export const apiKeyParamsSchema = z.object({
  ref: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  keyId: z.string().uuid(),
})

export const projectRefOnlySchema = z.object({
  ref: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
})
