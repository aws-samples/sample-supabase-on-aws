/**
 * Allocation Strategy Upsert Mutation
 * 
 * Creates or updates an allocation strategy
 * 
 * Requirements: 3.1, 7.1, 7.2
 */

import { useMutation, UseMutationOptions, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { post, handleError } from 'data/fetchers'
import type { ResponseError } from 'types'
import { allocationStrategyKeys } from './keys'
import type {
  AllocationStrategy,
  AllocationStrategyCreatePayload,
} from './allocation-strategy.types'

export type AllocationStrategyUpsertVariables = {
  projectRef: string
  payload: AllocationStrategyCreatePayload
}

export async function upsertAllocationStrategy({
  projectRef,
  payload,
}: AllocationStrategyUpsertVariables) {
  if (!projectRef) throw new Error('projectRef is required')

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await post('/platform/projects/{ref}/allocation-strategies', {
    params: { path: { ref: projectRef } },
    body: payload,
  })

  if (error) handleError(error)
  return data as AllocationStrategy
}

type AllocationStrategyUpsertData = Awaited<ReturnType<typeof upsertAllocationStrategy>>

export const useAllocationStrategyUpsertMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<
    AllocationStrategyUpsertData,
    ResponseError,
    AllocationStrategyUpsertVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<
    AllocationStrategyUpsertData,
    ResponseError,
    AllocationStrategyUpsertVariables
  >({
    mutationFn: upsertAllocationStrategy,
    async onSuccess(data, variables, context) {
      const { projectRef } = variables

      // Invalidate all allocation strategy queries
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: allocationStrategyKeys.list(projectRef),
        }),
        queryClient.invalidateQueries({
          queryKey: allocationStrategyKeys.strategy(projectRef, data.name),
        }),
        queryClient.invalidateQueries({
          queryKey: allocationStrategyKeys.active(projectRef),
        }),
      ])

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to save allocation strategy: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
