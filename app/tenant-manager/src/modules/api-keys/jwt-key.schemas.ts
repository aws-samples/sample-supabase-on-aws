/**
 * Zod validation schemas for JWT key endpoints
 */

import { z } from 'zod'

export const jwtKeyProjectRefSchema = z.object({
  ref: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
})
