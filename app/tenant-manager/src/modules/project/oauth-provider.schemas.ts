/**
 * Zod validation schemas for per-tenant external OAuth provider endpoints.
 */

import { z } from 'zod'

/**
 * Body schema for PUT /admin/v1/projects/:ref/auth/external/google.
 *
 * When `enabled` is true, client_id / client_secret / redirect_uri are
 * required (GoTrue cannot construct the provider without them). When disabled,
 * they are optional so the provider can be turned off without resubmitting
 * credentials.
 */
export const googleProviderSchema = z
  .object({
    enabled: z.boolean(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    redirect_uri: z.string().url().optional(),
    skip_nonce_check: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.enabled) return
    for (const field of ['client_id', 'client_secret', 'redirect_uri'] as const) {
      if (!data[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required when enabled is true`,
        })
      }
    }
  })

export type GoogleProviderInput = z.infer<typeof googleProviderSchema>
