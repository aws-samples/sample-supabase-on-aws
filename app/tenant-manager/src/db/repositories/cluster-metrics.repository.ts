/**
 * Cluster metrics repository - time-series data for cluster monitoring
 */

import { sql } from 'kysely'
import { getManagementDb } from '../connection.js'
import type { AggregationInterval, ClusterMetricsDataPoint, PlatformMetricsDataPoint } from '../../types/cluster-metrics.js'

/**
 * Insert a metrics snapshot for a cluster
 */
export async function insertMetricsSnapshot(
  clusterId: number,
  data: { max_databases: number; current_databases: number; utilization_percentage: number }
): Promise<void> {
  const db = getManagementDb()
  await db
    .insertInto('_tenant.cluster_metrics')
    .values({
      cluster_id: clusterId,
      timestamp: new Date(),
      max_databases: data.max_databases,
      current_databases: data.current_databases,
      utilization_percentage: data.utilization_percentage,
    })
    .execute()
}

/**
 * Query aggregated metrics for a single cluster
 */
export async function queryClusterMetrics(
  clusterId: number,
  startTime: Date,
  endTime: Date,
  interval: AggregationInterval
): Promise<ClusterMetricsDataPoint[]> {
  const db = getManagementDb()
  const precision = getDateTruncPrecision(interval)

  const result = await sql<ClusterMetricsDataPoint>`
    SELECT
      date_trunc(${precision}, timestamp) AS timestamp,
      AVG(max_databases)::int AS max_databases,
      AVG(current_databases)::int AS current_databases,
      AVG(utilization_percentage)::numeric(5,2) AS utilization_percentage
    FROM _tenant.cluster_metrics
    WHERE cluster_id = ${clusterId}
      AND timestamp >= ${startTime}
      AND timestamp <= ${endTime}
    GROUP BY date_trunc(${precision}, timestamp)
    ORDER BY timestamp
  `.execute(db)

  return result.rows.map((row) => ({
    timestamp: new Date(row.timestamp),
    max_databases: Number(row.max_databases),
    current_databases: Number(row.current_databases),
    utilization_percentage: Number(row.utilization_percentage),
  }))
}

/**
 * Query platform-wide aggregated metrics
 */
export async function queryPlatformMetrics(
  startTime: Date,
  endTime: Date,
  interval: AggregationInterval
): Promise<PlatformMetricsDataPoint[]> {
  const db = getManagementDb()
  const precision = getDateTruncPrecision(interval)

  const result = await sql<PlatformMetricsDataPoint>`
    WITH time_buckets AS (
      SELECT
        date_trunc(${precision}, cm.timestamp) AS bucket,
        SUM(cm.max_databases) AS total_capacity,
        SUM(cm.current_databases) AS total_utilization
      FROM _tenant.cluster_metrics cm
      JOIN _tenant.db_instances di ON cm.cluster_id = di.id
      WHERE cm.timestamp >= ${startTime}
        AND cm.timestamp <= ${endTime}
        AND di.status = 'active'
      GROUP BY bucket
      ORDER BY bucket
    )
    SELECT
      bucket AS timestamp,
      total_capacity,
      total_utilization,
      CASE
        WHEN total_capacity > 0
        THEN (total_utilization::float / total_capacity * 100)::numeric(5,2)
        ELSE 0
      END AS utilization_percentage
    FROM time_buckets
  `.execute(db)

  return result.rows.map((row) => ({
    timestamp: new Date(row.timestamp),
    total_capacity: Number(row.total_capacity),
    total_utilization: Number(row.total_utilization),
    utilization_percentage: Number(row.utilization_percentage),
  }))
}

/**
 * Cleanup old metrics records
 */
export async function cleanupOldMetrics(retentionDays: number = 30): Promise<number> {
  const db = getManagementDb()
  const result = await sql<{ deleted_count: number }>`
    SELECT * FROM _tenant.cleanup_old_metrics(${retentionDays})
  `.execute(db)

  return Number(result.rows[0]?.deleted_count ?? 0)
}

function getDateTruncPrecision(interval: AggregationInterval): string {
  const precisionMap: Record<AggregationInterval, string> = {
    '5m': 'minute',
    '1h': 'hour',
    '1d': 'day',
  }
  return precisionMap[interval]
}
