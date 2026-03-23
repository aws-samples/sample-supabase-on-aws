/**
 * Metrics collection and aggregation service
 */

import { findRdsInstances } from '../../db/repositories/rds-instance.repository.js'
import {
  insertMetricsSnapshot,
  queryClusterMetrics,
  queryPlatformMetrics,
  cleanupOldMetrics,
} from '../../db/repositories/cluster-metrics.repository.js'
import { findRdsInstanceByIdentifier } from '../../db/repositories/rds-instance.repository.js'
import { getEnv } from '../../config/index.js'
import type {
  AggregationInterval,
  PlatformMetricsResponse,
  ClusterMetricsResponse,
  PlatformSummary,
  PlatformStatusResponse,
  InstanceStatusInfo,
} from '../../types/cluster-metrics.js'

let collectionTimer: ReturnType<typeof setInterval> | null = null

/**
 * Collect a metrics snapshot for all active instances
 */
export async function collectMetricsSnapshot(): Promise<number> {
  const instances = await findRdsInstances({ status: 'active' })
  let collected = 0

  for (const instance of instances) {
    try {
      const utilization =
        instance.max_databases > 0
          ? (instance.current_databases / instance.max_databases) * 100
          : 0

      await insertMetricsSnapshot(instance.id, {
        max_databases: instance.max_databases,
        current_databases: instance.current_databases,
        utilization_percentage: parseFloat(utilization.toFixed(2)),
      })
      collected++
    } catch (error) {
      console.error(
        `Failed to collect metrics for instance ${instance.identifier}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  return collected
}

/**
 * Get platform-wide aggregated metrics
 */
export async function getPlatformMetrics(
  startTime: Date,
  endTime: Date,
  interval?: AggregationInterval
): Promise<PlatformMetricsResponse> {
  if (startTime >= endTime) {
    throw new Error('start_time must be before end_time')
  }

  const aggregationInterval = interval || determineInterval(startTime, endTime)
  const metrics = await queryPlatformMetrics(startTime, endTime, aggregationInterval)

  return {
    time_range: {
      start: startTime,
      end: endTime,
      interval: aggregationInterval,
    },
    metrics,
  }
}

/**
 * Get metrics for a single cluster
 */
export async function getClusterMetrics(
  identifier: string,
  startTime: Date,
  endTime: Date,
  interval?: AggregationInterval
): Promise<ClusterMetricsResponse> {
  if (startTime >= endTime) {
    throw new Error('start_time must be before end_time')
  }

  const instance = await findRdsInstanceByIdentifier(identifier)
  if (!instance) {
    throw new Error(`Cluster not found: ${identifier}`)
  }

  const aggregationInterval = interval || determineInterval(startTime, endTime)
  const metrics = await queryClusterMetrics(instance.id, startTime, endTime, aggregationInterval)

  return {
    cluster: {
      identifier: instance.identifier,
      name: instance.name,
    },
    time_range: {
      start: startTime,
      end: endTime,
      interval: aggregationInterval,
    },
    metrics,
  }
}

/**
 * Get current platform status (all clusters + summary)
 */
export async function getPlatformStatus(): Promise<PlatformStatusResponse> {
  const instances = await findRdsInstances({})

  const instanceStatuses: InstanceStatusInfo[] = instances.map((i) => ({
    id: i.id,
    identifier: i.identifier,
    name: i.name,
    host: i.host,
    port: i.port,
    region: i.region,
    status: i.status,
    weight: i.weight,
    max_databases: i.max_databases,
    current_databases: i.current_databases,
    utilization_percentage:
      i.max_databases > 0
        ? parseFloat(((i.current_databases / i.max_databases) * 100).toFixed(2))
        : 0,
  }))

  const activeInstances = instanceStatuses.filter((i) => i.status === 'active')
  const totalCapacity = activeInstances.reduce((sum, i) => sum + i.max_databases, 0)
  const totalAllocated = activeInstances.reduce((sum, i) => sum + i.current_databases, 0)

  let highest: PlatformSummary['highest_utilization'] = null
  let lowest: PlatformSummary['lowest_utilization'] = null

  if (activeInstances.length > 0) {
    const sorted = [...activeInstances].sort(
      (a, b) => a.utilization_percentage - b.utilization_percentage
    )
    lowest = {
      identifier: sorted[0]!.identifier,
      utilization: sorted[0]!.utilization_percentage,
    }
    highest = {
      identifier: sorted[sorted.length - 1]!.identifier,
      utilization: sorted[sorted.length - 1]!.utilization_percentage,
    }
  }

  const summary: PlatformSummary = {
    total_instances: instances.length,
    active_instances: activeInstances.length,
    total_capacity: totalCapacity,
    total_allocated: totalAllocated,
    utilization_percentage:
      totalCapacity > 0
        ? parseFloat(((totalAllocated / totalCapacity) * 100).toFixed(2))
        : 0,
    highest_utilization: highest,
    lowest_utilization: lowest,
  }

  return {
    instances: instanceStatuses,
    summary,
  }
}

/**
 * Start periodic metrics collection
 */
export function startPeriodicCollection(): void {
  if (collectionTimer) return

  const env = getEnv()
  const intervalMs = env.METRICS_COLLECTION_INTERVAL

  // Initial collection
  collectMetricsSnapshot().catch((err) =>
    console.error('Initial metrics collection failed:', err)
  )

  collectionTimer = setInterval(async () => {
    try {
      const count = await collectMetricsSnapshot()
      console.debug(`Metrics collected for ${count} instances`)

      // Periodic cleanup
      const deleted = await cleanupOldMetrics(env.METRICS_RETENTION_DAYS)
      if (deleted > 0) {
        console.debug(`Cleaned up ${deleted} old metrics records`)
      }
    } catch (error) {
      console.error('Periodic metrics collection failed:', error)
    }
  }, intervalMs)
}

/**
 * Stop periodic metrics collection
 */
export function stopPeriodicCollection(): void {
  if (collectionTimer) {
    clearInterval(collectionTimer)
    collectionTimer = null
  }
}

/**
 * Determine appropriate aggregation interval based on time range
 */
export function determineInterval(startTime: Date, endTime: Date): AggregationInterval {
  const durationMs = endTime.getTime() - startTime.getTime()
  const hours = durationMs / (1000 * 60 * 60)

  if (hours < 24) return '5m'
  if (hours < 24 * 7) return '1h'
  return '1d'
}
