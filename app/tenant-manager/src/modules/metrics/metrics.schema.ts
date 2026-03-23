/**
 * Zod validation schemas for metrics endpoints
 */

import { z } from 'zod'

export const metricsQuerySchema = z.object({
  start_time: z.string().transform((v) => new Date(v)),
  end_time: z.string().transform((v) => new Date(v)),
  interval: z.enum(['5m', '1h', '1d']).optional(),
})

export const clusterMetricsParamsSchema = z.object({
  identifier: z.string().min(1).max(64),
})
