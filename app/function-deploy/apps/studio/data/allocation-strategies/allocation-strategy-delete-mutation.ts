/**
 * Allocation Strategy Delete Mutation
 * 
 * Deletes an allocation strategy
 * 
 * Requirements: 7.1, 7.2
 */

import { useMutation, UseMutationOptions, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { del, handleError } from 'data/fetchers'
import type { ResponseError } from 'types'
import { allocationStrategyKeys } from './keys'

export type AllocationStrategyDeleteVariables = {
  projectRef: string
  name: string
}

export async function deleteAllocationStrategy({
  projectRef,
  name,
}: AllocationStrategyDeleteVariables) {
  if (!projectRef) throw new Error('projectRef is required')
  if (!name) throw new Error('name is required')

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await del('/platform/projects/{ref}/allocation-strategies/{name}', {
    params: { path: { ref: projectRef, name } },
  })

  if (error) handleError(error)
  return data
}

type AllocationStrategyDeleteData = Awaited<ReturnType<typeof deleteAllocationStrategy>>

export const useAllocationStrategyDeleteMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<
    AllocationStrategyDeleteData,
    ResponseError,
    AllocationStrategyDeleteVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<
    AllocationStrategyDeleteData,
    ResponseError,
    AllocationStrategyDeleteVariables
  >({
    mutationFn: deleteAllocationStrategy,
    async onSuccess(data, variables, context) {
      const { projectRef, name } = variables

      // Invalidate all allocation strategy queries
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: allocationStrategyKeys.list(projectRef),
        }),
        queryClient.invalidateQueries({
          queryKey: allocationStrategyKeys.strategy(projectRef, name),
        }),
        queryClient.invalidateQueries({
          queryKey: allocationStrategyKeys.active(projectRef),
        }),
      ])

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to delete allocation strategy: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
