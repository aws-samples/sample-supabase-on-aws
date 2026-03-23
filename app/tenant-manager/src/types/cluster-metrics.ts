/**
 * Cluster metrics types for time-series monitoring
 */

// Aggregation interval for metrics queries
export type AggregationInterval = '5m' | '1h' | '1d'

// Raw cluster metrics record from DB
export interface ClusterMetricsRecord {
  id: number
  cluster_id: number
  timestamp: Date
  max_databases: number
  current_databases: number
  utilization_percentage: number
  created_at: Date
}

// Aggregated metrics data point for a single cluster
export interface ClusterMetricsDataPoint {
  timestamp: Date
  max_databases: number
  current_databases: number
  utilization_percentage: number
}

// Platform-wide aggregated metrics data point
export interface PlatformMetricsDataPoint {
  timestamp: Date
  total_capacity: number
  total_utilization: number
  utilization_percentage: number
}

// Time range for metrics queries
export interface MetricsTimeRange {
  start: Date
  end: Date
  interval: AggregationInterval
}

// Platform metrics response
export interface PlatformMetricsResponse {
  time_range: MetricsTimeRange
  metrics: PlatformMetricsDataPoint[]
}

// Cluster-specific metrics response
export interface ClusterMetricsResponse {
  cluster: {
    identifier: string
    name: string
  }
  time_range: MetricsTimeRange
  metrics: ClusterMetricsDataPoint[]
}

// Platform summary (current snapshot)
export interface PlatformSummary {
  total_instances: number
  active_instances: number
  total_capacity: number
  total_allocated: number
  utilization_percentage: number
  highest_utilization: { identifier: string; utilization: number } | null
  lowest_utilization: { identifier: string; utilization: number } | null
}

// Instance status with utilization info
export interface InstanceStatusInfo {
  id: number
  identifier: string
  name: string
  host: string
  port: number
  region: string
  status: string
  weight: number
  max_databases: number
  current_databases: number
  utilization_percentage: number
}

// Platform status response
export interface PlatformStatusResponse {
  instances: InstanceStatusInfo[]
  summary: PlatformSummary
}
