/**
 * Zod validation schemas for allocation strategy endpoints
 */

import { z } from 'zod'

const strategyTypes = [
  'manual', 'hash', 'round_robin', 'weighted_round_robin', 'least_connections', 'region_affinity',
] as const

export const createStrategySchema = z.object({
  name: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  strategy_type: z.enum(strategyTypes),
  description: z.string().max(1000).optional(),
  config: z.record(z.unknown()).optional(),
  is_active: z.boolean().optional().default(false),
})

export const updateStrategySchema = z.object({
  strategy_type: z.enum(strategyTypes).optional(),
  description: z.string().max(1000).optional(),
  config: z.record(z.unknown()).optional(),
  is_active: z.boolean().optional(),
})

export const strategyNameSchema = z.object({
  name: z.string().min(1).max(255),
})
