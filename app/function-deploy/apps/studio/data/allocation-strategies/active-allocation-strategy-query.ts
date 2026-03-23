/**
 * Active Allocation Strategy Query
 * 
 * Fetches the currently active allocation strategy
 * 
 * Requirements: 7.5
 */

import { useQuery, QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { get, handleError } from 'data/fetchers'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { allocationStrategyKeys } from './keys'
import type { AllocationStrategy } from './allocation-strategy.types'

export type ActiveAllocationStrategyVariables = {
  projectRef?: string
}

export type ActiveAllocationStrategyResponse = AllocationStrategy | null

export async function getActiveAllocationStrategy(
  { projectRef }: ActiveAllocationStrategyVariables,
  signal?: AbortSignal
): Promise<ActiveAllocationStrategyResponse> {
  if (!projectRef) throw new Error('projectRef is required')

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await get('/platform/projects/{ref}/allocation-strategies/active', {
    params: { path: { ref: projectRef } },
    signal,
  })

  if (error) handleError(error)
  return data as ActiveAllocationStrategyResponse
}

export type ActiveAllocationStrategyData = Awaited<ReturnType<typeof getActiveAllocationStrategy>>
export type ActiveAllocationStrategyError = ResponseError

export const useActiveAllocationStrategyQuery = <TData = ActiveAllocationStrategyData>(
  { projectRef }: ActiveAllocationStrategyVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<ActiveAllocationStrategyData, ActiveAllocationStrategyError, TData> = {}
) =>
  useQuery<ActiveAllocationStrategyData, ActiveAllocationStrategyError, TData>({
    queryKey: allocationStrategyKeys.active(projectRef),
    queryFn: ({ signal }) => getActiveAllocationStrategy({ projectRef }, signal),
    enabled: enabled && typeof projectRef !== 'undefined',
    ...options,
  })

/**
 * Prefetch active allocation strategy
 */
export const useActiveAllocationStrategyPrefetch = ({
  projectRef,
}: ActiveAllocationStrategyVariables) => {
  const client = new QueryClient()

  return useCallback(() => {
    if (projectRef) {
      client.prefetchQuery({
        queryKey: allocationStrategyKeys.active(projectRef),
        queryFn: ({ signal }) => getActiveAllocationStrategy({ projectRef }, signal),
      })
    }
  }, [projectRef, client])
}

/**
 * Invalidate active allocation strategy query
 */
export function invalidateActiveAllocationStrategyQuery(
  client: QueryClient,
  projectRef: string | undefined
) {
  return client.invalidateQueries({
    queryKey: allocationStrategyKeys.active(projectRef),
  })
}
