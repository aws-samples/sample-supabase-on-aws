/**
 * Database Clusters Query
 * 
 * Fetches all database clusters for the platform
 */

import { useQuery, QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { databaseClusterKeys } from './keys'
import type { Cluster } from './database-cluster.types'

export type DatabaseClustersResponse = Cluster[]

export async function getDatabaseClusters(
  signal?: AbortSignal
): Promise<DatabaseClustersResponse> {
  // Use fetch directly to call the admin API
  const response = await fetch(`/admin/v1/status`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error?.error?.message || 'Failed to fetch clusters')
  }

  const data = await response.json()
  
  // The /admin/v1/status endpoint returns { clusters: [], summary: {} }
  // We only need the clusters array
  return data?.clusters || []
}

export type DatabaseClustersData = Awaited<ReturnType<typeof getDatabaseClusters>>
export type DatabaseClustersError = ResponseError

export const useDatabaseClustersQuery = <TData = DatabaseClustersData>(
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<DatabaseClustersData, DatabaseClustersError, TData> = {}
) =>
  useQuery<DatabaseClustersData, DatabaseClustersError, TData>({
    queryKey: databaseClusterKeys.list(),
    queryFn: ({ signal }) => getDatabaseClusters(signal),
    enabled,
    ...options,
  })

/**
 * Prefetch database clusters
 */
export const useDatabaseClustersPrefetch = () => {
  const client = new QueryClient()

  return useCallback(() => {
    client.prefetchQuery({
      queryKey: databaseClusterKeys.list(),
      queryFn: ({ signal }) => getDatabaseClusters(signal),
    })
  }, [client])
}

/**
 * Invalidate database clusters query
 */
export function invalidateDatabaseClustersQuery(
  client: QueryClient
) {
  return client.invalidateQueries({ queryKey: databaseClusterKeys.list() })
}
