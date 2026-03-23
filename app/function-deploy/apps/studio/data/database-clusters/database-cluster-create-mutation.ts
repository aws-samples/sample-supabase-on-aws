/**
 * Database Cluster Create Mutation
 * 
 * Creates a new database cluster
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { post, handleError } from 'data/fetchers'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { databaseClusterKeys } from './keys'
import type { Cluster, ClusterCreatePayload } from './database-cluster.types'
import { validateClusterCreate } from './database-cluster-validation'

export type DatabaseClusterCreateVariables = {
  payload: ClusterCreatePayload
}

export type DatabaseClusterCreateResponse = Cluster

export async function createDatabaseCluster({
  payload,
}: DatabaseClusterCreateVariables): Promise<DatabaseClusterCreateResponse> {
  // Validate payload before sending
  const validation = validateClusterCreate(payload)
  if (!validation.valid) {
    const errorMessage = validation.errors.map((e) => `${e.field}: ${e.message}`).join(', ')
    throw new Error(`Validation failed: ${errorMessage}`)
  }

  // @ts-ignore API endpoint will be implemented in backend
  const { data, error } = await post('/api/admin/v1/add', {
    body: payload,
  })

  if (error) handleError(error)
  return data as DatabaseClusterCreateResponse
}

export type DatabaseClusterCreateData = Awaited<ReturnType<typeof createDatabaseCluster>>
export type DatabaseClusterCreateError = ResponseError

export const useDatabaseClusterCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<
    DatabaseClusterCreateData,
    DatabaseClusterCreateError,
    DatabaseClusterCreateVariables
  >,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<
    DatabaseClusterCreateData,
    DatabaseClusterCreateError,
    DatabaseClusterCreateVariables
  >({
    mutationFn: (vars) => createDatabaseCluster(vars),
    async onSuccess(data, variables, context) {
      // Invalidate clusters list
      await queryClient.invalidateQueries({
        queryKey: databaseClusterKeys.list(),
      })

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to create database cluster: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
