/**
 * Allocation Strategies Query Hooks
 * 
 * React Query hooks for fetching and managing allocation strategies
 */

import { useQuery, useMutation, useQueryClient, UseQueryOptions } from '@tanstack/react-query'
import type { AllocationStrategy } from 'components/interfaces/Organization/ClusterManagement/AllocationStrategyCard'

export const allocationStrategiesKeys = {
  list: () => ['allocation-strategies'] as const,
}

interface AllocationStrategiesResponse {
  strategies: AllocationStrategy[]
  active_strategy: AllocationStrategy | null
}

/**
 * Fetch all allocation strategies
 */
export async function getAllocationStrategies(): Promise<AllocationStrategiesResponse> {
  const response = await fetch('/admin/v1/strategy', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error('Failed to fetch allocation strategies')
  }

  return response.json()
}

/**
 * Hook to fetch allocation strategies
 */
export function useAllocationStrategiesQuery<TData = AllocationStrategiesResponse>(
  options?: UseQueryOptions<AllocationStrategiesResponse, Error, TData>
) {
  return useQuery<AllocationStrategiesResponse, Error, TData>({
    queryKey: allocationStrategiesKeys.list(),
    queryFn: getAllocationStrategies,
    ...options,
  })
}

interface UpdateStrategyParams {
  name: string
  strategy_type?: string
  updates: {
    description?: string | null
    config?: Record<string, any> | null
    is_active?: boolean
  }
}

/**
 * Update an allocation strategy
 */
export async function updateAllocationStrategy({
  name,
  strategy_type,
  updates,
}: UpdateStrategyParams): Promise<AllocationStrategy> {
  // Fetch current strategy to get strategy_type if not provided
  let currentStrategyType = strategy_type
  if (!currentStrategyType) {
    const strategiesResponse = await getAllocationStrategies()
    const currentStrategy = strategiesResponse.strategies.find(s => s.name === name)
    if (!currentStrategy) {
      throw new Error(`Strategy '${name}' not found`)
    }
    currentStrategyType = currentStrategy.strategy_type
  }

  const response = await fetch('/admin/v1/strategy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      name,
      strategy_type: currentStrategyType,
      ...updates,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to update strategy')
  }

  return response.json()
}

/**
 * Hook to update allocation strategy
 */
export function useUpdateAllocationStrategyMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: updateAllocationStrategy,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: allocationStrategiesKeys.list(),
      })
    },
  })
}

/**
 * Activate a specific strategy (deactivates others)
 */
export async function activateAllocationStrategy(name: string): Promise<AllocationStrategy> {
  return updateAllocationStrategy({
    name,
    updates: { is_active: true },
  })
}

/**
 * Hook to activate allocation strategy
 */
export function useActivateAllocationStrategyMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: activateAllocationStrategy,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: allocationStrategiesKeys.list(),
      })
    },
  })
}

/**
 * Delete an allocation strategy
 */
export async function deleteAllocationStrategy(name: string): Promise<void> {
  const response = await fetch('/admin/v1/strategy', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'Failed to delete strategy')
  }
}

/**
 * Hook to delete allocation strategy
 */
export function useDeleteAllocationStrategyMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteAllocationStrategy,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: allocationStrategiesKeys.list(),
      })
    },
  })
}
