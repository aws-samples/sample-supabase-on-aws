/**
 * Database Cluster Delete Mutation
 * 
 * Mutation hook for deleting a database cluster
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { databaseClusterKeys } from './keys'

export type DatabaseClusterDeleteVariables = {
  identifier: string
  delete_secret?: boolean
}

export async function deleteDatabaseCluster({
  identifier,
  delete_secret = false,
}: DatabaseClusterDeleteVariables) {
  const response = await fetch(`/admin/v1/delete`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ identifier, delete_secret }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error?.error?.message || 'Failed to delete cluster')
  }

  return await response.json()
}

type DatabaseClusterDeleteData = Awaited<ReturnType<typeof deleteDatabaseCluster>>

export const useDatabaseClusterDeleteMutation = ({
  onError,
  onSuccess,
  ...options
}: Omit<
  UseCustomMutationOptions<DatabaseClusterDeleteData, ResponseError, DatabaseClusterDeleteVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<DatabaseClusterDeleteData, ResponseError, DatabaseClusterDeleteVariables>({
    mutationFn: (vars) => deleteDatabaseCluster(vars),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.metrics() })
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.list() })
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to delete cluster: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
