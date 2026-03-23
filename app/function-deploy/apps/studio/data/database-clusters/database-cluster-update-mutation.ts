/**
 * Database Cluster Update Mutation
 * 
 * Updates an existing database cluster
 * Validates: Requirements 2.3, 5.1, 5.2, 8.1, 8.2, 8.3
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { patch, handleError } from 'data/fetchers'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { databaseClusterKeys } from './keys'
import type { Cluster, ClusterUpdatePayload } from './database-cluster.types'
import { validateClusterUpdate } from './database-cluster-validation'

export type DatabaseClusterUpdateVariables = {
  payload: ClusterUpdatePayload
  currentCluster?: Cluster
}

export type DatabaseClusterUpdateResponse = Cluster

export async function updateDatabaseCluster({
  payload,
  currentCluster,
}: DatabaseClusterUpdateVariables): Promise<DatabaseClusterUpdateResponse> {
  // Validate payload before sending
  const validation = validateClusterUpdate(payload, currentCluster)
  if (!validation.valid) {
    const errorMessage = validation.errors.map((e) => `${e.field}: ${e.message}`).join(', ')
    throw new Error(`Validation failed: ${errorMessage}`)
  }

  const { identifier, ...updateData } = payload

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await patch('/api/admin/v1/update/{identifier}', {
    params: { path: { identifier } },
    body: updateData,
  })

  if (error) handleError(error)
  return data as DatabaseClusterUpdateResponse
}

export type DatabaseClusterUpdateData = Awaited<ReturnType<typeof updateDatabaseCluster>>
export type DatabaseClusterUpdateError = ResponseError

export const useDatabaseClusterUpdateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<
    DatabaseClusterUpdateData,
    DatabaseClusterUpdateError,
    DatabaseClusterUpdateVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<
    DatabaseClusterUpdateData,
    DatabaseClusterUpdateError,
    DatabaseClusterUpdateVariables
  >({
    mutationFn: (vars) => updateDatabaseCluster(vars),
    async onSuccess(data, variables, context) {
      const { payload } = variables

      // Invalidate both list and specific cluster queries
      await queryClient.invalidateQueries({
        queryKey: databaseClusterKeys.list(),
      })
      await queryClient.invalidateQueries({
        queryKey: databaseClusterKeys.cluster(payload.identifier),
      })

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to update database cluster: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
