/**
 * Metrics Aggregator Service
 * 
 * Aggregates historical metrics data for platform-wide and cluster-specific queries.
 * Supports time-based aggregation with configurable intervals.
 * 
 * Requirements: 18.6, 18.7, 18.8, 18.9
 */

import type { Pool, QueryResult } from 'pg'

export type AggregationInterval = '5m' | '1h' | '1d'

export interface PlatformMetricsDataPoint {
  timestamp: Date
  total_capacity: number
  total_utilization: number
  utilization_percentage: number
}

export interface ClusterMetricsDataPoint {
  timestamp: Date
  max_databases: number
  current_databases: number
  utilization_percentage: number
}

export interface MetricsTimeRange {
  start: Date
  end: Date
  interval: AggregationInterval
}

export interface PlatformMetricsResponse {
  time_range: MetricsTimeRange
  metrics: PlatformMetricsDataPoint[]
}

export interface ClusterMetricsResponse {
  cluster: {
    identifier: string
    name: string
  }
  time_range: MetricsTimeRange
  metrics: ClusterMetricsDataPoint[]
}

export class MetricsAggregator {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  /**
   * Aggregate platform-wide metrics over a time range
   * 
   * Sums capacity and utilization across all online clusters at each time bucket.
   * 
   * Requirements: 18.6, 18.8, 18.9
   */
  async aggregatePlatformMetrics(
    startTime: Date,
    endTime: Date,
    interval?: AggregationInterval
  ): Promise<PlatformMetricsResponse> {
    // Validate time range
    if (startTime >= endTime) {
      throw new Error('start_time must be before end_time')
    }

    // Determine interval if not provided
    const aggregationInterval = interval || this.determineInterval(startTime, endTime)

    const query = `
      WITH time_buckets AS (
        SELECT 
          date_trunc('${this.getDateTruncPrecision(aggregationInterval)}', cm.timestamp) AS bucket,
          SUM(cm.max_databases) AS total_capacity,
          SUM(cm.current_databases) AS total_utilization
        FROM _studio.cluster_metrics cm
        JOIN _studio.db_instances di ON cm.cluster_id = di.id
        WHERE cm.timestamp >= $1 
          AND cm.timestamp <= $2
          AND di.status = 'online'
        GROUP BY bucket
        ORDER BY bucket
      )
      SELECT 
        bucket AS timestamp,
        total_capacity,
        total_utilization,
        CASE 
          WHEN total_capacity > 0 
          THEN (total_utilization::float / total_capacity * 100)
          ELSE 0
        END AS utilization_percentage
      FROM time_buckets
    `

    try {
      const result: QueryResult = await this.pool.query(query, [startTime, endTime])

      return {
        time_range: {
          start: startTime,
          end: endTime,
          interval: aggregationInterval,
        },
        metrics: result.rows.map((row) => ({
          timestamp: new Date(row.timestamp),
          total_capacity: parseInt(row.total_capacity, 10),
          total_utilization: parseInt(row.total_utilization, 10),
          utilization_percentage: parseFloat(row.utilization_percentage),
        })),
      }
    } catch (error) {
      console.error('[MetricsAggregator] Failed to aggregate platform metrics:', error)
      throw error
    }
  }

  /**
   * Aggregate cluster-specific metrics over a time range
   * 
   * Returns metrics for a single cluster with time-based aggregation.
   * 
   * Requirements: 18.7, 18.8, 18.9
   */
  async aggregateClusterMetrics(
    clusterIdentifier: string,
    startTime: Date,
    endTime: Date,
    interval?: AggregationInterval
  ): Promise<ClusterMetricsResponse> {
    // Validate time range
    if (startTime >= endTime) {
      throw new Error('start_time must be before end_time')
    }

    // Get cluster info
    const clusterQuery = `
      SELECT id, identifier, name
      FROM _studio.db_instances
      WHERE identifier = $1
    `
    const clusterResult: QueryResult = await this.pool.query(clusterQuery, [clusterIdentifier])

    if (clusterResult.rows.length === 0) {
      throw new Error(`Cluster '${clusterIdentifier}' not found`)
    }

    const cluster = clusterResult.rows[0]

    // Determine interval if not provided
    const aggregationInterval = interval || this.determineInterval(startTime, endTime)

    const query = `
      SELECT 
        date_trunc('${this.getDateTruncPrecision(aggregationInterval)}', timestamp) AS timestamp,
        AVG(max_databases)::int AS max_databases,
        AVG(current_databases)::int AS current_databases,
        AVG(utilization_percentage) AS utilization_percentage
      FROM _studio.cluster_metrics
      WHERE cluster_id = $1
        AND timestamp >= $2 
        AND timestamp <= $3
      GROUP BY date_trunc('${this.getDateTruncPrecision(aggregationInterval)}', timestamp)
      ORDER BY timestamp
    `

    try {
      const result: QueryResult = await this.pool.query(query, [
        cluster.id,
        startTime,
        endTime,
      ])

      return {
        cluster: {
          identifier: cluster.identifier,
          name: cluster.name,
        },
        time_range: {
          start: startTime,
          end: endTime,
          interval: aggregationInterval,
        },
        metrics: result.rows.map((row) => ({
          timestamp: new Date(row.timestamp),
          max_databases: parseInt(row.max_databases, 10),
          current_databases: parseInt(row.current_databases, 10),
          utilization_percentage: parseFloat(row.utilization_percentage),
        })),
      }
    } catch (error) {
      console.error('[MetricsAggregator] Failed to aggregate cluster metrics:', error)
      throw error
    }
  }

  /**
   * Determine appropriate aggregation interval based on time range
   * 
   * Rules:
   * - < 24 hours: 5 minute intervals
   * - < 7 days: 1 hour intervals
   * - >= 7 days: 1 day intervals
   * 
   * Requirements: 18.8, 18.9
   */
  private determineInterval(startTime: Date, endTime: Date): AggregationInterval {
    const durationMs = endTime.getTime() - startTime.getTime()
    const hours = durationMs / (1000 * 60 * 60)

    if (hours < 24) {
      return '5m'
    } else if (hours < 24 * 7) {
      return '1h'
    } else {
      return '1d'
    }
  }

  /**
   * Get PostgreSQL interval string for aggregation
   */
  private getIntervalString(interval: AggregationInterval): string {
    const intervalMap: Record<AggregationInterval, string> = {
      '5m': '5 minutes',
      '1h': '1 hour',
      '1d': '1 day',
    }
    return intervalMap[interval]
  }

  /**
   * Get PostgreSQL date_trunc precision for aggregation
   */
  private getDateTruncPrecision(interval: AggregationInterval): string {
    const precisionMap: Record<AggregationInterval, string> = {
      '5m': 'minute', // Will be rounded to 5-minute buckets in application
      '1h': 'hour',
      '1d': 'day',
    }
    return precisionMap[interval]
  }
}
