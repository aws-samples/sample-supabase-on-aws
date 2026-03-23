/**
 * Health check routes
 */

import type { FastifyInstance } from 'fastify'
import { checkManagementDbHealth } from '../../db/connection.js'
import { checkSupavisorHealth } from '../../integrations/supavisor/supavisor.client.js'
import { checkRealtimeHealth } from '../../integrations/realtime/realtime.client.js'

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  version: string
  services: {
    database: { status: string; latency_ms?: number }
    supavisor: { status: string }
    realtime: { status: string }
  }
}

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  // Basic health check
  fastify.get('/health', async (_request, _reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Detailed health check
  fastify.get('/health/detailed', async (_request, reply) => {

    // Check database (direct connection)
    let databaseStatus = 'unhealthy'
    let databaseLatency: number | undefined

    try {
      const dbHealth = await checkManagementDbHealth()
      databaseStatus = dbHealth.healthy ? 'healthy' : 'unhealthy'
      databaseLatency = dbHealth.latencyMs
    } catch {
      databaseStatus = 'unhealthy'
    }

    // Check Supavisor
    const supavisorResult = await checkSupavisorHealth()
    const supavisorStatus = supavisorResult.healthy ? 'healthy' : 'unhealthy'

    // Check Realtime
    const realtimeResult = await checkRealtimeHealth()
    const realtimeStatus = realtimeResult.healthy ? 'healthy' : 'unhealthy'

    // Determine overall status
    const allHealthy =
      databaseStatus === 'healthy' &&
      supavisorStatus === 'healthy' &&
      realtimeStatus === 'healthy'

    const anyHealthy =
      databaseStatus === 'healthy' ||
      supavisorStatus === 'healthy' ||
      realtimeStatus === 'healthy'

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy'
    if (allHealthy) {
      overallStatus = 'healthy'
    } else if (anyHealthy) {
      overallStatus = 'degraded'
    } else {
      overallStatus = 'unhealthy'
    }

    const response: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env['npm_package_version'] || '0.1.0',
      services: {
        database: {
          status: databaseStatus,
          ...(databaseLatency !== undefined && { latency_ms: databaseLatency }),
        },
        supavisor: { status: supavisorStatus },
        realtime: { status: realtimeStatus },
      },
    }

    const statusCode = overallStatus === 'unhealthy' ? 503 : 200
    return reply.status(statusCode).send(response)
  })

  // Liveness probe (for Kubernetes)
  fastify.get('/health/live', async (_request, _reply) => {
    return { status: 'ok' }
  })

  // Readiness probe (for Kubernetes)
  fastify.get('/health/ready', async (_request, reply) => {
    try {
      const dbHealth = await checkManagementDbHealth()

      if (!dbHealth.healthy) {
        return reply.status(503).send({ status: 'not ready', reason: 'Database unavailable' })
      }

      return { status: 'ready' }
    } catch {
      return reply.status(503).send({ status: 'not ready', reason: 'Database connection failed' })
    }
  })
}
