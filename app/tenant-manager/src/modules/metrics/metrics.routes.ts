/**
 * Metrics query routes
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateQuery, validateParams } from '../../common/validation/middleware.js'
import { metricsQuerySchema, clusterMetricsParamsSchema } from './metrics.schema.js'
import {
  getPlatformMetrics,
  getClusterMetrics,
  getPlatformStatus,
  collectMetricsSnapshot,
} from './metrics.service.js'
import { BadRequestError, NotFoundError } from '../../common/errors/index.js'

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // Platform-wide aggregated metrics (time-series)
  fastify.get(
    '/admin/v1/rds-metrics/platform',
    {
      preHandler: [authPreHandler, validateQuery(metricsQuerySchema)],
    },
    async (request, _reply) => {
      const query = request.query as z.infer<typeof metricsQuerySchema>

      try {
        const metrics = await getPlatformMetrics(query.start_time, query.end_time, query.interval)
        return { data: metrics }
      } catch (error) {
        if (error instanceof Error && error.message.includes('must be before')) {
          throw new BadRequestError(error.message)
        }
        throw error
      }
    }
  )

  // Single cluster metrics (time-series)
  fastify.get(
    '/admin/v1/rds-metrics/clusters/:identifier',
    {
      preHandler: [authPreHandler, validateParams(clusterMetricsParamsSchema), validateQuery(metricsQuerySchema)],
    },
    async (request, _reply) => {
      const { identifier } = request.params as z.infer<typeof clusterMetricsParamsSchema>
      const query = request.query as z.infer<typeof metricsQuerySchema>

      try {
        const metrics = await getClusterMetrics(identifier, query.start_time, query.end_time, query.interval)
        return { data: metrics }
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            throw new NotFoundError(error.message)
          }
          if (error.message.includes('must be before')) {
            throw new BadRequestError(error.message)
          }
        }
        throw error
      }
    }
  )

  // Platform status (current snapshot with summary)
  fastify.get(
    '/admin/v1/rds-instances/platform-status',
    {
      preHandler: [authPreHandler],
    },
    async (_request, _reply) => {
      const status = await getPlatformStatus()
      return { data: status }
    }
  )

  // Manual metrics collection trigger
  fastify.post(
    '/admin/v1/rds-metrics/collect',
    {
      preHandler: [authPreHandler],
    },
    async (_request, _reply) => {
      const count = await collectMetricsSnapshot()
      return {
        data: {
          collected: count,
          timestamp: new Date().toISOString(),
        },
      }
    }
  )
}
