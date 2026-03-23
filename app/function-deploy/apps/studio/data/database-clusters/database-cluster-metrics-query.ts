/**
 * Database Cluster Metrics Query
 * 
 * Fetches cluster metrics and platform-wide statistics
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3
 */

import { useQuery, QueryClient } from '@tanstack/react-query'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { databaseClusterKeys } from './keys'
import type { Cluster } from './database-cluster.types'

export type DatabaseClusterMetricsVariables = {
  region?: string
  status?: string
}

export type PlatformMetrics = {
  total_clusters: number
  online_clusters: number
  offline_clusters: number
  total_capacity: number
  total_allocated: number
  platform_utilization_percentage: number
  max_utilized_cluster: {
    identifier: string
    name: string
    utilization_percentage: number
  } | null
  min_utilized_cluster: {
    identifier: string
    name: string
    utilization_percentage: number
  } | null
}

export type DatabaseClusterMetricsResponse = {
  clusters: Array<Cluster & { utilization_percentage: number }>
  summary: PlatformMetrics
}

export async function getDatabaseClusterMetrics(
  { region, status }: DatabaseClusterMetricsVariables = {},
  signal?: AbortSignal
): Promise<DatabaseClusterMetricsResponse> {
  const queryParams = new URLSearchParams()
  if (region) queryParams.append('region', region)
  if (status) queryParams.append('status', status)

  const queryString = queryParams.toString()
  // Use relative URL - Kong will inject authentication headers automatically
  const url = `/admin/v1/status${queryString ? `?${queryString}` : ''}`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error?.error?.message || 'Failed to fetch cluster metrics')
  }

  return await response.json()
}

export type DatabaseClusterMetricsData = Awaited<ReturnType<typeof getDatabaseClusterMetrics>>
export type DatabaseClusterMetricsError = ResponseError

export const useDatabaseClusterMetricsQuery = <TData = DatabaseClusterMetricsData>(
  variables: DatabaseClusterMetricsVariables = {},
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<DatabaseClusterMetricsData, DatabaseClusterMetricsError, TData> = {}
) =>
  useQuery<DatabaseClusterMetricsData, DatabaseClusterMetricsError, TData>({
    queryKey: databaseClusterKeys.metrics(),
    queryFn: ({ signal }) => getDatabaseClusterMetrics(variables, signal),
    enabled,
    ...options,
  })

/**
 * Invalidate database cluster metrics query
 */
export function invalidateDatabaseClusterMetricsQuery(
  client: QueryClient
) {
  return client.invalidateQueries({ queryKey: databaseClusterKeys.metrics() })
}
