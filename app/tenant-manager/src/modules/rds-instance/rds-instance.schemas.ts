/**
 * Zod validation schemas for RDS instance endpoints
 */

import { z } from 'zod'
import { paginationSchema } from '../../common/validation/schemas.js'

export const createInstanceSchema = z.object({
  identifier: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional().default(5432),
  admin_user: z.string().max(128).optional().default('postgres'),
  admin_password: z.string().max(255).optional(),
  auth_method: z.enum(['password', 'secrets_manager']).optional().default('password'),
  admin_credential: z.string().max(1024).optional(),
  region: z.string().max(64).optional().default('default'),
  weight: z.number().int().min(0).max(1000).optional().default(100),
  max_databases: z.number().int().min(1).max(10000).optional().default(100),
})

export const updateInstanceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  admin_user: z.string().max(128).optional(),
  admin_password: z.string().max(255).optional(),
  auth_method: z.enum(['password', 'secrets_manager']).optional(),
  admin_credential: z.string().max(1024).optional(),
  region: z.string().max(64).optional(),
  status: z.enum(['active', 'maintenance', 'draining', 'offline']).optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  max_databases: z.number().int().min(1).max(10000).optional(),
})

export const listInstancesSchema = paginationSchema.extend({
  status: z.enum(['active', 'maintenance', 'draining', 'offline']).optional(),
  region: z.string().optional(),
})
