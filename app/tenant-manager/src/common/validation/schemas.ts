/**
 * Common validation schemas
 */

import { z } from 'zod'

// Sort options for projects
export const sortOptions = ['name_asc', 'name_desc', 'created_asc', 'created_desc'] as const
export type SortOption = (typeof sortOptions)[number]

// Common pagination schema
export const paginationSchema = z.object({
  page: z.string().optional().transform((v) => (v ? parseInt(v, 10) : 1)),
  limit: z.string().optional().transform((v) => (v ? Math.min(parseInt(v, 10), 100) : 50)),
  sort: z.enum(sortOptions).optional().default('name_asc'),
  search: z.string().optional(),
})

export const projectRefSchema = z.object({
  ref: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
})

export const instanceIdSchema = z.object({
  id: z.string().transform((v) => parseInt(v, 10)),
})
