/**
 * Allocation Strategy Query
 * 
 * Fetches a single allocation strategy by name
 * 
 * Requirements: 3.1, 7.1, 7.2
 */

import { useQuery, QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { get, handleError } from 'data/fetchers'
import type { ResponseError, UseCustomQueryOptions } from 'types'
import { allocationStrategyKeys } from './keys'
import type { AllocationStrategy } from './allocation-strategy.types'

export type AllocationStrategyVariables = {
  projectRef?: string
  name?: string
}

export type AllocationStrategyResponse = AllocationStrategy

export async function getAllocationStrategy(
  { projectRef, name }: AllocationStrategyVariables,
  signal?: AbortSignal
): Promise<AllocationStrategyResponse> {
  if (!projectRef) throw new Error('projectRef is required')
  if (!name) throw new Error('name is required')

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await get('/platform/projects/{ref}/allocation-strategies/{name}', {
    params: { path: { ref: projectRef, name } },
    signal,
  })

  if (error) handleError(error)
  return data as AllocationStrategyResponse
}

export type AllocationStrategyData = Awaited<ReturnType<typeof getAllocationStrategy>>
export type AllocationStrategyError = ResponseError

export const useAllocationStrategyQuery = <TData = AllocationStrategyData>(
  { projectRef, name }: AllocationStrategyVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<AllocationStrategyData, AllocationStrategyError, TData> = {}
) =>
  useQuery<AllocationStrategyData, AllocationStrategyError, TData>({
    queryKey: allocationStrategyKeys.strategy(projectRef, name),
    queryFn: ({ signal }) => getAllocationStrategy({ projectRef, name }, signal),
    enabled: enabled && typeof projectRef !== 'undefined' && typeof name !== 'undefined',
    ...options,
  })

/**
 * Prefetch allocation strategy
 */
export const useAllocationStrategyPrefetch = ({ projectRef, name }: AllocationStrategyVariables) => {
  const client = new QueryClient()

  return useCallback(() => {
    if (projectRef && name) {
      client.prefetchQuery({
        queryKey: allocationStrategyKeys.strategy(projectRef, name),
        queryFn: ({ signal }) => getAllocationStrategy({ projectRef, name }, signal),
      })
    }
  }, [projectRef, name, client])
}

/**
 * Invalidate allocation strategy query
 */
export function invalidateAllocationStrategyQuery(
  client: QueryClient,
  projectRef: string | undefined,
  name: string | undefined
) {
  return client.invalidateQueries({
    queryKey: allocationStrategyKeys.strategy(projectRef, name),
  })
}
