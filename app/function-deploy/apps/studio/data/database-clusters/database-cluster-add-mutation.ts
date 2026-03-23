/**
 * Database Cluster Add Mutation
 * 
 * Mutation hook for registering a new database cluster
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ResponseError, UseCustomMutationOptions } from 'types'
import { databaseClusterKeys } from './keys'

export type DatabaseClusterAddVariables = {
  identifier: string
  name: string
  host: string
  port?: number
  admin_user?: string
  auth_method?: 'password' | 'secrets_manager'
  credential: string
  region?: string
  weight?: number
  max_databases?: number
  is_management_instance?: boolean
}

export async function addDatabaseCluster(
  clusterData: DatabaseClusterAddVariables
) {
  // Use fetch directly to call the admin API
  const response = await fetch(`/admin/v1/add`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(clusterData),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error?.error?.message || 'Failed to add cluster')
  }

  return await response.json()
}

type DatabaseClusterAddData = Awaited<ReturnType<typeof addDatabaseCluster>>

export const useDatabaseClusterAddMutation = ({
  onError,
  onSuccess,
  ...options
}: Omit<
  UseCustomMutationOptions<DatabaseClusterAddData, ResponseError, DatabaseClusterAddVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<DatabaseClusterAddData, ResponseError, DatabaseClusterAddVariables>({
    mutationFn: (vars) => addDatabaseCluster(vars),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.metrics() })
      await queryClient.invalidateQueries({ queryKey: databaseClusterKeys.list() })
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to add cluster: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
