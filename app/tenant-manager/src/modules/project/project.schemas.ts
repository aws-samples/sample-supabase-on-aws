/**
 * Zod validation schemas for project endpoints
 */

import { z } from 'zod'
import { paginationSchema } from '../../common/validation/schemas.js'

export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  ref: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  db_instance_id: z.number().int().positive().optional(),
  instance_identifier: z.string().min(1).max(64).optional(),
  region: z.string().max(64).optional(),
  organization_id: z.number().int().positive().optional(),
  strategy: z.enum([
    'manual', 'hash', 'round_robin', 'weighted_round_robin', 'least_connections', 'region_affinity',
  ]).optional(),
})

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
})

export const listProjectsSchema = paginationSchema.extend({
  status: z.enum([
    'ACTIVE_HEALTHY', 'COMING_UP', 'GOING_DOWN', 'INACTIVE', 'INIT_FAILED',
    'REMOVED', 'RESTORING', 'UNKNOWN', 'UPGRADING', 'PAUSING', 'PAUSED',
  ]).optional(),
  region: z.string().optional(),
  db_instance_id: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)),
  statuses: z.string().optional(),
})
