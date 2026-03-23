/**
 * Database Cluster Query
 * 
 * Fetches a single database cluster by identifier
 */

import { useQuery, QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { get, handleError } from 'data/fetchers'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { databaseClusterKeys } from './keys'
import type { Cluster } from './database-cluster.types'

export type DatabaseClusterVariables = {
  identifier?: string
}

export type DatabaseClusterResponse = Cluster

export async function getDatabaseCluster(
  { identifier }: DatabaseClusterVariables,
  signal?: AbortSignal
): Promise<DatabaseClusterResponse> {
  if (!identifier) throw new Error('identifier is required')

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await get('/api/admin/v1/cluster/{identifier}', {
    params: { path: { identifier } },
    signal,
  })

  if (error) handleError(error)
  return data as DatabaseClusterResponse
}

export type DatabaseClusterData = Awaited<ReturnType<typeof getDatabaseCluster>>
export type DatabaseClusterError = ResponseError

export const useDatabaseClusterQuery = <TData = DatabaseClusterData>(
  { identifier }: DatabaseClusterVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<DatabaseClusterData, DatabaseClusterError, TData> = {}
) =>
  useQuery<DatabaseClusterData, DatabaseClusterError, TData>({
    queryKey: databaseClusterKeys.cluster(identifier),
    queryFn: ({ signal }) => getDatabaseCluster({ identifier }, signal),
    enabled: enabled && typeof identifier !== 'undefined',
    ...options,
  })

/**
 * Prefetch database cluster
 */
export const useDatabaseClusterPrefetch = ({
  identifier,
}: DatabaseClusterVariables) => {
  const client = new QueryClient()

  return useCallback(() => {
    if (identifier) {
      client.prefetchQuery({
        queryKey: databaseClusterKeys.cluster(identifier),
        queryFn: ({ signal }) => getDatabaseCluster({ identifier }, signal),
      })
    }
  }, [identifier, client])
}

/**
 * Invalidate database cluster query
 */
export function invalidateDatabaseClusterQuery(
  client: QueryClient,
  identifier: string | undefined
) {
  return client.invalidateQueries({
    queryKey: databaseClusterKeys.cluster(identifier),
  })
}
